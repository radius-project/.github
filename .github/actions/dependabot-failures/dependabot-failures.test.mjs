/*
Copyright 2026 The Radius Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Run with: node --test .github/actions/dependabot-failures/dependabot-failures.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import run, { MARKER, failingUpdates, parseErrors, parseTitle } from "./dependabot-failures.mjs";

const NOW = "2026-10-22T00:00:00Z";
const WORKFLOW = { id: 1, path: "dynamic/dependabot/dependabot-updates" };

function dependabotRun(id, title, conclusion, createdAt) {
  return {
    id,
    display_title: `${title} - Update #${id}`,
    conclusion,
    created_at: createdAt,
    html_url: `https://github.com/o/r/actions/runs/${id}`
  };
}

// In-memory GitHub client. Issues are kept in `issues` so state carries over
// between runs; `failComment` makes the next createComment call fail.
function fakeGitHub({ runs = [], issues = [] } = {}) {
  const state = { issues, comments: [], failComment: false, nextNumber: 100 };
  const listIssues = Symbol("issues");
  const listRuns = Symbol("runs");
  const listWorkflows = Symbol("workflows");
  const github = {
    state,
    rest: {
      actions: {
        listRepoWorkflows: listWorkflows,
        listWorkflowRuns: listRuns,
        listJobsForWorkflowRun: async () => ({ data: { jobs: [] } }),
        downloadJobLogsForWorkflowRun: async () => ({ data: "" })
      },
      issues: {
        listForRepo: listIssues,
        getLabel: async () => ({}),
        createLabel: async () => ({}),
        create: async ({ title, body, labels }) => {
          const issue = { number: state.nextNumber++, title, body, labels, state: "open" };
          state.issues.push(issue);
          return { data: { ...issue, html_url: `i${issue.number}` } };
        },
        update: async ({ issue_number, body }) => {
          state.issues.find((i) => i.number === issue_number).body = body;
          return { data: {} };
        },
        createComment: async ({ issue_number, body }) => {
          if (state.failComment) {
            state.failComment = false;
            const error = new Error("Service Unavailable");
            error.status = 503;
            throw error;
          }
          state.comments.push({ issue_number, body });
          return { data: {} };
        }
      }
    },
    paginate: async (method, params) => {
      if (method === listWorkflows) {
        return [WORKFLOW];
      }
      if (method === listRuns) {
        const since = params.created.slice(2);
        return runs.filter((r) => r.created_at >= since);
      }
      if (method === listIssues) {
        return state.issues.filter(
          (i) => i.state === params.state && (!params.since || i.updated_at >= params.since)
        );
      }
      throw new Error("unexpected paginate call");
    }
  };
  return github;
}

const core = {
  info() {},
  warning() {},
  notice() {},
  summary: {
    addHeading() {
      return this;
    },
    addRaw() {
      return this;
    },
    async write() {}
  }
};
const context = { repo: { owner: "o", repo: "r" } };

test("parseTitle normalizes directory and dependency order", () => {
  const a = parseTitle("npm_and_yarn in /b, /a for z, y - Update #1");
  const b = parseTitle("npm_and_yarn in /a, /b for y, z - Update #2");
  assert.equal(a.key, b.key);
  assert.equal(a.base, "npm_and_yarn in /a, /b");
  assert.deepEqual(a.deps, ["y", "z"]);
  assert.equal(parseTitle("gomod in / - Update #3").key, "gomod in /");
});

test("parseErrors reads dependency names from multiline Details", () => {
  const log = [
    "| Type                         | Details                         |",
    "+------------------------------+---------------------------------+",
    "| security_update_not_possible | {                               |",
    '|                              |   "dependency-name": "vite",    |',
    "|      updater |      |   spliced line from another stream    |",
    "|                              | }                               |",
    "+------------------------------+---------------------------------+",
    "| Dependency | Error Type   | Error Details |",
    "| morgan     | private_auth | {}            |"
  ].join("\n");
  assert.deepEqual(parseErrors(log), [
    { type: "security_update_not_possible", dependencies: ["vite"] },
    { type: "private_auth", dependencies: ["morgan"] }
  ]);
});

test("a later successful group clears a single-dependency failure it includes", () => {
  const failing = failingUpdates([
    dependabotRun(1, "npm_and_yarn in / for vite", "failure", "2026-10-20T00:00:00Z"),
    dependabotRun(2, "npm_and_yarn in / for katex", "failure", "2026-10-20T00:00:00Z"),
    dependabotRun(3, "npm_and_yarn in /other for vite", "failure", "2026-10-20T00:00:00Z"),
    dependabotRun(4, "npm_and_yarn in / for brace-expansion, vite", "success", "2026-10-21T00:00:00Z")
  ]);
  assert.deepEqual(
    failing.map((u) => u.key),
    ["npm_and_yarn in / for katex", "npm_and_yarn in /other for vite"]
  );
});

test("an earlier successful group does not clear a later failure", () => {
  const failing = failingUpdates([
    dependabotRun(1, "npm_and_yarn in / for brace-expansion, vite", "success", "2026-10-19T00:00:00Z"),
    dependabotRun(2, "npm_and_yarn in / for vite", "failure", "2026-10-20T00:00:00Z")
  ]);
  assert.deepEqual(failing.map((u) => u.key), ["npm_and_yarn in / for vite"]);
});

test("opens one issue, then comments only on new failures", async () => {
  const runs = [dependabotRun(1, "pip in /x", "failure", "2026-10-21T00:00:00Z")];
  const github = fakeGitHub({ runs });
  assert.equal((await run({ github, context, core }, { now: NOW })).action, "create");
  assert.equal((await run({ github, context, core }, { now: NOW })).action, "update");
  assert.equal(github.state.comments.length, 0);

  runs.push(dependabotRun(2, "gomod in /", "failure", "2026-10-21T01:00:00Z"));
  assert.equal((await run({ github, context, core }, { now: NOW })).action, "update-and-comment");
  assert.equal(github.state.issues.length, 1);
  assert.equal(github.state.comments.length, 1);
});

test("retries the comment when posting it failed", async () => {
  const runs = [dependabotRun(1, "pip in /x", "failure", "2026-10-21T00:00:00Z")];
  const github = fakeGitHub({ runs });
  await run({ github, context, core }, { now: NOW });

  runs.push(dependabotRun(2, "gomod in /", "failure", "2026-10-21T01:00:00Z"));
  github.state.failComment = true;
  await assert.rejects(run({ github, context, core }, { now: NOW }), /Service Unavailable/u);
  assert.equal(github.state.comments.length, 0);

  const result = await run({ github, context, core }, { now: NOW });
  assert.equal(result.action, "update-and-comment");
  assert.equal(github.state.comments.length, 1);
  assert.match(github.state.comments[0].body, /gomod in \//u);
});

test("finds the open report past the first page of labeled issues", async () => {
  const filler = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, body: "x", state: "open" }));
  const github = fakeGitHub({
    runs: [dependabotRun(1, "pip in /x", "failure", "2026-10-21T00:00:00Z")],
    issues: [...filler, { number: 500, body: MARKER, state: "open" }]
  });
  const result = await run({ github, context, core }, { now: NOW });
  assert.equal(result.issue, 500);
  assert.equal(github.state.issues.length, 151);
});

test("uses the latest closed_at, not the latest update, as the cutoff", async () => {
  const github = fakeGitHub({
    runs: [dependabotRun(1, "pip in /x", "failure", "2026-10-19T00:00:00Z")],
    issues: [
      { number: 5, body: MARKER, state: "closed", closed_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-21T12:00:00Z" },
      { number: 6, body: MARKER, state: "closed", closed_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" }
    ]
  });
  const result = await run({ github, context, core }, { now: NOW });
  assert.equal(result.action, "none");
});
