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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const consumers = {
  docs: ["docs/config.toml", "docs/layouts/partials/hooks/body-end.html"],
  samples: ["bicepconfig.json"]
};
const workflow = readFileSync(
  new URL("../workflows/__upmerge.yml", import.meta.url),
  "utf8"
).replaceAll("\r\n", "\n");
const bash = process.env.UPMERGE_TEST_BASH || "bash";
const shellPath = (path) => path.replaceAll("\\", "/");

function step(name) {
  const blocks = workflow
    .split(/^      - name: /m)
    .filter((block) => block.startsWith(`${name}\n`));
  assert.equal(blocks.length, 1, `Expected exactly one ${name} step`);
  return blocks[0];
}

function script(name) {
  const match = step(name).match(
    /\n        run: \|\n((?:          [^\n]*\n|\n)+)/
  );
  assert.ok(match, `Missing literal run block for ${name}`);
  const result = match[1].replace(/^          /gm, "");
  assert.ok(!result.includes("${{"), "Pass script inputs through env");
  return result;
}

function succeeds(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function run(name, cwd, env, prefix = "") {
  const root = mkdtempSync(join(tmpdir(), "upmerge-step-"));
  try {
    // A file avoids Windows command-line conversion changing Bash escaping.
    const path = join(root, "step.sh");
    writeFileSync(path, `${prefix}\n${script(name)}`);
    const result = spawnSync(
      bash,
      ["--noprofile", "--norc", "-e", "-o", "pipefail", shellPath(path)],
      { cwd, env, encoding: "utf8" }
    );
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixture(t, ownedPaths = consumers.samples, initial = {}) {
  const root = mkdtempSync(join(tmpdir(), "shared-upmerge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin");
  const target = join(root, "target");
  const output = join(root, "output");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: shellPath(join(root, "gitconfig"))
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");

  function git(cwd, ...args) {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Upmerge Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args
      ],
      { cwd, env, encoding: "utf8" }
    );
    succeeds(result);
    return result.stdout.trim();
  }

  function write(files) {
    for (const [path, content] of Object.entries(files)) {
      const file = join(origin, path);
      if (content === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
  }

  mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=edge");
  git(origin, "config", "core.autocrlf", "false");
  write({
    "shared.txt": "first\nmiddle\nlast\n",
    "deleted.txt": "delete from source\n",
    ...Object.fromEntries(ownedPaths.map((path) => [path, "original\n"])),
    ...initial
  });
  git(origin, "add", "--all");
  git(origin, "commit", "--quiet", "--message=initial");
  git(origin, "branch", "release");

  return {
    root,
    origin,
    target,
    output,
    git,
    ownedPaths,
    change(branch, files) {
      git(origin, "checkout", "--quiet", branch);
      write(files);
      git(origin, "add", "--all");
      git(origin, "commit", "--quiet", `--message=Update ${branch}`);
      return git(origin, "rev-parse", "HEAD");
    },
    prepare(extraEnv = {}, prefix = "") {
      rmSync(output, { force: true });
      if (!existsSync(target)) {
        git(
          root,
          "clone",
          "--quiet",
          "--no-local",
          "--branch=edge",
          origin,
          target
        );
        git(target, "config", "core.autocrlf", "false");
        git(target, "config", "user.useConfigOnly", "true");
      }
      return run(
        "Prepare upmerge",
        target,
        {
          ...env,
          SOURCE_SHA: git(origin, "rev-parse", "release"),
          PRESERVE_PATHS: ownedPaths.join("\n"),
          GITHUB_OUTPUT: shellPath(output),
          GIT_COMMITTER_NAME: "Release Fixture[bot]",
          GIT_COMMITTER_EMAIL: "release-fixture@example.test",
          ...extraEnv
        },
        prefix
      );
    },
    outputs() {
      return existsSync(output) ? readFileSync(output, "utf8") : "";
    },
    content(path) {
      return readFileSync(join(target, path), "utf8");
    }
  };
}

function prepared(f, { conflict = false, changes = true } = {}) {
  const base = f.git(f.origin, "rev-parse", "edge");
  assert.equal(
    f.outputs(),
    `base-sha=${base}\nconflict=${conflict}\nhas-changes=${changes}\n`
  );
  assert.equal(f.git(f.target, "rev-parse", "HEAD"), base);
  assert.equal(f.git(f.target, "ls-files", "--unmerged"), "");
  assert.equal(existsSync(join(f.target, ".git", "MERGE_HEAD")), false);
}

function failed(f, result) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(f.outputs(), "");
}

for (const [repo, paths] of Object.entries(consumers)) {
  test(`${repo}: clean squash preserves both branches, not source ancestry`, (t) => {
    const f = fixture(t, paths);
    const base = f.change("edge", {
      "shared.txt": "edge\nmiddle\nlast\n",
      "edge-only.txt": "keep edge\n",
      ...Object.fromEntries(paths.map((path) => [path, "edge settings\n"]))
    });
    const source = f.change("release", {
      "shared.txt": "first\nmiddle\nsource\n",
      "source-only.txt": "add source\n",
      "deleted.txt": null,
      ...Object.fromEntries(paths.map((path) => [path, "release settings\n"]))
    });
    succeeds(f.prepare());
    prepared(f);
    assert.equal(f.content("shared.txt"), "edge\nmiddle\nsource\n");
    assert.equal(f.content("edge-only.txt"), "keep edge\n");
    assert.equal(f.content("source-only.txt"), "add source\n");
    assert.equal(existsSync(join(f.target, "deleted.txt")), false);
    for (const path of paths) assert.equal(f.content(path), "edge settings\n");
    assert.equal(f.git(f.origin, "log", "-1", "--format=%G?", source), "N");
    assert.equal(f.git(f.origin, "rev-parse", "release"), source);

    // Model the action capturing the staged diff, without live App signing.
    const tree = f.git(f.target, "write-tree");
    f.git(f.target, "commit", "--quiet", "--message=Capture net diff");
    assert.equal(f.git(f.target, "rev-list", "--count", `${base}..HEAD`), "1");
    assert.equal(f.git(f.target, "show", "-s", "--format=%P", "HEAD"), base);
    assert.equal(f.git(f.target, "rev-parse", "HEAD^{tree}"), tree);
    assert.equal(
      f.git(f.target, "rev-list", "HEAD").split("\n").includes(source),
      false
    );
  });

  for (const deletion of [false, true]) {
    test(`${repo}: content conflict produces a draft snapshot (source deletion=${deletion})`, (t) => {
      const f = fixture(t, paths);
      f.change("edge", {
        "shared.txt": "edge\n",
        "edge-only.txt": "manual reconciliation needed\n",
        ...Object.fromEntries(paths.map((path) => [path, "edge settings\n"]))
      });
      const source = f.change("release", {
        "shared.txt": deletion ? null : "source\n",
        "source-only.txt": "source addition\n",
        ...Object.fromEntries(paths.map((path) => [path, "source settings\n"]))
      });
      succeeds(f.prepare());
      prepared(f, { conflict: true });
      assert.equal(existsSync(join(f.target, "shared.txt")), !deletion);
      if (!deletion) assert.equal(f.content("shared.txt"), "source\n");
      assert.equal(f.content("source-only.txt"), "source addition\n");
      assert.equal(existsSync(join(f.target, "edge-only.txt")), false);
      for (const path of paths)
        assert.equal(f.content(path), "edge settings\n");
      assert.equal(
        f.git(
          f.target,
          "diff",
          "--name-only",
          source,
          f.git(f.target, "write-tree")
        ),
        [...paths].sort().join("\n")
      );
      assert.doesNotMatch(
        f.git(f.target, "diff", "--cached"),
        /^\+(?:<{7}|={7}|>{7})/m
      );
    });
  }

  for (const conflict of [false, true]) {
    test(`${repo}: edge-owned deletions survive (conflict=${conflict})`, (t) => {
      const f = fixture(t, paths);
      f.change("edge", {
        ...Object.fromEntries(paths.map((path) => [path, null])),
        "edge-only.txt": "keep on a clean merge\n",
        ...(conflict ? { "shared.txt": "edge\n" } : {})
      });
      f.change("release", {
        ...Object.fromEntries(
          paths.map((path) => [path, "release settings\n"])
        ),
        "source-only.txt": "source\n",
        ...(conflict ? { "shared.txt": "source\n" } : {})
      });
      succeeds(f.prepare());
      prepared(f, { conflict });
      for (const path of paths)
        assert.equal(existsSync(join(f.target, path)), false);
      if (!conflict)
        assert.equal(f.content("edge-only.txt"), "keep on a clean merge\n");
    });
  }

  for (const adds of [false, true]) {
    test(`${repo}: files absent from edge stay absent (source adds=${adds})`, (t) => {
      const f = fixture(
        t,
        paths,
        Object.fromEntries(paths.map((path) => [path, null]))
      );
      f.change("release", {
        "source-only.txt": "source\n",
        ...(adds ?
          Object.fromEntries(paths.map((path) => [path, "release settings\n"]))
        : {})
      });
      succeeds(f.prepare());
      prepared(f);
      for (const path of paths)
        assert.equal(existsSync(join(f.target, path)), false);
    });
  }

  test(`${repo}: source deletions cannot delete edge-owned files`, (t) => {
    const f = fixture(t, paths);
    f.change("release", {
      "source-only.txt": "source\n",
      ...Object.fromEntries(paths.map((path) => [path, null]))
    });
    succeeds(f.prepare());
    prepared(f);
    for (const path of paths) assert.equal(f.content(path), "original\n");
  });

  for (const scenario of [
    "identical",
    "ancestor",
    "already applied",
    "edge-owned only"
  ]) {
    test(`${repo}: ${scenario} source is a real no-op`, (t) => {
      const f = fixture(t, paths);
      if (scenario === "ancestor") {
        f.change("edge", { "edge-only.txt": "keep\n" });
      } else if (scenario === "already applied") {
        f.change("edge", { "source-only.txt": "same content\n" });
        f.change("release", { "source-only.txt": "same content\n" });
      } else if (scenario === "edge-owned only") {
        f.change("release", {
          ...Object.fromEntries(
            paths.map((path) => [path, "source settings\n"])
          )
        });
      }
      succeeds(f.prepare());
      prepared(f, { changes: false });
      assert.equal(f.git(f.target, "status", "--porcelain"), "");
    });
  }
}

test("docs: mixed edge overrides and deletions preserve the combined tree", (t) => {
  const f = fixture(t, consumers.docs);
  const [config, hook] = consumers.docs;
  f.change("edge", {
    [config]: "edge\n",
    [hook]: null,
    "edge-only.txt": "keep\n"
  });
  f.change("release", {
    [config]: null,
    [hook]: "release\n",
    "source-only.txt": "source\n"
  });
  succeeds(f.prepare());
  prepared(f);
  assert.equal(f.content(config), "edge\n");
  assert.equal(existsSync(join(f.target, hook)), false);
  assert.equal(f.content("edge-only.txt"), "keep\n");
  assert.equal(f.content("source-only.txt"), "source\n");
});

test("paths with whitespace, quotes, shell text and brackets are literal", (t) => {
  const paths = [
    "config[ab].json",
    "config with spaces.json",
    "config'quote.json",
    "config$(touch UNEXPECTED).json",
    "--config.json"
  ];
  const f = fixture(t, paths, { "configa.json": "original\n" });
  f.change("edge", Object.fromEntries(paths.map((path) => [path, "edge\n"])));
  f.change("release", {
    ...Object.fromEntries(paths.map((path) => [path, "source\n"])),
    "configa.json": "source neighbour\n"
  });
  succeeds(f.prepare());
  prepared(f);
  for (const path of paths) assert.equal(f.content(path), "edge\n");
  assert.equal(f.content("configa.json"), "source neighbour\n");
  assert.equal(existsSync(join(f.target, "UNEXPECTED")), false);
});

test("CRLF lists and blank lines are accepted", (t) => {
  const f = fixture(t, consumers.docs);
  succeeds(
    f.prepare({ PRESERVE_PATHS: `\r\n${consumers.docs.join("\r\n")}\r\n\r\n` })
  );
  prepared(f, { changes: false });
});

test("unsafe or empty path lists fail before modifying edge", async (t) => {
  const f = fixture(t);
  for (const path of [
    "",
    "\n\r\n",
    ".",
    "..",
    "/",
    "/absolute.json",
    "../outside.json",
    "config/../outside.json",
    "./config.json",
    ".git/config",
    "config/.git/file",
    "config//file",
    "config/",
    "C:/config.json",
    "C:\\config.json",
    "config\\file",
    ":(glob)**",
    "config\tfile"
  ]) {
    await t.test(JSON.stringify(path), () => {
      failed(f, f.prepare({ PRESERVE_PATHS: path }));
      assert.equal(f.git(f.target, "status", "--porcelain"), "");
    });
  }
});

for (const branch of ["edge", "release"]) {
  test(`preserved directory on ${branch} fails before merge`, (t) => {
    const f = fixture(t);
    f.change(branch, { "settings/config.json": "settings\n" });
    const result = f.prepare({ PRESERVE_PATHS: "settings" });
    failed(f, result);
    assert.match(result.stdout, /file paths, not directories/);
    assert.equal(f.git(f.target, "status", "--porcelain"), "");
  });
}

test("missing source commits fail instead of creating a draft or no-op", (t) => {
  const f = fixture(t);
  failed(f, f.prepare({ SOURCE_SHA: "f".repeat(40) }));
});

test("unrelated histories are not content conflicts", (t) => {
  const f = fixture(t);
  f.git(f.origin, "checkout", "--quiet", "--orphan=unrelated");
  f.git(f.origin, "commit", "--quiet", "--message=unrelated");
  const result = f.prepare({
    SOURCE_SHA: f.git(f.origin, "rev-parse", "HEAD")
  });
  failed(f, result);
  assert.match(result.stderr, /unrelated histories/);
});

test("missing App preparation identity cannot fall back to OS guessing", (t) => {
  const f = fixture(t);
  f.change("edge", { "edge-only.txt": "edge\n" });
  f.change("release", { "source-only.txt": "source\n" });
  const result = f.prepare({ GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" });
  failed(f, result);
  assert.match(result.stderr, /empty ident|identity unknown/i);
});

for (const [scenario, env, prefix] of [
  ["invalid source SHA", { SOURCE_SHA: "--bad-ref" }, ""],
  ["dirty checkout", {}, 'printf "unexpected\\n" > unexpected.txt'],
  ["wrong branch", {}, "git checkout --quiet -b not-edge"],
  [
    "mismatched fetched source",
    {},
    `git() {
    if [[ "$*" == "rev-parse --verify FETCH_HEAD^{commit}" ]]; then
      printf '%040d\\n' 0
    else
      command git "$@"
    fi
  }`
  ]
]) {
  test(`${scenario} fails before merge`, (t) => {
    const f = fixture(t);
    failed(f, f.prepare(env, prefix));
  });
}

for (const [command, status] of [
  ["merge", 1],
  ["merge", 128],
  ["ls-files", 128],
  ["ls-tree", 128],
  ["restore", 128],
  ["rm", 128],
  ["read-tree", 128],
  ["diff", 2]
]) {
  test(`git ${command} exit ${status} fails closed`, (t) => {
    const f = fixture(t);
    if (command === "read-tree") {
      f.change("edge", { "shared.txt": "edge\n" });
      f.change("release", { "shared.txt": "source\n" });
    } else if (command === "rm") {
      f.change("edge", { [f.ownedPaths[0]]: null });
    }
    const result = f.prepare(
      {},
      `git() {
      if [[ "$1" == "${command}" ]]; then
        echo "fixture ${command} failure" >&2
        return ${status}
      fi
      command git "$@"
    }`
    );
    failed(f, result);
    assert.match(result.stderr, new RegExp(`fixture ${command} failure`));
  });
}

test("a real index lock failure is not disguised as a content conflict", (t) => {
  const f = fixture(t);
  f.change("release", { "source-only.txt": "source\n" });
  const result = f.prepare({}, "touch .git/index.lock");
  failed(f, result);
  assert.match(result.stderr, /index.lock/);
});

for (const status of [0, 128]) {
  test(`unmerged files with merge exit ${status} are not a valid content result`, (t) => {
    const f = fixture(t);
    f.change("edge", { "shared.txt": "edge\n" });
    f.change("release", { "shared.txt": "source\n" });
    failed(
      f,
      f.prepare(
        {},
        `git() {
      if [[ "$1" == "merge" ]]; then
        command git "$@" || return ${status}
      else
        command git "$@"
      fi
    }`
      )
    );
  });
}

test("a conflict snapshot with no reviewable diff fails, not a no-op", (t) => {
  const f = fixture(t);
  f.change("edge", { "shared.txt": "edge\n" });
  f.change("release", { "shared.txt": "source\n" });
  const result = f.prepare(
    {},
    `git() {
    if [[ "$1" == "read-tree" ]]; then
      command git read-tree --reset -u HEAD
    else
      command git "$@"
    fi
  }`
  );
  failed(f, result);
  assert.match(result.stdout, /no reviewable diff/);
});

test("output I/O errors fail the step", (t) => {
  const f = fixture(t);
  failed(f, f.prepare({ GITHUB_OUTPUT: shellPath(f.root) }));
});

test("the action output gate rejects unsigned or missing publication results", async (t) => {
  const good = {
    COMMITS_VERIFIED: "true",
    PR_NUMBER: "123",
    PR_URL: "https://github.com/radius-project/samples/pull/123",
    PR_HEAD_SHA: "a".repeat(40)
  };
  succeeds(
    run("Require signed pull request", process.cwd(), {
      ...process.env,
      ...good
    })
  );
  for (const [name, value] of [
    ...Object.keys(good).map((name) => [name, ""]),
    ["COMMITS_VERIFIED", "false"],
    ["COMMITS_VERIFIED", "TRUE"]
  ]) {
    await t.test(`${name}=${value || "missing"}`, () => {
      const result = run("Require signed pull request", process.cwd(), {
        ...process.env,
        ...good,
        [name]: value
      });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /GitHub-verified commit and pull request/);
    });
  }
});

test("the workflow delegates signing and lifecycle to the pinned action", () => {
  const prepare = step("Prepare upmerge");
  assert.match(prepare, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(prepare, /PRESERVE_PATHS: \$\{\{ inputs\.preserve-paths \}\}/);
  for (const [name, output] of [
    ["NAME", "name"],
    ["EMAIL", "email"]
  ]) {
    assert.ok(
      prepare.includes(
        `GIT_COMMITTER_${name}: \${{ steps.bot-details.outputs.${output} }}`
      )
    );
  }
  assert.match(
    step("Get App Token"),
    /repositories: \$\{\{ github\.event\.repository\.name \}\}/
  );
  for (const permission of ["contents", "pull-requests", "workflows"]) {
    assert.ok(
      step("Get App Token").includes(`permission-${permission}: write`)
    );
  }
  assert.match(step("Get bot details"), /set-env: false/);
  assert.match(step("Checkout edge"), /ref: edge/);
  assert.match(step("Checkout edge"), /fetch-depth: 0/);

  const create = step("Create pull request");
  assert.match(create, /if: steps\.prepare\.outputs\.has-changes == 'true'/);
  assert.match(
    create,
    /peter-evans\/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1 # v8\.1\.1/
  );
  assert.match(create, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(create, /sign-commits: true/);
  assert.match(
    create,
    /Signed-off-by: \$\{\{ steps\.bot-details\.outputs\.name \}\} <\$\{\{ steps\.bot-details\.outputs\.email \}\}>/
  );
  assert.match(
    create,
    /branch: upmerge\/\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(create, /base: edge/);
  assert.match(create, /title: Upmerge to edge/);
  assert.match(
    create,
    /draft: \$\{\{ steps\.prepare\.outputs\.conflict == 'true' \}\}/
  );
  assert.match(create, /provisional source snapshot, not a resolved merge/);
  assert.match(create, /edge-only changes may be absent/);
  assert.doesNotMatch(create, /^\s+(author|committer|branch-token):/m);
  assert.doesNotMatch(
    workflow,
    /\bgit (commit|push|reset)\b|\bgh pr\b|github-script|uses: \$\//
  );
  const guard = step("Require signed pull request");
  assert.match(guard, /if: steps\.prepare\.outputs\.has-changes == 'true'/);
  for (const [name, output] of [
    ["COMMITS_VERIFIED", "pull-request-commits-verified"],
    ["PR_NUMBER", "pull-request-number"],
    ["PR_URL", "pull-request-url"],
    ["PR_HEAD_SHA", "pull-request-head-sha"]
  ]) {
    assert.ok(
      guard.includes(`${name}: \${{ steps.pull-request.outputs.${output} }}`)
    );
  }
});
