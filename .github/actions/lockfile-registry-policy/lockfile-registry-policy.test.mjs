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

// Run with: node --test .github/actions/lockfile-registry-policy/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import run, {
  compilePatterns,
  isPolicyFile,
  scanRepository,
  scanText
} from "./lockfile-registry-policy.mjs";

const BLOCKED = "*.pkgs.visualstudio.com\npkgs.dev.azure.com";
const PATTERNS = compilePatterns(BLOCKED);
const URL =
  "https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/pkg/-/pkg-1.0.tgz";

const examples = {
  "package-lock.json": `{"packages":{"node_modules/pkg":{"resolved":"${URL}"}}}`,
  "npm-shrinkwrap.json": `{"dependencies":{"pkg":{"resolved":"${URL}"}}}`,
  "yarn.lock": `pkg@^1.0:\n  resolved "${URL}#sha512"`,
  "app/yarn.lock": `"pkg@https://pkgs.dev.azure.com/pkg.tgz":\n  resolution: "pkg@https%3A%2F%2Fpkgs.dev.azure.com%2Fpkg.tgz"`,
  "pnpm-lock.yaml": `packages:\n  pkg@1.0:\n    resolution: {tarball: ${URL}}`,
  "nested/pnpm-lock.yaml":
    "packages:\n  /team.pkgs.visualstudio.com/pkg/1.0:\n    dev: true",
  "bun.lock": `{"packages":{"pkg":["pkg@1.0","${URL}",{},"sha512"]}}`,
  ".npmrc": "//pkgs.dev.azure.com/org/:_authToken=${TOKEN}",
  ".yarnrc": 'registry "https://team.pkgs.visualstudio.com/npm/registry"',
  ".yarnrc.yml": 'npmRegistryServer: "https://pkgs.dev.azure.com/org/"',
  "pnpm-workspace.yaml":
    "registries:\n  default: https://pkgs.dev.azure.com/org/",
  "package.json": `{"dependencies":{"pkg":"${URL}"}}`,
  "deno.lock": `{"remote":{"${URL}":"sha256"}}`,
  "Pipfile.lock":
    '{"_meta":{"sources":[{"url":"https://pkgs.dev.azure.com/org/simple"}]}}',
  "poetry.lock":
    '[package.source]\nurl = "https://team.pkgs.visualstudio.com/simple"',
  "pdm.lock": 'url = "https://pkgs.dev.azure.com/org/pkg.whl"',
  "uv.lock": 'source = { registry = "https://pkgs.dev.azure.com/org/simple" }',
  "pylock.toml": 'url = "https://pkgs.dev.azure.com/org/pkg.whl"',
  "pylock.dev.toml": 'url = "https://pkgs.dev.azure.com/org/pkg.whl"',
  Pipfile: '[[source]]\nurl = "https://pkgs.dev.azure.com/org/simple"',
  "pyproject.toml":
    '[[tool.poetry.source]]\nurl = "https://pkgs.dev.azure.com/org/simple"',
  "requirements.txt": "--index-url https://pkgs.dev.azure.com/org/simple",
  "requirements-dev.in":
    "--extra-index-url https://pkgs.dev.azure.com/org/simple",
  "requirements.lock": "--index-url https://pkgs.dev.azure.com/org/simple",
  "requirements/base.txt": "pkg @ https://pkgs.dev.azure.com/org/pkg.whl",
  "constraints/build.in": "--index-url https://pkgs.dev.azure.com/org/simple",
  "pip.conf": "[global]\nindex-url=https://pkgs.dev.azure.com/org/simple",
  "NuGet.Config":
    '<add key="feed" value="https://pkgs.dev.azure.com/org/nuget/v3/index.json" />',
  "Directory.Build.props":
    "<RestoreSources>https://pkgs.dev.azure.com/org/nuget</RestoreSources>",
  "src/app.csproj":
    "<RestoreAdditionalProjectSources>https://team.pkgs.visualstudio.com/nuget</RestoreAdditionalProjectSources>",
  "paket.lock": "NUGET\n  remote: https://pkgs.dev.azure.com/org/nuget",
  "Cargo.lock": 'source = "registry+https://pkgs.dev.azure.com/org/index"',
  ".cargo/config.toml":
    '[registries.internal]\nindex = "https://pkgs.dev.azure.com/org/index"',
  "Gemfile.lock": "GEM\n  remote: https://pkgs.dev.azure.com/org/gems/",
  ".bundle/config":
    'BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG/: "https://pkgs.dev.azure.com/org/gems/"',
  "composer.lock": `{"packages":[{"dist":{"url":"${URL}"}}]}`,
  "gradle.lockfile": "# https://pkgs.dev.azure.com/org/maven",
  "gradle/dependency-locks/runtimeClasspath.lockfile":
    "# https://pkgs.dev.azure.com/org/maven",
  "build.gradle.kts":
    'maven { url = uri("https://pkgs.dev.azure.com/org/maven") }',
  "pom.xml":
    "<repository><url>https://pkgs.dev.azure.com/org/maven</url></repository>",
  "go.mod": "replace example.com/pkg => pkgs.dev.azure.com/org/pkg v1.0.0",
  "pubspec.lock": 'url: "https://pkgs.dev.azure.com/org/pub"',
  "Package.resolved":
    '{"pins":[{"repositoryURL":"https://pkgs.dev.azure.com/org/repo"}]}',
  "Podfile.lock": "SPEC REPOS:\n  https://pkgs.dev.azure.com/org/specs:",
  ".terraform.lock.hcl": 'provider "pkgs.dev.azure.com/org/provider" {}'
};

for (const [file, content] of Object.entries(examples)) {
  test(`detects registry sources in ${file}`, () => {
    assert.ok(isPolicyFile(file));
    const findings = scanText(file, content, PATTERNS);
    assert.ok(findings.length > 0);
    assert.ok(
      findings.every((finding) => finding.file === file && finding.line > 0)
    );
  });
}

test("supports source-free lockfiles without claiming to infer a registry", () => {
  for (const file of [
    "packages.lock.json",
    "packages.app.lock.json",
    "project.lock.json",
    "go.sum"
  ]) {
    assert.ok(isPolicyFile(file));
    assert.deepEqual(
      scanText(file, '{"version":1,"dependencies":{}}', PATTERNS),
      []
    );
  }
});

test("host globs match subdomains, case, ports, credentials and trailing DNS dots", () => {
  for (const url of [
    "https://team.pkgs.visualstudio.com/a",
    "https://nested.team.pkgs.visualstudio.com/a",
    "HTTPS://PKGS.DEV.AZURE.COM:443/a",
    "http://pkgs.dev.azure.com:8080/a",
    "https://pkgs.dev.azure.com./a",
    "https://user:secret@pkgs.dev.azure.com/a?token=secret#secret",
    "https://secret%2Fuser@pkgs.dev.azure.com/a",
    "https://user:secret%2Fpassword@pkgs.dev.azure.com/a",
    "https://${USER}:${TOKEN}@pkgs.dev.azure.com/a",
    "git+https://pkgs.dev.azure.com/org/repo"
  ]) {
    const findings = scanText("package-lock.json", url, PATTERNS);
    assert.equal(findings.length, 1, url);
    assert.doesNotMatch(JSON.stringify(findings), /secret|\$\{TOKEN\}/);
  }
});

test("does not match public registries, deceptive hosts, paths or query substrings", () => {
  const contents = [
    "https://registry.npmjs.org/pkg",
    "https://registry.yarnpkg.com/pkg",
    "https://pypi.org/simple",
    "https://files.pythonhosted.org/pkg.whl",
    "https://api.nuget.org/v3/index.json",
    "https://pkgs.dev.azure.com.example.org/pkg",
    "https://notpkgs.dev.azure.com/pkg",
    "https://pkgs.visualstudio.com/pkg",
    "https://example.org/pkgs.dev.azure.com/pkg",
    "https://example.org/?source=pkgs.dev.azure.com",
    "https://pkgs.dev.azure.com@example.org/pkg"
  ].join("\n");
  assert.deepEqual(scanText("requirements.txt", contents, PATTERNS), []);
});

test("decodes JSON, XML and percent-encoded references", () => {
  const content = [
    String.raw`{"resolved":"https:\/\/pkgs\u002edev\u002eazure\u002ecom\/pkg"}`,
    '<add value="https:&#x2f;&#47;pkgs.dev.azure.com/pkg?key=a&amp;b=c" />',
    '"pkg@https%3A%2F%2Fpkgs%2Edev%2Eazure%2Ecom%2Fpkg"',
    "https://pkgs.dev.azure.com/pkg https://pkgs.dev.azure.com/another",
    "https://%70kgs%2Edev%2Eazure%2Ecom/pkg",
    '"pkg@https%3A%2F%2Fsecret%252Fuser%40pkgs.dev.azure.com%2Fpkg"'
  ].join("\r\n");
  const findings = scanText("package-lock.json", content, PATTERNS);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [1, 2, 3, 4, 5, 6]
  );
  assert.doesNotMatch(JSON.stringify(findings), /secret/);
});

test("URL globs are path-specific, case-sensitive in paths, and support single-character wildcards", () => {
  const patterns = compilePatterns(
    "# comment\nhttps://REG?.example.com/Team/*\n"
  );
  const input = [
    "https://reg1.example.com/Team/pkg",
    "https://reg2.example.com/team/pkg",
    "https://reg12.example.com/Team/pkg",
    "http://reg1.example.com/Team/pkg",
    "https://reg2.example.com/Other/pkg"
  ].join("\n");
  assert.deepEqual(
    scanText("uv.lock", input, patterns).map((finding) => finding.line),
    [1]
  );
});

test("checks every registry in semicolon-separated MSBuild sources", () => {
  const text =
    "<RestoreSources>https://api.nuget.org/v3/index.json;https://pkgs.dev.azure.com/org/nuget;https://team.pkgs.visualstudio.com/nuget</RestoreSources>";
  assert.equal(scanText("Directory.Build.props", text, PATTERNS).length, 2);
  const patterns = compilePatterns("https://pkgs.dev.azure.com/org/*");
  assert.equal(scanText("app.csproj", text, patterns).length, 1);
});

test("an override replaces rather than adds to the blocked list", () => {
  const patterns = compilePatterns("registry.example.com");
  assert.deepEqual(scanText("yarn.lock", URL, patterns), []);
  assert.equal(
    scanText("yarn.lock", "https://registry.example.com/pkg", patterns).length,
    1
  );
});

test("URL globs normalize default ports and trailing DNS dots", () => {
  const patterns = compilePatterns("https://pkgs.dev.azure.com.:443/org/*");
  assert.equal(scanText("uv.lock", URL, patterns).length, 1);
  for (const prefix of ["git+", "registry+", "sparse+"]) {
    assert.equal(scanText("Cargo.lock", `${prefix}${URL}`, patterns).length, 1);
  }
});

test("invalid or empty policy fails without leaking input", () => {
  for (const value of [
    "",
    "  \n# only comments",
    "[]",
    "*.example.com,other.example.com",
    "https://user:secret@example.com",
    "ftp://example.com",
    "[a-z].example.com",
    "example.com/path",
    "example.com:443",
    "https://example.com/#secret",
    null
  ]) {
    assert.throws(
      () => compilePatterns(value),
      (error) =>
        error.message.includes("blocked-registries") &&
        !error.message.includes("secret")
    );
  }
});

test("invalid URL tokens still cannot hide a literal blocked host", () => {
  assert.equal(
    scanText(
      "pip.conf",
      "https://[bad]@pkgs.dev.azure.com:invalid/pkg",
      PATTERNS
    ).length,
    1
  );
});

async function repository(t, files) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "registry-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd });
  for (const [file, content] of Object.entries(files)) {
    const filename = path.join(cwd, file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  execFileSync("git", ["add", "--force", "--all"], { cwd });
  return cwd;
}

test("scans every tracked nested dependency file, including hidden paths and spaces", async (t) => {
  const cwd = await repository(t, {
    ".fixtures/nested app/package-lock.json": `{"resolved":"${URL}"}`,
    "requirements/prod.txt": "--index-url https://pkgs.dev.azure.com/simple",
    "README.md": URL,
    ".github/workflows/test.yml": URL,
    "src/code.js": URL,
    "node_modules/vendored/package-lock.json": `{"resolved":"${URL}"}`
  });
  await writeFile(path.join(cwd, "yarn.lock"), URL);
  const result = await scanRepository({ cwd, blockedRegistries: BLOCKED });
  assert.deepEqual(result.files, [
    ".fixtures/nested app/package-lock.json",
    "node_modules/vendored/package-lock.json",
    "requirements/prod.txt"
  ]);
  assert.equal(result.findings.length, 3);
});

test("reads BOM-marked UTF-16 NuGet configuration", async (t) => {
  const text =
    '<add value="https://pkgs.dev.azure.com/org/nuget/v3/index.json" />';
  const le = Buffer.from(`\ufeff${text}`, "utf16le");
  const be = Buffer.from(le).swap16();
  const cwd = await repository(t, {
    "NuGet.Config": le,
    "nested/NuGet.Config": be
  });
  assert.equal(
    (await scanRepository({ cwd, blockedRegistries: BLOCKED })).findings.length,
    2
  );
});

test("fails explicitly for binary and undecodable dependency files", async (t) => {
  for (const [file, bytes, message] of [
    ["bun.lockb", Buffer.from("binary"), /Migrate to the text bun.lock/],
    ["yarn.lock", Buffer.from([0x00, 0x01]), /binary dependency/],
    ["uv.lock", Buffer.from([0xff, 0xff]), /cannot decode/]
  ]) {
    const cwd = await repository(t, { [file]: bytes });
    await assert.rejects(
      scanRepository({ cwd, blockedRegistries: BLOCKED }),
      message
    );
  }
});

test(
  "does not follow a dependency-file symlink",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await repository(t, { "README.md": "example" });
    await symlink(
      path.join(cwd, "README.md"),
      path.join(cwd, "package-lock.json")
    );
    execFileSync("git", ["add", "--all"], { cwd });
    await assert.rejects(
      scanRepository({ cwd, blockedRegistries: BLOCKED }),
      /not symlinks/
    );
  }
);

test("does not follow a parent-directory symlink outside the checkout", async (t) => {
  const cwd = await repository(t, { "nested/package-lock.json": "{}" });
  const outside = await repository(t, { "package-lock.json": URL });
  await rm(path.join(cwd, "nested"), { recursive: true });
  await symlink(
    outside,
    path.join(cwd, "nested"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    scanRepository({ cwd, blockedRegistries: BLOCKED }),
    /not symlinks/
  );
});

test("missing tracked files fail instead of passing silently", async (t) => {
  const cwd = await repository(t, { "yarn.lock": URL });
  await rm(path.join(cwd, "yarn.lock"));
  await assert.rejects(
    scanRepository({ cwd, blockedRegistries: BLOCKED }),
    /ENOENT/
  );
});

function fakeCore() {
  const messages = [];
  return {
    messages,
    info: (text) => messages.push(text),
    error: (text, annotation) => messages.push({ text, annotation }),
    setFailed: (text) => messages.push({ failed: text }),
    summary: {
      addHeading(text) {
        messages.push(text);
        return this;
      },
      addRaw(text) {
        messages.push(text);
        return this;
      },
      async write() {}
    }
  };
}

test("reports annotations and failure without exposing URL credentials or query tokens", async (t) => {
  const cwd = await repository(t, {
    "requirements.txt":
      "# packages\n--index-url https://user:secret@pkgs.dev.azure.com/simple?token=supersecret"
  });
  const core = fakeCore();
  await run({ core }, { cwd, blockedRegistries: BLOCKED });
  assert.ok(core.messages.some((message) => message.failed));
  assert.ok(
    core.messages.some(
      (message) =>
        message.annotation?.file === "requirements.txt" &&
        message.annotation.startLine === 2
    )
  );
  assert.doesNotMatch(JSON.stringify(core.messages), /secret|user:|token=/);
});

test("reports no applicable files explicitly and succeeds", async (t) => {
  const cwd = await repository(t, { "README.md": "No packages" });
  const core = fakeCore();
  const result = await run({ core }, { cwd, blockedRegistries: BLOCKED });
  assert.deepEqual(result, { files: [], findings: [] });
  assert.ok(
    core.messages.some(
      (message) =>
        typeof message === "string" && message.includes("No supported")
    )
  );
  assert.ok(!core.messages.some((message) => message.failed));
});

test("configuration errors fail the action", async (t) => {
  const cwd = await repository(t, {});
  const core = fakeCore();
  assert.equal(await run({ core }, { cwd, blockedRegistries: "" }), null);
  assert.ok(
    core.messages.some((message) => message.failed?.includes("must contain"))
  );
});

test("counts all violations but limits annotations to 100", async (t) => {
  const cwd = await repository(t, {
    "yarn.lock": Array(101).fill(URL).join("\n")
  });
  const core = fakeCore();
  const result = await run({ core }, { cwd, blockedRegistries: BLOCKED });
  assert.equal(result.findings.length, 101);
  assert.equal(
    core.messages.filter((message) => message.annotation).length,
    100
  );
  assert.ok(core.messages.some((message) => message.failed?.includes("101")));
});
