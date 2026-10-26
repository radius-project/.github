import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backportEntry,
  entriesForMergedPull,
  findIncludedSourceCommits,
  orderByMainHistory,
  selectNextBackport,
  selectReleaseBackports
} from "./select-release-backports.mjs";

const source = (number) => ({
  number,
  merge_commit_sha: String(number).padStart(40, "a"),
  title: `fix: source ${number}`,
  html_url: `https://example.test/pull/${number}`,
  head: { ref: `fix-${number}` },
  base: { ref: "main" },
  merged: true,
  merged_at: "2026-10-26T00:00:00Z",
  labels: [{ name: "backport release/0.62" }]
});

test("selects only the next source in main history, not PR number order", () => {
  const earlier = source(102);
  const later = source(101);
  const options = {
    channel: "0.62",
    sources: [later, earlier],
    mainHistory: [earlier.merge_commit_sha, later.merge_commit_sha],
    openBackports: [],
    historicalBackports: []
  };
  assert.equal(selectNextBackport(options)[0].source_pr, 102);
  assert.deepEqual(
    selectNextBackport({
      ...options,
      openBackports: [{ head: { ref: "automation/backport-102-to-0.62" } }]
    }),
    []
  );
  assert.equal(
    selectNextBackport({
      ...options,
      includedSourceCommits: [earlier.merge_commit_sha]
    })[0].source_pr,
    101
  );
  assert.throws(() => orderByMainHistory([later], []), /main merge history/);
});

test("completed backports require one source marker and its exact trailer", () => {
  const pull = source(101);
  const options = {
    channel: "0.62",
    sources: [pull],
    mainHistory: [pull.merge_commit_sha],
    openBackports: []
  };
  for (const [body, message, complete] of [
    [
      "<!-- radius-backport-source: #101 -->",
      `(cherry picked from commit ${pull.merge_commit_sha})`,
      true
    ],
    ["<!-- radius-backport-source: #101 -->", "conflict handoff only", false],
    [
      "<!-- radius-backport-source: #101 -->\n<!-- radius-backport-source: #102 -->",
      `(cherry picked from commit ${pull.merge_commit_sha})`,
      false
    ]
  ]) {
    const result = selectNextBackport({
      ...options,
      historicalBackports: [
        {
          body,
          merged_at: pull.merged_at,
          commits: [{ commit: { message } }]
        }
      ]
    });
    assert.equal(result.length, complete ? 0 : 1);
  }
});

test("release metadata retains its approved base and labels select separate channels", () => {
  const pull = source(101);
  pull.labels.push({ name: "backport release/0.61" }, pull.labels[0]);
  assert.deepEqual(
    entriesForMergedPull(pull).map(({ channel }) => channel),
    ["0.61", "0.62"]
  );
  pull.head.ref = "automation/prepare-release-0.62.0-rc.5";
  pull.body = `<!-- radius-release-plan:start -->\nsource:\n  productCommit: ${"b".repeat(40)}\n<!-- radius-release-plan:end -->`;
  assert.equal(backportEntry(pull, "0.62").expected_base, "b".repeat(40));
  pull.body = "";
  assert.throws(() => backportEntry(pull, "0.62"), /unique release plan/);
});

test("ancestry requires the exact branch and does not hide API errors", async () => {
  const pull = source(101);
  const github = {
    rest: {
      git: {
        listMatchingRefs: async () => ({
          data: [
            { ref: "refs/heads/release/0.620", object: { sha: "b".repeat(40) } }
          ]
        })
      },
      repos: {
        compareCommitsWithBasehead: async () => {
          throw new Error("lookup failed");
        }
      }
    }
  };
  const options = {
    github,
    owner: "radius-project",
    repo: "dashboard",
    channel: "0.62",
    sources: [pull]
  };
  assert.deepEqual(await findIncludedSourceCommits(options), []);
  github.rest.git.listMatchingRefs = async () => ({
    data: [{ ref: "refs/heads/release/0.62", object: { sha: "b".repeat(40) } }]
  });
  await assert.rejects(findIncludedSourceCommits(options), /lookup failed/);
  for (const status of [
    "ahead",
    "identical",
    "behind",
    "diverged",
    "invalid"
  ]) {
    github.rest.repos.compareCommitsWithBasehead = async () => ({
      data: { status }
    });
    if (status === "invalid") {
      await assert.rejects(
        findIncludedSourceCommits(options),
        /Unexpected ancestry/
      );
    } else {
      assert.deepEqual(
        await findIncludedSourceCommits(options),
        ["ahead", "identical"].includes(status) ? [pull.merge_commit_sha] : []
      );
    }
  }
});

test("manual selection validates the channel before reading Git or GitHub", async () => {
  for (const channel of ["0", "release/0.62", "0.062", "../main", "0.62\n"]) {
    await assert.rejects(selectReleaseBackports({ channel }), /X.Y format/);
  }
});

test("the queue uses each caller repository for main, release and manual events", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shared-backport-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8"
    }).trim();
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Backport test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("commit", "--quiet", "--allow-empty", "-m", "fix: first");
  const earlier = {
    ...source(102),
    merge_commit_sha: git("rev-parse", "HEAD")
  };
  git("commit", "--quiet", "--allow-empty", "-m", "fix: later");
  const later = { ...source(101), merge_commit_sha: git("rev-parse", "HEAD") };
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const original = process.cwd();
  try {
    process.chdir(directory);
    for (const repo of ["radius", "bicep-types-aws", "dashboard", "recipes"]) {
      const checkRepository = ({ owner, repo: actual }) => {
        assert.equal(owner, "radius-project");
        assert.equal(actual, repo);
      };
      const sources = [
        later,
        earlier,
        { ...source(103), base: { ref: "release/0.62" } },
        { ...source(104), merged_at: null }
      ];
      const github = {
        paginate: async (method, args) => {
          checkRepository(args);
          return method(args);
        },
        rest: {
          pulls: {
            list: async () => [],
            get: async (args) => {
              checkRepository(args);
              return {
                data: sources.find(({ number }) => number === args.pull_number)
              };
            }
          },
          issues: {
            listForRepo: async () =>
              sources.map(({ number }) => ({ number, pull_request: {} }))
          },
          git: {
            listMatchingRefs: async (args) => {
              checkRepository(args);
              return { data: [] };
            }
          }
        }
      };
      for (const event of [
        { eventName: "pull_request_target", payload: { pull_request: later } },
        { eventName: "push", ref: "refs/heads/release/0.62" },
        { eventName: "workflow_dispatch", channel: "0.62" }
      ]) {
        const result = await selectReleaseBackports({
          github,
          context: { repo: { owner: "radius-project", repo }, ...event },
          channel: event.channel
        });
        assert.equal(result.length, 1);
        assert.equal(result[0].source_pr, 102);
      }
    }
  } finally {
    process.chdir(original);
  }
});
