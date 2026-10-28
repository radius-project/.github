# Lockfile registry policy

The [reusable workflow](../../workflows/__lockfile-registry-policy.yml) rejects unwanted registry URLs in tracked lockfiles and package-source configuration. It checks the entire checkout, including nested projects, on pull requests, merge queues, pushes, and manual runs. Findings include file and line annotations, fail the check, and never print URL credentials, query strings, or source lines.

The default blocked hostnames are:

```text
*.pkgs.visualstudio.com
pkgs.dev.azure.com
```

The check is read-only. It does not install dependencies, restore packages, run package managers, evaluate build scripts, contact registries, or require secrets. The checked-out repository is treated as data; the action is loaded from the same commit as the reusable workflow using `$/`. The caller uses `pull_request`, not `pull_request_target`, and needs only `contents: read`.

## Configuration

The effective list is selected in this order:

1. A nonempty `LOCKFILE_BLOCKED_REGISTRIES` Actions configuration variable visible to the target repository.
1. The reusable workflow's `blocked-registries` input.
1. The default list in the reusable workflow.

To override policy for a target repository, set **Settings > Secrets and variables > Actions > Variables > New repository variable**, with the name `LOCKFILE_BLOCKED_REGISTRIES`. Organization-level Actions variables are also supported; a repository variable takes precedence over an organization variable with the same name.

Use one pattern per line, not a JSON or YAML array:

```text
*.pkgs.visualstudio.com
pkgs.dev.azure.com
https://registry.example.com/private/*
mirror?.example.net
```

An override **replaces** the complete list; include the organization defaults if they should remain blocked. An unset or empty variable falls back to the workflow input/default. A whitespace-only or comments-only list is invalid and fails the check. Blank lines and lines beginning with `#` are ignored. There is no implicit allow-list or empty-list bypass.

For callers not managed by synchronization, the input can be supplied directly:

```yaml
jobs:
  registry-policy:
    uses: radius-project/.github/.github/workflows/__lockfile-registry-policy.yml@main
    permissions:
      contents: read
    with:
      blocked-registries: |
        *.pkgs.visualstudio.com
        pkgs.dev.azure.com
        registry.example.com
```

Do not edit the synced caller for per-repository configuration; the next sync would overwrite it. Repository variables survive synchronization. This is an overridable policy check, not an immutable organization enforcement boundary. Protect repository settings and workflow changes, and configure a required status check in repository rulesets if merges must be blocked.

### Glob semantics

- `*` matches zero or more characters, including dots in hostnames and slashes in paths. `?` matches exactly one character. Brace expansion, character classes, negation, and backslash escaping are not supported.
- A hostname pattern matches the **entire hostname**, case-insensitively, regardless of scheme, credentials, port, or path. `*.pkgs.visualstudio.com` matches nested subdomains but not the apex `pkgs.visualstudio.com`.
- An HTTP(S) URL pattern matches the full normalized scheme, hostname, optional non-default port, and case-sensitive path. Use `https://host.example/*` to match all paths; `https://host.example/` only matches the root path. Credentials, query strings, and fragments are not matched.
- Hostname suffix lookalikes and a blocked hostname appearing only in another URL's path or query are not blocked. Trailing DNS dots and default HTTP(S) ports are normalized.
- JSON escaped slashes/characters, XML entities, and ASCII percent-encoded references are decoded before scanning. Bare hostnames, protocol-relative URLs, and compact pnpm registry paths are checked too.

## Supported files

The scanner uses tracked Git files at every depth, including dot directories, with case-insensitive filename selection. It deliberately does not ignore tracked vendor directories, examples, or fixtures. Ordinary source files and documentation are not scanned, apart from the package/build files listed below. No matching files is an explicit successful result.

| Ecosystem | Lockfiles and package-source configuration |
|-----------|-------------------------------------------|
| JavaScript / TypeScript | `package-lock.json`, `.package-lock.json`, `npm-shrinkwrap.json`, Yarn Classic/Berry `yarn.lock`, `pnpm-lock.yaml`, text `bun.lock`, `deno.lock`; `package.json`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, `deno.json`, `deno.jsonc` |
| Python | `Pipfile.lock`, `poetry.lock`, `pdm.lock`, `uv.lock`, `pylock.toml`, `pylock.*.toml`; `requirements*`/`constraints*` files ending in `.txt`, `.in`, or `.lock` (also those extensions under `requirements/` and `constraints/`); `Pipfile`, `pyproject.toml`, `setup.cfg`, `setup.py`, `pip.conf`, `pip.ini`, `.pypirc`, `poetry.toml`, `pdm.toml`, `uv.toml` |
| .NET / NuGet / Paket | `packages.lock.json`, `packages.*.lock.json`, `project.lock.json`, `paket.lock`; `NuGet.Config`, `packages.config`, `*.csproj`, `*.fsproj`, `*.vbproj`, `*.props`, `*.targets`, `global.json`, `paket.dependencies` |
| Rust | `Cargo.lock`, `Cargo.toml`, `.cargo/config`, `.cargo/config.toml` |
| Ruby | `Gemfile.lock`, `Gemfile`, `.bundle/config` |
| PHP | `composer.lock`, `composer.json` |
| Java / Kotlin | `gradle.lockfile`, `gradle/dependency-locks/*.lockfile`; `pom.xml`, `settings.xml`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`, `gradle.properties` |
| Go | `go.mod`, `go.sum`, `go.work`, `go.work.sum` |
| Dart / Flutter | `pubspec.lock`, `pubspec.yaml` |
| Swift / CocoaPods | `Package.resolved`, `Package.swift`, `Podfile.lock`, `Podfile` |
| Terraform / OpenTofu | `.terraform.lock.hcl`, `*.tf`, `*.tf.json` |

This is a literal source-reference policy, **not** lockfile schema, integrity, or dependency-resolution validation. It conservatively checks all literal references in these files, including comments and unused sources. NuGet lockfiles, Go sums, modern Yarn entries, and Gradle locks may not record the registry at all; package-source files provide additional coverage, not proof of which server a restore would use.

User/machine configuration, environment-variable expansion, computed URLs, included files with nonstandard names, redirects, generated/untracked files, Git submodules, and sources omitted from committed files are outside the check. It cannot determine an effective registry that is absent from the repository. Add new filename support centrally in `isPolicyFile` with regression coverage when another format is needed.

Files must be UTF-8 or BOM-marked UTF-16. Matching symlinks, unreadable files, invalid encoding, and binary files fail rather than being silently skipped. Legacy `bun.lockb` must be migrated to text `bun.lock` before this check can pass; the scanner does not execute Bun to decode untrusted binaries.

## Organization rollout

The existing [Sync workflow](../../workflows/sync.yml) distributes the caller through the lockfile registry policy group in [`.github/sync.yml`](../../sync.yml). That group lists all currently unarchived repositories in `radius-project`, including public, private, and internal repositories. Maintain the list when repositories are added or archived, following the existing sync configuration pattern. Changes to the caller or sync configuration trigger the normal Sync workflow when pushed to `main`; no separate sync workflow or discovery script is used.

Only [`workflow-templates/lockfile-registry-policy.yml`](../../../workflow-templates/lockfile-registry-policy.yml) is distributed, to `.github/workflows/lockfile-registry-policy.yml`. The implementation and tests stay here. The caller is delivered through the existing sync pull requests and `repo-sync` branch prefix; nothing is auto-merged. Following existing organization conventions, `docs` and `samples` target `edge`, and all other repositories target their default branch. These two repositories gain manual dispatch on their default branch after it inherits the caller.

Merge the central implementation into `main` before merging downstream sync PRs, because callers reference `@main`. This repository receives its own caller through the same sync after the central merge, avoiding an unresolved reusable-workflow reference during bootstrap. The existing Test Actions workflow exercises the implementation on feature branches independently.

The existing `FILES_SYNC_BOT_CLIENT_ID` and `FILES_SYNC_BOT_PRIVATE_KEY` secrets are reused. The App must have access to every listed repository, with Metadata read and Contents, Pull requests, and Workflows write permissions. Repositories outside the installation's access cannot be updated; initialize empty repositories and enable Actions where necessary. Remove archived repositories from the group to stop targeting them; existing files are not removed from them.

## Development

The scanner has no third-party runtime dependencies. Run its tests with Node.js and Git:

```sh
node --test .github/actions/lockfile-registry-policy/*.test.mjs
```

The existing Test Actions workflow includes these tests via `node --test .github/actions/*/*.test.mjs`. Tests cover package formats, hostname boundaries, wildcard overrides, encodings, credential-safe annotations, tracked-file discovery, and error paths. File-symlink coverage runs on Linux; the directory-containment check also runs on Windows.
