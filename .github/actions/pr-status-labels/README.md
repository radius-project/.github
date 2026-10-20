# PR Status Labels

Shared automation that keeps one lifecycle (handoff) label on every open, non-draft pull request so contributors and maintainers can see who owns the next action. It also flags merge conflicts and queue readiness, removes held pull requests from the merge queue, and provides a merge-hold check for a repository's required status check.

The logic lives once in this repository. Other repositories in the organization opt in with thin, synced caller workflows, so the behavior is never copied between repositories.

- [Components](#components)
- [Handoff labels](#handoff-labels)
- [Configuration](#configuration)
- [Opting a repository in](#opting-a-repository-in)
- [Hold check](#hold-check)
- [Label catalog](#label-catalog)
- [Limitations](#limitations)
- [Trust model](#trust-model)

## Components

| Path | Purpose |
| ---- | ------- |
| [`.github/actions/pr-status-labels/`](./action.yml) | Composite action holding the reconciler script and the default label names in [`labels.json`](./labels.json). Supports `reconcile` and `check-holds` modes. |
| [`.github/workflows/__pr-status-labels.yml`](../../workflows/__pr-status-labels.yml) | Reusable workflow holding the writer job, its permissions, and its run filter. Loads the action with `$/` at the same commit. |
| [`.github/workflows/__pr-holds.yml`](../../workflows/__pr-holds.yml) | Reusable workflow that runs the [hold check](#hold-check) with no token permissions. Loads the action with `$/` at the same commit. |
| [`workflow-templates/pr-status-labels.yml`](../../../workflow-templates/pr-status-labels.yml) | Caller (`PR Status Labels`) with the triggers and the repository-wide concurrency group. |
| [`workflow-templates/pr-review-signal.yml`](../../../workflow-templates/pr-review-signal.yml) | Read-only relay (`PR Review Signal`) for review and inline-comment events. |
| [`sync-templates/.github/labels.yml.njk`](../../../sync-templates/.github/labels.yml.njk) | Central definitions (colors and descriptions) of the lifecycle and hold labels, synced with any repository-specific labels to each enrolled repository's `.github/labels.yml`. See [Label catalog](#label-catalog). |
| [`.github/workflows/__labels.yml`](../../workflows/__labels.yml), [`workflow-templates/labels.yml`](../../../workflow-templates/labels.yml) | Label sync (`Labels`) that applies the synced `.github/labels.yml` without deleting other labels. |

### Action interface

| Input | Default | Description |
| ----- | ------- | ----------- |
| `mode` | `reconcile` | `reconcile` updates lifecycle labels for the triggering event. `check-holds` fails when the pull request carries a manual hold label. |
| `labels` | `""` | Optional JSON object that overrides default label names. See [Configuration](#configuration). |
| `pr-number` | `""` | Pull request to reconcile on `workflow_dispatch`. Empty reconciles every open pull request. Ignored for other events. |
| `review-signal-workflow` | `PR Review Signal` | Name of the read-only relay. Other `workflow_run` events are ignored. |
| `github-token` | `${{ github.token }}` | Token for GitHub API calls. |

| Output | Description |
| ------ | ----------- |
| `labels` | Validated label-name mapping as JSON, with `states` and `manual` sections. |
| `holds` | JSON array of manual hold labels found on the pull request. Set only in `check-holds` mode. |

The reusable workflow accepts `pr-number`, `labels`, and `review-signal-workflow` inputs with the same meaning. It requires the caller to grant `contents: read`, `issues: write`, and `pull-requests: write`.

## Handoff labels

The PR Status Labels workflow applies these **handoff labels** to open, non-draft pull requests. Exactly one applies unless the PR is on hold. These are the default names; maintainers can [change the names](#configuration) without changing the status signals:

- **`pr:needs-reviewer`** — there is neither a pending reviewer or team request nor an active submitted human review from someone other than the author.
- **`pr:waiting-for-review`** — a reviewer or team has a pending request, or a human has submitted a review but required approval is still outstanding or cannot be verified. Outstanding human inline feedback or formal change requests hand the PR back after the author pushes a new commit or comments after the latest outstanding feedback, or after a newer, still-pending re-request to each reviewer responsible for that feedback.
- **`pr:waiting-for-author`** — an unresolved review thread from a blocking bot reviewer such as Copilot, a manual author-response request, or human feedback the author has not yet responded to needs action. Human feedback means unresolved human-reviewer inline feedback, inline feedback endorsed by a human approval summary, or a formal changes-requested review.
- **`pr:review-approved`** — required reviews are approved and no qualifying unresolved inline feedback remains; this does not mean checks have passed.

An unresolved review thread that contains a submitted comment from a blocking bot reviewer keeps the PR waiting for the author until every such thread is resolved. Approvals, author pushes or comments, and re-requests do not hand it back, and it blocks the approved and queue-ready labels. Resolve each such thread after addressing it or deciding not to act on it. The blocking bot reviewers are listed in `BLOCKING_BOT_REVIEWERS` in the [status script](./pr-status-labels.mjs). The list currently contains only the Copilot pull request reviewer (`copilot-pull-request-reviewer`). To add another bot, append its lowercase GraphQL Bot login, without the REST `[bot]` suffix. The change applies to every enrolled repository.

An unresolved inline thread containing a submitted comment from a human reviewer other than the PR author normally requires author action. The author hands the PR back to reviewers, without resolving or dismissing the feedback, by pushing a new commit or commenting after the latest outstanding human feedback. Comments include PR conversation comments, review-thread replies, and the author's own submitted reviews, compared by GitHub's server-side creation or submission time. GitHub records no trustworthy time for ordinary pushes, so a push counts when the PR's current head differs from the commit that the most recently submitted outstanding feedback was submitted on, regardless of who pushed it. That feedback includes subsequent submitted reviews from a reviewer with outstanding feedback. Force-pushing back to an earlier commit also counts, unless it is that commit. When GitHub does not report that commit, only comments count. The PR stays with the author while the most recently submitted outstanding feedback was submitted on the current head and the latest outstanding feedback, including comment edits, is newer than the author's latest comment.

Alternatively, a later explicit re-request to each reviewer with outstanding feedback transfers the handoff to reviewers while it remains pending. The workflow compares the complete request history with the currently pending reviewers, ignoring login case. Each reviewer with outstanding feedback needs a request newer than their latest qualifying feedback, including comment edits and subsequent submitted reviews; an initial or earlier request, a removed request, or a request to an unrelated reviewer does not count. A team request alone does not identify which individual should re-review outstanding feedback; request those reviewers directly. Newer feedback returns the turn to the author. Neither an author response nor a re-request can restore approval or queue readiness while qualifying unresolved feedback remains.

Unendorsed comments from bots that are not blocking bot reviewers, author-only notes, reviews that are pending, not yet submitted, or dismissed, deleted feedback, and general top-level discussion do not qualify as feedback. Author responses hand the turn back without resolving threads, and a thread becoming outdated does not resolve it. Once all qualifying threads are resolved or their qualifying feedback is deleted or dismissed, the workflow recomputes the normal review state: pending requests return the turn to reviewers, approvals can restore approval and queue-ready labels, and an outstanding formal changes-requested review still needs an author response or an explicit re-request.

A human reviewer's latest submitted opinionated review also endorses existing inline feedback when it approves the current head, has a nonempty summary, and has not been dismissed. This conservative, deterministic rule counts unresolved submitted feedback, including bot comments, only if both the comment's creation and its review's submission were at or before that approval. It checks summary emptiness, not wording; it uses no language classifier. Empty summaries, stale approvals, and bot comments posted or submitted after the approval do not establish this handoff. For endorsed bot feedback, comment after the approval or re-request review from each endorsing human, not from the bot, to transfer the handoff; a push makes the approval stale, which also removes the endorsement. An approval summary without qualifying unresolved threads does not request author action, and general issue comments never establish it.

Submitted review evidence establishes who has participated, not whether merging is allowed. Required approvals, CODEOWNER review, and last-push approval safeguards apply to the PR's actual target branch, including stacked targets. When GitHub reports no aggregate review decision for a ruleset-protected branch, the workflow infers approval only when enough reviewers with write access approved the current head and, if the ruleset requires it, a CODEOWNER team approved, based on `.github/CODEOWNERS` at the base commit. It does not infer approval when the ruleset names specific required reviewers or requires approval of the most recent push. If approval cannot be safely established, an active submitted human review keeps the PR waiting for review rather than requesting a new reviewer; qualifying author feedback takes precedence until handed back. An outstanding changes-requested review from a human other than the author takes precedence regardless of target protection or GitHub's aggregate review decision. Like inline feedback, an outstanding change request hands the PR back when the author pushes or comments after it, or when each requesting reviewer has a later, currently pending re-request. Once the author has responded, GitHub's aggregate changes-requested decision alone does not keep the PR waiting for the author, but it still blocks the approved and queue-ready labels. If GitHub reports changes requested but no human change request can be identified, the PR stays waiting for the author. Dismissing the review or superseding it with an approval clears that review's change request; an author response or re-request only hands the turn back.

The workflow also adds **`pr:needs-rebase`** when the PR has merge conflicts, and **`pr:ready-for-queue`** when review is approved, the PR is mergeable, required checks pass, and it is not already queued. A branch that is behind its base branch can still be queue-ready once its required checks pass; the merge queue handles the branch update. In a repository without a merge queue, the label means the PR is ready to merge, although a branch that is behind may need an update first if the target branch requires it. These labels are signals, not substitutes for GitHub's merge rules or the merge queue.

The status workflow does not provision label definitions; the [label catalog](#label-catalog) sync does. Unrelated repository labels are preserved.

Draft PRs have no handoff label. Maintainers can apply **`pr:do-not-merge`** to pause a PR; it removes the handoff and queue-ready labels. Use **`pr:needs-author-response`** for an explicit author-response request, including actionable general discussion outside inline review threads, then remove it after the author responds; it sets the handoff to `pr:waiting-for-author`. The workflow never applies or removes these manual labels. Both manual labels fail the [hold check](#hold-check) and remove a PR from the merge queue if it was already queued.

The reconciler and the hold check use the same hold matching. Each manual hold matches its configured name and its default name, ignoring case, so a renamed hold, a run without the override, or a differently cased label such as `PR:DO-NOT-MERGE` still holds the PR. A default name that is configured for another label keeps only its configured meaning.

## Configuration

### Label names

[`labels.json`](./labels.json) holds the default label names:

```json
{
  "states": {
    "needsReviewer": "pr:needs-reviewer",
    "waitingForReview": "pr:waiting-for-review",
    "waitingForAuthor": "pr:waiting-for-author",
    "reviewApproved": "pr:review-approved",
    "needsRebase": "pr:needs-rebase",
    "readyForQueue": "pr:ready-for-queue"
  },
  "manual": {
    "needsAuthorResponse": "pr:needs-author-response",
    "doNotMerge": "pr:do-not-merge"
  }
}
```

The keys identify the status signals supported by the code. Only `states` labels are applied or removed automatically; the two `manual` labels remain maintainer-controlled holds.

To rename labels in one repository, or for the whole organization, set a repository or organization [configuration variable](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables) named `PR_STATUS_LABELS`. The synced caller passes it to the `labels` input. The value is a JSON object with the same shape; omitted keys keep their default names:

```json
{ "manual": { "doNotMerge": "do-not-merge" } }
```

The merged mapping is validated before any label is written or any pull request is dequeued. Every key must map to a distinct (ignoring case), nonempty label name of at most 50 characters, without surrounding whitespace or control characters. Invalid JSON, a non-object value, unknown sections, and unknown keys fail the run with a descriptive error. An empty or unset variable uses the defaults.

A rename takes effect on the next run and does not migrate existing labels. To rename safely:

1. Define each new name centrally in the repository's `repo_labels` entry in [`.github/sync.yml`](../../sync.yml), with `from_name: <old-name>`, so the [label catalog](#label-catalog) sync renames the existing label and keeps its assignments. A repository label whose `name` or `from_name` matches a shared label replaces it. Without these definitions, the renamed labels have no color or description, and the default-named labels are recreated.
2. Set `PR_STATUS_LABELS` after the sync pull request merges and the renamed labels exist.
3. If you rename a manual hold label, also pass the override literally to the [hold check](#hold-check), because configuration variables are not available to fork `pull_request` runs.

Release-impact labels and review or merge policy are not configured here. The release-impact check that requires `pr:standard` or `pr:important` (`PR Required Labels` in `radius-project/radius`) is Radius-only and is not part of this package; other repositories that list those labels in `repo_labels` only get their definitions.

### Other settings

- **Review signal workflow name.** The caller's `workflow_run` trigger must name the relay workflow. The reusable workflow and action only accept signals from the workflow named by `review-signal-workflow` (default `PR Review Signal`).
- **Schedule.** Scheduled runs only reconcile repositories owned by `radius-project`, so forks do not run the schedule.
- **Validate the defaults locally.** Run `node .github/actions/pr-status-labels/pr-status-labels.mjs` with Node.js 24 from the repository root. It imports and validates `labels.json` without calling GitHub or installing dependencies.

## Opting a repository in

The PR status labels group in [`.github/sync.yml`](../../sync.yml) enrolls `radius-project/.github`, `ai-extensions`, `dashboard`, `docs` (synced to `edge`; see [Limitations](#limitations)), `lab`, `radius`, `recipes`, `resource-types-contrib`, and `website`. To enroll another repository:

1. Remove any repository-local lifecycle-label workflows, scripts, and configuration so only one writer updates the labels.
2. Add the repository to the PR status labels group in [`.github/sync.yml`](../../sync.yml), and add any repository-specific labels, including those in an existing `.github/labels.yml` and any existing `pr:` labels, to that group's `repo_labels` (see [Label catalog](#label-catalog)). After the change merges, the Sync workflow opens a pull request in the target repository that adds:
   - `.github/workflows/pr-status-labels.yml` (`PR Status Labels`)
   - `.github/workflows/pr-review-signal.yml` (`PR Review Signal`)
   - `.github/workflows/labels.yml` (`Labels`)
   - `.github/labels.yml`, which replaces any existing file

   Repositories outside the sync can copy the workflow templates from the organization's workflow templates in the GitHub Actions UI, but must then maintain their own `.github/labels.yml`.
3. Merge the sync pull request. The `Labels` workflow runs on push to the default branch and creates the shared labels. Run `PR Status Labels` manually without a PR number to label existing open pull requests, or wait for the schedule.
4. Optionally set `PR_STATUS_LABELS` (see [Configuration](#configuration)).
5. Optionally add the [hold check](#hold-check) to a required status check.
6. Make sure the repository's Actions policy allows `pull_request_target` workflows, or fork PR labeling does not start.

## Hold check

[`__pr-holds.yml`](../../workflows/__pr-holds.yml) is a reusable workflow that fails when the pull request carries a manual hold label. It runs the action's `check-holds` mode, which reads only the event's pull request labels, needs no checkout, makes no API calls, and runs with no token permissions.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `labels` | `""` | Optional JSON object that overrides default label names, the same partial override the action accepts. |

| Output | Description |
| ------ | ----------- |
| `holds` | JSON array of manual hold labels found on the pull request. |

Call it from a `pull_request` workflow and gate the repository's own required job on it, failing closed:

```yaml
jobs:
  merge-holds:
    if: github.event_name != 'merge_group'
    uses: radius-project/.github/.github/workflows/__pr-holds.yml@main
    permissions: {}
    with:
      labels: ${{ vars.PR_STATUS_LABELS }}

  <required-job>:
    needs: merge-holds
    if: always()
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Require successful merge-hold validation
        if: github.event_name != 'merge_group' && needs.merge-holds.result != 'success'
        run: exit 1
      # The required job's other steps follow.
```

The required status check stays the calling repository's own job (`<required-job>`), so its context name and the ruleset do not change. That job fails whenever the hold check fails or is skipped. The gate step's `if` has no status function, so GitHub adds an implicit `success()`; if the whole workflow run is cancelled, that step is skipped rather than failing, but a cancelled run is never reported as success. The hold check also reports its own `merge-holds / Check merge holds` context, which does not need to be required.

Use the reusable workflow rather than calling the action as a step. When a repository requires actions to be pinned to a full-length commit SHA (the Actions setting `sha_pinning_required`, enabled on every enrolled repository), a step-level reference to this repository's action must use a full commit SHA. Reusable workflows may still be referenced at `@main`, and the `$/` reference inside `__pr-holds.yml` resolves to the same commit, so the reusable workflow is the supported path.

Trigger the workflow on `pull_request` with at least `opened`, `reopened`, `labeled`, `unlabeled`, and `synchronize`. Also trigger it on `merge_group` if the check is required in a merge queue. The hold check fails on any event without a pull request payload, so skip it for `merge_group` as shown; the required job still reports. Held PRs are dequeued by the reconciler, so the merge-group run can pass.

The check uses the same [hold matching](#handoff-labels) as the reconciler: label names match ignoring case, and the default hold names stay holds alongside any renamed holds unless a default name is configured for another label. This preserves holds during a rename and in fork runs without the variable. GitHub does not pass configuration variables to `pull_request` runs from forks, so a renamed hold is only recognized on fork PRs if the override is written literally in the caller's `labels` input.

## Label catalog

Labels are managed only in this repository. [`sync-templates/.github/labels.yml.njk`](../../../sync-templates/.github/labels.yml.njk) defines the shared labels for every enrolled repository, and the `repo_labels` template variable in [`.github/sync.yml`](../../sync.yml) adds repository-specific labels, keyed by repository name:

```yaml
- source: sync-templates/.github/labels.yml.njk
  dest: .github/labels.yml
  template:
    repo_labels:
      radius:
        - name: pr:standard
          color: 86a16a
          description: Ongoing maintenance, minor improvements, documentation updates, and routine development work
```

The Sync workflow renders both into each enrolled repository's `.github/labels.yml`, so shared and repository-specific changes arrive as sync pull requests. Don't edit a synced `.github/labels.yml`; the next sync overwrites it. Change the template or `repo_labels` instead.

Each label needs a `name` and a `color` (hex, without `#`). Quote colors that YAML reads as numbers, such as `"000000"`. A label can also set a `description` (empty by default) and a `from_name` to rename an existing label and keep its assignments. Names must be unique, ignoring case. A repository label whose `name` or `from_name` matches a shared label, ignoring case, replaces the shared label.

The `Labels` workflow applies `.github/labels.yml` with [crazy-max/ghaction-github-labeler](https://github.com/crazy-max/ghaction-github-labeler) using `skip-delete`, so labels the file does not list are never deleted. On pull requests that change the file, it previews changes as a dry run. It applies the file on push to the default branch, on manual dispatch from the default branch, and after a repository label is created, edited, or deleted, which reverts manual changes to the labels the file defines.

## Limitations

- **Delayed updates.** The status workflow reacts to PR, review, and inline-comment creation, edit, and deletion activity. It also checks open PRs on a nominal 15-minute schedule to pick up CI, base-branch, PR conversation comment, and thread resolution or reopening changes; GitHub may delay scheduled runs. GitHub Actions has no trigger for resolving or reopening review threads, and the workflow does not run on PR conversation comments, so those changes wait for the scheduled reconciliation or a manual run.
- **Held review signals.** The repository's Actions approval policy can hold the read-only `PR Review Signal` run for Copilot review activity (the run's actor is `Copilot`, even on same-repository PRs) and for review activity on fork PRs. A held run concludes as `action_required` and never signals labeling, so those changes also wait for the scheduled reconciliation. Maintainers can rerun `PR Status Labels` from the Actions tab with a PR number, or leave it blank to reconcile all open PRs.
- **Fork hold checks.** Configuration variables are not passed to fork `pull_request` runs; see [Hold check](#hold-check).
- **Approval inference.** For ruleset-protected branches without an aggregate review decision, CODEOWNER approval is only inferred from `.github/CODEOWNERS` on the base branch.
- **Size limits.** A PR with more than 100 labels or more than 100 pending review requests fails reconciliation rather than being classified from partial data.
- **Non-default sync branch.** `radius-project/docs` is synced to `edge`, but its default branch is a release branch cut from `edge`. `pull_request_target` runs use the base branch's workflow, so PRs into `edge` are labeled as soon as the sync pull request merges. Scheduled reconciliation, `workflow_run` review signals, manual runs, and the `Labels` sync run only from the default branch, so they start once the next release branch is cut from `edge`. Until then, PRs into other branches are not labeled, lifecycle labels that the reconciler adds lack the shared colors and descriptions, and the legacy `do-not-merge` label is not yet renamed to `pr:do-not-merge`, so the reconciler does not treat it as a hold. The docs `PR Checks` workflow's required `Check for do-not-merge tag` job matches `do-not-merge` by name; update it to also reject `pr:do-not-merge` before that release branch is cut, or the rename stops it from blocking held PRs.
- **Platform.** The reusable workflows load their actions with the `$/` self-repository syntax, which requires GitHub.com (not GitHub Enterprise Server) and runner 2.336.0 or newer. actionlint 1.7.12 does not recognize `$/` yet ([rhysd/actionlint#711](https://github.com/rhysd/actionlint/issues/711)).

## Trust model

- **No pull request code runs with write access.** The writer runs on `pull_request_target`, `workflow_run`, `schedule`, and `workflow_dispatch`, all in the base repository's context. It checks out nothing; the script and default names come from this repository at the reusable workflow's commit through `$/`, and callers reference the reusable workflow at `@main`, matching the organization's other shared workflows.
- **The review signal is read-only and untrusted.** `PR Review Signal` has no permissions and only echoes a message. Because a fork can change its run name, the writer accepts a signal only when it comes from the configured workflow name, a review or inline-comment event, and a successful run whose run name is the PR number and whose head SHA matches the PR's current head or merge commit. Other signals are ignored and left to the schedule.
- **Fail closed.** Paginated GraphQL and REST reads reject missing or repeated cursors, unexpected responses, and changed base or head commits. Label-name configuration errors stop the run before any write or dequeue. A failure on one PR during an all-PR run still reconciles the rest, then fails the run.
- **Least privilege.** The writer job has `contents: read`, `issues: write`, and `pull-requests: write`. The hold check reads only the event payload and runs with no token permissions. The `Labels` preview parses the proposed `.github/labels.yml` as data with a read-only token and a dry run; the apply job uses only the default branch's file at `github.sha`. Third-party actions are pinned to full commit SHAs, and checkouts use `persist-credentials: false`.
