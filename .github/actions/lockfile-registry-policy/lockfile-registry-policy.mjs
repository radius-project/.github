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

import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const FILENAMES = new Set([
  "package-lock.json",
  ".package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "package.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "pnpm-workspace.yaml",
  "deno.lock",
  "deno.json",
  "deno.jsonc",
  "pipfile.lock",
  "pipfile",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "pylock.toml",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "pip.conf",
  "pip.ini",
  ".pypirc",
  "poetry.toml",
  "pdm.toml",
  "uv.toml",
  "packages.lock.json",
  "project.lock.json",
  "packages.config",
  "nuget.config",
  "global.json",
  "paket.lock",
  "paket.dependencies",
  "cargo.lock",
  "cargo.toml",
  "gemfile.lock",
  "gemfile",
  "composer.lock",
  "composer.json",
  "gradle.lockfile",
  "pom.xml",
  "settings.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "pubspec.lock",
  "pubspec.yaml",
  "package.resolved",
  "package.swift",
  "podfile.lock",
  "podfile",
  ".terraform.lock.hcl"
]);

export function isPolicyFile(file) {
  const name = path.posix.basename(file).toLowerCase();
  return (
    FILENAMES.has(name) ||
    /^(requirements|constraints).*\.(txt|in|lock)$/.test(name) ||
    /(^|\/)(requirements|constraints)\/.*\.(txt|in|lock)$/i.test(file) ||
    /^pylock\..+\.toml$/.test(name) ||
    /^packages\..+\.lock\.json$/.test(name) ||
    /\.(csproj|fsproj|vbproj|props|targets|tf|tf\.json)$/.test(name) ||
    /(^|\/)\.cargo\/config(\.toml)?$/i.test(file) ||
    /(^|\/)\.bundle\/config$/i.test(file) ||
    /(^|\/)gradle\/dependency-locks\/[^/]+\.lockfile$/i.test(file)
  );
}

function globRegex(glob) {
  return new RegExp(
    `^${glob
      .split("")
      .map((character) => {
        if (character === "*") return ".*";
        if (character === "?") return ".";
        return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("")}$`
  );
}

export function compilePatterns(value) {
  if (typeof value !== "string") {
    throw new Error("blocked-registries must be a newline-separated string.");
  }
  const patterns = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!patterns.length) {
    throw new Error(
      "blocked-registries must contain at least one hostname or URL glob."
    );
  }
  return patterns.map((pattern, index) => {
    const urlPattern = pattern.includes("://");
    const parts =
      urlPattern ? /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(pattern) : null;
    const authority = urlPattern ? parts?.[2] : pattern;
    // Validate without echoing the input: a mistyped rule might contain a secret.
    if (
      !authority ||
      /\s|\\|#|@/.test(pattern) ||
      !/^[a-z0-9*?_-]+(?:\.[a-z0-9*?_-]+)*\.?(?::\d+)?$/i.test(authority) ||
      (!urlPattern && authority.includes(":"))
    ) {
      throw new Error(
        `Invalid blocked-registries rule ${index + 1}. Use a hostname or HTTP(S) URL glob without credentials, whitespace, or fragments.`
      );
    }
    const protocol = parts?.[1].toLowerCase();
    let host = authority.toLowerCase().replace(/\.(?=:|$)/, "");
    if (urlPattern) {
      host = host.replace(protocol === "https" ? /:443$/ : /:80$/, "");
    }
    const normalized =
      urlPattern ?
        `${protocol}://${host}${parts[3] || "/"}`
      : authority.toLowerCase().replace(/\.$/, "");
    return { index: index + 1, urlPattern, regex: globRegex(normalized) };
  });
}

function decodeReferences(line) {
  return (
    line
      .replace(
        /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\\//gi,
        (match, unicode, hex) =>
          match === "\\/" ? "/" : (
            String.fromCharCode(parseInt(unicode || hex, 16))
          )
      )
      .replace(
        /&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,
        (match, entity) => {
          const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
          if (!entity.startsWith("#")) return named[entity.toLowerCase()];
          const value =
            entity[1].toLowerCase() === "x" ?
              parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
          return value <= 0x10ffff ? String.fromCodePoint(value) : match;
        }
      )
      // Yarn encodes whole URLs in locators. Do not decode ordinary URL
      // userinfo here: an encoded slash in a password must not become a path.
      .replace(/https?%3a(?:%2f){2}[^\s"'<>`\\]+/gi, (url) =>
        url.replace(/%([0-7][0-9a-f])/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        )
      )
  );
}

export function scanText(file, text, patterns) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const decoded = decodeReferences(line);
    // The second alternative covers compact pnpm references and bare registry
    // hostnames. Scan only dependency files, not arbitrary source or prose.
    const references = decoded.matchAll(
      /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s"'<>`\\;]+|(?<![a-z0-9_.-])(?:[a-z0-9_-]+\.)+[a-z0-9_-]+(?::\d+)?(?:\/[^\s"'<>`\\;]*)?/gi
    );
    const seen = new Set();
    for (const [reference] of references) {
      const candidate = reference
        .replace(/[),;}\]]+$/, "")
        .replace(/^(git|registry|sparse)\+/i, "");
      let url;
      try {
        url = new URL(
          candidate.startsWith("//") ? `https:${candidate}`
          : candidate.includes("://") ? candidate
          : `https://${candidate}`
        );
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        // A variable-based authority is not a literal registry URL.
        // Still inspect literal hosts inside an otherwise unparseable token.
        const hosts = candidate.match(/(?:[a-z0-9_-]+\.)+[a-z0-9_-]+/gi) || [];
        for (const hostname of hosts) {
          const rule = patterns.find(
            (pattern) =>
              !pattern.urlPattern &&
              pattern.regex.test(hostname.toLowerCase().replace(/\.$/, ""))
          );
          if (rule && !seen.has(hostname.toLowerCase())) {
            findings.push({
              file,
              line: index + 1,
              hostname: hostname.toLowerCase(),
              rule: rule.index
            });
            seen.add(hostname.toLowerCase());
          }
        }
        continue;
      }
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      // Never retain userinfo, query strings, or fragments in findings or logs.
      const normalized = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
      const rule = patterns.find((pattern) =>
        pattern.regex.test(pattern.urlPattern ? normalized : hostname)
      );
      if (rule && !seen.has(hostname)) {
        findings.push({ file, line: index + 1, hostname, rule: rule.index });
        seen.add(hostname);
      }
    }
  }
  return findings;
}

function decodeFile(file, bytes) {
  if (path.posix.basename(file).toLowerCase() === "bun.lockb") {
    throw new Error(
      `${file}: binary Bun lockfiles cannot be checked. Migrate to the text bun.lock format.`
    );
  }
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
    : "utf-8";
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error(
      `${file}: cannot decode dependency file as UTF-8 or BOM-marked UTF-16.`
    );
  }
  if (text.includes("\0")) {
    throw new Error(`${file}: binary dependency files cannot be checked.`);
  }
  return text;
}

export async function scanRepository({ cwd, blockedRegistries }) {
  const patterns = compilePatterns(blockedRegistries);
  const root = await realpath(cwd);
  const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const files = [
    ...new Set(tracked.split("\0").filter((file) => file && isPolicyFile(file)))
  ].sort();
  const findings = [];
  for (const file of files) {
    const filename = path.resolve(root, file);
    const stat = await lstat(filename);
    const relative = path.relative(root, await realpath(filename));
    if (
      !stat.isFile() ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `${file}: dependency files must be regular files inside the checkout, not symlinks.`
      );
    }
    findings.push(
      ...scanText(file, decodeFile(file, await readFile(filename)), patterns)
    );
  }
  return { files, findings };
}

export default async function run({ core }, options) {
  try {
    const { files, findings } = await scanRepository(options);
    core.info(
      `Checked ${files.length} tracked dependency files; found ${findings.length} blocked registry references.`
    );
    for (const finding of findings.slice(0, 100)) {
      core.error(
        `Blocked registry ${finding.hostname} (rule ${finding.rule}). Replace the source and regenerate the lockfile.`,
        {
          file: finding.file,
          startLine: finding.line
        }
      );
    }
    await core.summary
      .addHeading("Lockfile registry policy")
      .addRaw(
        `Checked ${files.length} tracked lockfiles and package-source files. Found ${findings.length} blocked registry references.\n\n`
      )
      .addRaw(
        files.length ? "" : (
          "No supported dependency files are tracked in this repository.\n\n"
        )
      )
      .addRaw(
        findings.length > 100 ?
          "Only the first 100 findings are annotated.\n\n"
        : ""
      )
      .write();
    if (findings.length) {
      core.setFailed(
        `Found ${findings.length} blocked registry references. See the file annotations.`
      );
    }
    return { files, findings };
  } catch (error) {
    core.setFailed(`Lockfile registry policy could not run: ${error.message}`);
    return null;
  }
}
