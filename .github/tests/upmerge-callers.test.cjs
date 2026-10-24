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

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const nunjucks = require("nunjucks");
const { parse } = require("yaml");

const root = resolve(__dirname, "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const source = "sync-templates/.github/workflows/upmerge.yaml.njk";
const destination = ".github/workflows/upmerge.yaml";
const reusable = "radius-project/.github/.github/workflows/__upmerge.yml@main";
const secrets = {
  RADIUS_RELEASE_BOT_CLIENT_ID: "${{ secrets.RADIUS_RELEASE_BOT_CLIENT_ID }}",
  RADIUS_RELEASE_BOT_PRIVATE_KEY:
    "${{ secrets.RADIUS_RELEASE_BOT_PRIVATE_KEY }}"
};
const expected = {
  "radius-project/docs@edge": [
    "docs/config.toml",
    "docs/layouts/partials/hooks/body-end.html"
  ],
  "radius-project/samples@edge": ["bicepconfig.json"]
};
const mappings = parse(read(".github/sync.yml")).group.flatMap((group) =>
  group.files
    .filter((file) => file.source === source || file.dest === destination)
    .flatMap((file) =>
      group.repos
        .trim()
        .split(/\s+/)
        .map((repo) => ({ repo, file, group }))
    )
);
// Match raven-actions/repo-files-sync v0.1.0-rc.18's template defaults.
const renderer = new nunjucks.Environment(null, {
  autoescape: true,
  trimBlocks: true,
  lstripBlocks: true
});
const render = (variables) => renderer.renderString(read(source), variables);

test("sync enrolls only docs@edge and samples@edge with one thin caller each", () => {
  assert.deepEqual(
    mappings.map(({ repo }) => repo).sort(),
    Object.keys(expected)
  );
  for (const { repo, file, group } of mappings) {
    assert.equal(group.files.length, 1);
    assert.deepEqual(file, {
      source,
      dest: destination,
      template: { preserve_paths: expected[repo] }
    });
  }
});

for (const [repo, paths] of Object.entries(expected)) {
  test(`${repo}: real Nunjucks render preserves the exact caller contract`, () => {
    const mapping = mappings.find((entry) => entry.repo === repo);
    assert.ok(mapping, `Missing sync mapping for ${repo}`);
    const content = render(mapping.file.template);
    assert.match(content, /^# yaml-language-server:/);
    assert.match(content, /DO NOT EDIT MANUALLY/);
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"));
    assert.doesNotMatch(content, /\r|\{%|%\}|&#\d+;/);
    assert.deepEqual(parse(content), {
      name: "Upmerge to edge",
      on: { workflow_dispatch: null },
      permissions: {},
      jobs: {
        upmerge: {
          uses: reusable,
          permissions: { contents: "read" },
          with: { "preserve-paths": `${paths.join("\n")}\n` },
          secrets
        }
      }
    });
  });
}

test("the renderer does not HTML-escape literal preserved file names", () => {
  const paths = [
    "config with spaces.json",
    "config'quote.json",
    "config[ab]&.json"
  ];
  const caller = parse(render({ preserve_paths: paths }));
  assert.equal(
    caller.jobs.upmerge.with["preserve-paths"],
    `${paths.join("\n")}\n`
  );
  assert.deepEqual(caller.jobs.upmerge.secrets, secrets);
});

test("the shared workflow accepts only its documented input and secrets", () => {
  const shared = parse(read(".github/workflows/__upmerge.yml"));
  assert.deepEqual(Object.keys(shared.on), ["workflow_call"]);
  const contract = shared.on.workflow_call;
  assert.deepEqual(Object.keys(contract.inputs), ["preserve-paths"]);
  assert.equal(contract.inputs["preserve-paths"].type, "string");
  assert.equal(contract.inputs["preserve-paths"].required, true);
  assert.deepEqual(Object.keys(contract.secrets), Object.keys(secrets));
  for (const secret of Object.values(contract.secrets)) {
    assert.equal(secret.required, true);
  }
  assert.deepEqual(shared.permissions, {});
  assert.deepEqual(Object.keys(shared.jobs), ["upmerge"]);
  assert.equal(
    shared.jobs.upmerge.if,
    "github.event_name == 'workflow_dispatch'"
  );
  assert.deepEqual(shared.jobs.upmerge.permissions, { contents: "read" });
});

test("read-only PR CI covers the shared workflow, mappings, template and tests", () => {
  const content = read(".github/workflows/test-actions.yml");
  const ci = parse(content);
  assert.deepEqual(ci.permissions, {});
  assert.deepEqual(ci.jobs.test.permissions, { contents: "read" });
  assert.deepEqual(ci.on.push.branches, ["main"]);
  for (const event of ["pull_request", "push"]) {
    for (const path of [
      ".github/actions/**",
      ".github/tests/**",
      ".github/workflows/__upmerge.yml",
      ".github/workflows/test-actions.yml",
      ".github/sync.yml",
      source
    ]) {
      assert.ok(
        ci.on[event].paths.includes(path),
        `Missing ${event} path ${path}`
      );
    }
  }
  assert.equal(ci.jobs.test.steps[0].with["persist-credentials"], false);
  assert.match(content, /--ignore-scripts.*nunjucks@3\.2\.4 yaml@2\.9\.0/);
  assert.match(
    content,
    /node --test \.github\/actions\/\*\/\*\.test\.mjs \.github\/tests\/\*\.test\.\*/
  );
  assert.doesNotMatch(
    content,
    /secrets\.|pull_request_target|__upmerge\.yml@|\bgh\b/
  );
});
