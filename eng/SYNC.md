# Repository Files Sync

This document describes the centralized file synchronization used across the `radius-project` organization to maintain consistency and governance standards across all repositories.

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Overview](#overview)
  - [Key Benefits](#key-benefits)
- [Architecture](#architecture)
- [Directory Structure](#directory-structure)
- [How Sync Works](#how-sync-works)
  - [Trigger Conditions](#trigger-conditions)
  - [Sync Process](#sync-process)
  - [Authentication](#authentication)
- [Configuration Files](#configuration-files)
  - [`.github/sync.yml` - Sync Configuration](#githubsyncyml---sync-configuration)
- [Sync Templates](#sync-templates)
- [Workflow Templates](#workflow-templates)
  - [1. GitHub Workflow Templates (UI)](#1-github-workflow-templates-ui)
  - [2. Synced Workflows](#2-synced-workflows)
  - [Example Templates](#example-templates)
- [Reusable Workflows](#reusable-workflows)
  - [Naming Convention: `__` Prefix](#naming-convention-__-prefix)
  - [Examples](#examples)
  - [Workflow Relationship Diagram](#workflow-relationship-diagram)
  - [Usage Pattern](#usage-pattern)
  - [PR Author Assignment (Radius PoC)](#pr-author-assignment-radius-poc)
  - [PR Status Labels](#pr-status-labels)
  - [Labels](#labels)
  - [Signed Release Upmerge](#signed-release-upmerge)
- [Adding New Files to Sync](#adding-new-files-to-sync)
  - [Step 1: Add the Source File](#step-1-add-the-source-file)
  - [Step 2: Update Sync Configuration](#step-2-update-sync-configuration)
  - [Step 3: Commit and Push](#step-3-commit-and-push)
- [Target Repositories](#target-repositories)
- [Troubleshooting](#troubleshooting)
  - [Sync Not Triggering](#sync-not-triggering)
  - [PRs Not Created](#prs-not-created)
  - [File Not Appearing in Target Repo](#file-not-appearing-in-target-repo)
  - [Merge Conflicts](#merge-conflicts)
- [References](#references)

---

## Overview

The `.github` repository serves as the **Single Source of Truth** (SSoT) for organization-wide configurations, templates, and policies. It uses an automated synchronization to distribute common files (such as licenses, linter configs, workflows, etc) to all repositories in the `radius-project` organization.

### Key Benefits

- 🔄 **Consistency**: Ensures all repositories follow the same standards
- 🛡️ **Governance**: Centralized control over critical files like LICENSE
- ⚡ **Automation**: Changes automatically propagate via Pull Requests
- 📝 **Audit Trail**: All changes are tracked through Git history and PRs

---

## Architecture

```mermaid
flowchart TB
    subgraph central[".github Repository - Central Configuration Hub"]
        subgraph sources["Source Directories"]
            sync_templates["sync-templates/<br/>(static files)"]
            workflow_templates["workflow-templates/<br/>(workflow files)"]
        end

        sync_config[".github/sync.yml<br/>Sync Configuration"]
        sync_workflow[".github/workflows/sync.yml<br/>Sync Workflow"]

        sync_templates --> sync_config
        workflow_templates --> sync_config
        sync_config --> sync_workflow
    end

    sync_workflow -->|"Triggered on push to main<br/>(when sync-related files change)"| sync_action

    sync_action["raven-actions/repo-files-sync<br/>Creates PRs in target repositories"]

    sync_action --> repo_a["org/repo-a"]
    sync_action --> repo_b["org/repo-b"]
    sync_action --> repo_c["org/repo-c"]
    sync_action --> repo_n["... (N repos)"]
```

---

## Directory Structure

```text
.github/
├── .github/                             # GitHub-specific configurations for THIS repo
│   ├── sync.yml                         # ⚙️ SYNC CONFIGURATION FILE
│   ├── actions/                         # Shared actions used by reusable workflows
│   └── workflows/
│       ├── sync.yml                     # ⚙️ SYNC WORKFLOW
│       └── __<workflow-name>.yml        # Reusable workflows (prefixed with __)
│
├── sync-templates/                      # 📁 Static files and nunjucks templates to sync
│   ├── <static-file>                    # Files synced as-is (no transformation)
│   └── <template-file>.njk              # Nunjucks templates (rendered before sync)
│
├── workflow-templates/                  # 📁 GitHub Actions workflow templates
│   ├── README.md                        # Documentation for workflow templates
│   ├── <template-name>.yml              # Workflow template file
│   └── <template-name>.properties.json  # Template metadata
│
└── eng/                                 # 📁 Engineering documentation
    └── SYNC.md                          # This file
```

---

## How Sync Works

### Trigger Conditions

The sync workflow (`.github/workflows/sync.yml`) is triggered when:

1. Code is pushed to the `main` branch
1. **AND** changes are made to any of these paths:
   - `.github/workflows/sync.yml` (the workflow itself)
   - `.github/sync.yml` (sync configuration)
   - `sync-templates/**` (any file in sync-templates)
   - `workflow-templates/*.yaml` or `workflow-templates/*.yml`

### Sync Process

1. **Checkout**: The workflow checks out the `.github` repository
1. **Authentication**: Obtains a GitHub App token with permissions for:
   - `metadata: read`
   - `contents: write`
   - `pull-requests: write`
   - `workflows: write`
1. **Bot Identity**: Retrieves bot details for commit attribution
1. **File Sync**: Uses [raven-actions/repo-files-sync](https://github.com/raven-actions/repo-files-sync) to:
   - Read the sync configuration from `.github/sync.yml`
   - Create branches (prefixed with `repo-sync`) in target repos
   - Copy files from source to destination paths
   - Open Pull Requests with commit messages prefixed with `chore:`

### Authentication

The sync uses a **GitHub App** for authentication (configured via secrets):

- `FILES_SYNC_BOT_APP_ID`: The GitHub App ID
- `FILES_SYNC_BOT_PRIVATE_KEY`: The GitHub App private key

This approach provides:

- Fine-grained permissions
- Better audit trails
- No dependency on personal access tokens

---

## Configuration Files

### `.github/sync.yml` - Sync Configuration

This is the heart of the sync. It defines:

- **Target repositories** (in the `repos` section)
- **File mappings** (source → destination)

```yaml
group:
  repos: |
    radius-project/.github
    radius-project/repo-a
    radius-project/repo-b@custom-branch   # Can specify different branches
    # ... more repos

  files:
    - source: sync-templates/LICENSE
      dest: LICENSE

    - source: sync-templates/.gitattributes
      dest: .gitattributes

    - source: workflow-templates/<template-name>.yml
      dest: .github/workflows/<template-name>.yml
```

**Key Features:**

- Uses [nunjucks templating](https://mozilla.github.io/nunjucks/templating.html) for advanced configurations
- Supports branch specification with `@branch` syntax
- Supports directory patterns and exclusions

---

## Sync Templates

The `sync-templates/` directory contains files that are synchronized **as-is** to target repositories. These are static files that should be identical across all repositories in the organization.

**Common use cases:**

- License files (e.g., `LICENSE`)
- Editor configuration files (e.g., `.editorconfig`)
- Git configuration files (e.g., `.gitattributes`)
- Code of conduct, contributing guidelines
- Any other file that should be standardized across repositories

Files placed in this directory are copied directly to the destination path specified in the sync configuration, without any transformation or templating.

---

## Workflow Templates

Files in `workflow-templates/` serve **two purposes**:

### 1. GitHub Workflow Templates (UI)

When developers create new workflows in any organization repository, they see these templates in the GitHub Actions UI. Each template requires:

- `<template-name>.yml` - The workflow file
- `<template-name>.properties.json` - Metadata (name, description, icon, categories)

**Example properties file:**

```json
{
  "name": "Example Workflow",
  "description": "Description of what this workflow does.",
  "iconName": "icon-name",
  "categories": ["category-1", "category-2"],
  "filePatterns": []
}
```

### 2. Synced Workflows

The same workflow files are synced to repositories via the sync, ensuring all repos have the workflow automatically.

### Example Templates

| Template                | Description                               |
|-------------------------|-------------------------------------------|
| `dependency-review.yml` | Scans PR dependencies for vulnerabilities |
| `lint.yml`              | Runs linting checks on code changes       |
| `ci.yml`                | Continuous integration workflow           |

---

## Reusable Workflows

### Naming Convention: `__` Prefix

Files in `.github/workflows/` that are intended to be **reusable workflows** (callable by other repositories) **MUST** be prefixed with double underscores (`__`).

**Why this convention?**

- 🔍 **Visual Distinction**: Easily identify which workflows are reusable vs. internal
- 📂 **Sorting**: `__` prefixed files appear at the top of directory listings
- 🔒 **Safety**: Prevents accidental modification of shared workflows
- 📖 **Documentation**: Self-documenting naming convention

**Naming pattern:** `__<workflow-name>.yml`

### Examples

| Workflow                  | Description                                   |
|---------------------------|-----------------------------------------------|
| `__dependency-review.yml` | Runs dependency scanning with standard config |
| `__lint.yml`              | Shared linting workflow                       |
| `__build.yml`             | Shared build workflow                         |
| `__pr-author.yml`         | Assigns unassigned human PRs to their author  |
| `__pr-status-labels.yml`  | Applies PR lifecycle labels                   |
| `__pr-holds.yml`          | Fails when a PR carries a manual hold label   |
| `__labels.yml`            | Applies a repository's synced labels file     |
| `__upmerge.yml`           | Creates signed release-to-edge net-diff PRs    |

### Workflow Relationship Diagram

```mermaid
flowchart LR
    subgraph central[".github Repository"]
        reusable["__example-workflow.yml<br/>(Reusable Workflow)"]
        template["workflow-templates/<br/>example-workflow.yml<br/>(Template - calls reusable)"]
    end

    subgraph target["Target Repository"]
        synced[".github/workflows/<br/>example-workflow.yml<br/>(Synced from template)"]
    end

    template -->|"Synced via<br/>repo-file-sync-action"| synced
    synced -->|"uses: org/.github/...<br/>__example-workflow.yml@main"| reusable
```

### Usage Pattern

Target repositories call reusable workflows instead of duplicating logic:

```yaml
# In target repository (synced from workflow-templates/)
jobs:
  example-job:
    uses: radius-project/.github/.github/workflows/__example-workflow.yml@main
    permissions:
      contents: read
      pull-requests: write
```

### PR Author Assignment (Radius PoC)

PR author assignment is maintained in [the reusable master workflow](../.github/workflows/__pr-author.yml) and exposed through [a thin caller template](../workflow-templates/pr-author.yml). Its matching `pr-author.properties.json` metadata makes the template discoverable in the organization's GitHub Actions UI without automatically enrolling other repositories.

On `opened` and `reopened`, the workflow assigns a human author only when the live PR is open and has no assignees. Bot-authored, closed, and already-assigned PRs are skipped. Existing assignees are never replaced. API errors and ignored assignment requests fail the run instead of silently succeeding.

The caller uses `pull_request_target` to support fork PRs. This automation is **metadata-only**: never add PR checkout, PR code execution, or untrusted PR artifacts. The caller and master grant only `pull-requests: write`, and no custom secrets are required. The externally sourced action is pinned to a full commit SHA.

The dedicated PR-author group in `.github/sync.yml` initially enrolls **only `radius-project/radius`**. After the central change merges into `main`, the existing Sync workflow opens a downstream PR that adds `.github/workflows/pr-author.yml` to Radius. Merge that sync PR to activate the workflow. Other repositories, including `.github` itself, are not automatically enrolled. Existing open PRs are not backfilled; the workflow handles new or reopened PRs after activation.

To expand the rollout later, add approved repository names to the dedicated PR-author group rather than adding this mapping to the all-repository group. The caller follows the existing organization convention of referencing `__pr-author.yml@main`, so shared logic updates reach enrolled repositories without copying the implementation.

### PR Status Labels

PR lifecycle labeling is maintained in [the PR Status Labels action](../.github/actions/pr-status-labels/README.md) and [its reusable workflow](../.github/workflows/__pr-status-labels.yml), which loads the action from the same commit with the `$/` self-repository syntax. Three thin caller templates are synced together: [`pr-status-labels.yml`](../workflow-templates/pr-status-labels.yml), the read-only [`pr-review-signal.yml`](../workflow-templates/pr-review-signal.yml) relay, and [`labels.yml`](../workflow-templates/labels.yml), which applies the repository's centrally managed `.github/labels.yml` (see [Labels](#labels)).

The dedicated PR status labels group in `.github/sync.yml` enrolls **`radius-project/.github`, `ai-extensions`, `dashboard`, `docs@edge`, `lab`, `radius`, `recipes`, `resource-types-contrib`, and `website`**. Add a repository to that group only after its own lifecycle-label workflows are removed, so only one writer updates its labels. See [Opting a repository in](../.github/actions/pr-status-labels/README.md#opting-a-repository-in).

`docs` is synced to `edge`, which is not its default branch. PRs into `edge` are labeled as soon as the sync pull request merges, but scheduled reconciliation, review-triggered updates, and the label sync run only from the default branch, so they start once the next release branch is cut from `edge`. See [Limitations](../.github/actions/pr-status-labels/README.md#limitations).

The release-impact check (`PR Required Labels`) is Radius-only and is not part of this group.

### Labels

Label definitions are managed only in this repository and synced to `.github/labels.yml` in every repository of the PR status labels group:

- [`sync-templates/.github/labels.yml.njk`](../sync-templates/.github/labels.yml.njk) defines the shared labels, currently the PR lifecycle and manual hold labels.
- The `repo_labels` template variable of that group in `.github/sync.yml` adds repository-specific labels, keyed by repository name. The template header documents the label options. List a newly enrolled repository's existing `pr:` labels there unchanged so the sync does not alter them.

Repositories must not edit their synced `.github/labels.yml`; change the template or `repo_labels` instead, and the Sync workflow opens a pull request with the rendered file. When that pull request merges, the synced `Labels` workflow applies the file with `skip-delete`, so labels the file does not list are preserved. The workflow also reverts manual edits to the labels the file defines. Renaming lifecycle labels through the `PR_STATUS_LABELS` variable needs matching definitions in `repo_labels`, each with `from_name` set to the old name. See [Label catalog](../.github/actions/pr-status-labels/README.md#label-catalog).

### Signed Release Upmerge

Release upmerge logic lives inline in [`__upmerge.yml`](../.github/workflows/__upmerge.yml). Only the [thin Nunjucks caller](../sync-templates/.github/workflows/upmerge.yaml.njk) is synced, to **`.github/workflows/upmerge.yaml`**; the release coordinator depends on that filename and the inner step name **`Create pull request`**. Implementation and fixture tests are never copied into consumer repositories.

The dedicated mappings in `.github/sync.yml` enroll only **`radius-project/docs@edge`** and **`radius-project/samples@edge`**. Each mapping declares `template.preserve_paths`: docs preserves `docs/config.toml` and `docs/layouts/partials/hooks/body-end.html`; samples preserves `bicepconfig.json`. Change the shared workflow, template or mapping here, not the generated caller downstream.

| Caller parameter | Contract |
| --- | --- |
| `preserve-paths` input | Required newline-delimited list of literal repository-relative file paths. Use `/` separators; blank lines and CRLF lists are accepted. Absolute paths, traversal, `.git` components, backslashes, pathspec prefixes and directories are rejected. Files retain their edge state, including absence or deletion. |
| `RADIUS_RELEASE_BOT_CLIENT_ID` secret | Required release GitHub App client ID, passed explicitly by the caller. |
| `RADIUS_RELEASE_BOT_PRIVATE_KEY` secret | Required release GitHub App private key, passed explicitly by the caller. |

Callers expose only `workflow_dispatch` and grant the reusable job `contents: read`. The App installation must already have Contents, Pull requests and Workflows write access to the caller repository. Its short-lived token is scoped to that repository only; it needs no installation on `.github`. No new grants or secrets are provisioned by the workflow.

The workflow uses the caller's repository, ref and immutable `github.sha`, checks out edge, and prepares a native Git squash without importing source ancestry. The pinned create-pull-request action publishes one App-signed net-diff commit with an explicit App DCO trailer. Only the preparation step receives a committer identity; the signing action's author and committer are not overridden. The native `pull-request-commits-verified` output and returned PR details must confirm publication.

A clean merge preserves both branches' changes. Conflicts confined to preserved files are resolved using edge's state without discarding other merged content. Other content conflicts produce an explicitly provisional **draft source snapshot**, which may omit edge-only changes and requires manual reconciliation. Unrelated Git failures, or conflicts producing no reviewable diff, fail the run. A genuine no-op **skips `Create pull request`**, so the coordinator does not discover an old or empty PR. Review and branch rules still apply.

Callers follow the organization's `@main` convention: new runs receive shared logic updates without another caller sync. The source commit still comes from the caller's recorded execution. [GitHub's rerun rules](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs) distinguish rerunning failed/specific jobs, which reuse the original shared commit, from rerunning all jobs, which resolves `@main` again. Historical inline runs do not adopt the new caller by retrying; recorded release receipts are not rewritten.

Initial rollout, while both consumer defaults are `v0.61`:

1. Merge the shared `.github` change into `main` first, after its read-only checks pass.
1. Bootstrap the rendered callers into `v0.61` through [radius-project/docs#2058](https://github.com/radius-project/docs/pull/2058) and [radius-project/samples#2705](https://github.com/radius-project/samples/pull/2705), removing the duplicated logic and tests in those consumer PRs.
1. Review and merge the normal Sync PRs delivering callers to `edge`. Ongoing caller updates stay enrolled only on edge; future release branches inherit them when cut. Do not add permanent sync mappings for old release branches.

The dependency-free [native Git fixtures](../.github/tests/upmerge.test.mjs) run with `node --test .github/tests/upmerge.test.mjs` (Node.js, Git and Bash required). They execute the actual YAML run blocks for both preserved-path lists. [Caller contract tests](../.github/tests/upmerge-callers.test.cjs) use real Nunjucks rendering with the pinned sync action's options and parse the resulting YAML. The existing [Test Actions workflow](../.github/workflows/test-actions.yml) runs both suites on relevant PRs using read-only permissions, with pinned rendering dependencies installed only in runner temporary storage. Tests use no App secrets and perform no live GitHub writes or workflow dispatches.

---

## Adding New Files to Sync

### Step 1: Add the Source File

Place the file in the appropriate directory:

- **Static files** (LICENSE, configs) → `sync-templates/`
- **Workflows** → `workflow-templates/`

### Step 2: Update Sync Configuration

Edit `.github/sync.yml` to add the new file mapping:

```yaml
files:
  # Existing files...

  - source: sync-templates/NEW_FILE
    dest: NEW_FILE
```

### Step 3: Commit and Push

Push to `main` branch. The sync workflow will automatically:

1. Detect the change
1. Create PRs in all target repositories

---

## Target Repositories

The sync targets repositories defined in `.github/sync.yml`. Example structure:

| Repository                    | Branch   | Notes                        |
|-------------------------------|----------|------------------------------|
| `radius-project/.github`      | main     | This repository (self-sync)  |
| `radius-project/main-project` | main     | Main project repository      |
| `radius-project/docs`         | **edge** | Custom branch example        |
| `radius-project/website`      | main     |                              |
| `radius-project/samples`      | **edge** | Custom branch example        |
| ...                           | ...      | Add all repositories to sync |

> **Note:** Use `@branch` syntax in `sync.yml` to specify non-default branches (e.g., `radius-project/docs@edge`).

---

## Troubleshooting

### Sync Not Triggering

1. Verify you pushed to `main` branch
1. Check that changed files match the path filters in `sync.yml`
1. Review Actions tab for workflow runs

### PRs Not Created

1. Check GitHub App permissions
1. Verify secrets `FILES_SYNC_BOT_APP_ID` and `FILES_SYNC_BOT_PRIVATE_KEY` are set
1. Review sync workflow logs for errors

### File Not Appearing in Target Repo

1. Verify file mapping in `.github/sync.yml`
1. Check if the file already exists (sync may skip or require manual merge)
1. Look for open PRs from the sync bot

### Merge Conflicts

The sync action creates PRs, not direct commits. If conflicts occur:

1. Review the PR in the target repository
1. Resolve conflicts manually
1. Merge the PR

---

## References

- [raven-actions/repo-files-sync](https://github.com/raven-actions/repo-files-sync) - The sync action used
- [Creating workflow templates](https://docs.github.com/en/actions/how-tos/reuse-automations/create-workflow-templates) - GitHub docs
- [Reusable workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows) - GitHub docs
- [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps) - Authentication method
