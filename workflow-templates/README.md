# Workflow Templates

- [Creating workflow templates for your organization](https://docs.github.com/en/actions/how-tos/reuse-automations/create-workflow-templates)
- [Metadata file requirements](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#metadata-file-requirements)

## PR status labels

[`pr-status-labels.yml`](./pr-status-labels.yml), [`pr-review-signal.yml`](./pr-review-signal.yml), and [`labels.yml`](./labels.yml) work together to apply pull request lifecycle labels and keep their definitions in sync. `labels.yml` applies the repository's `.github/labels.yml`, which is managed centrally in [`sync-templates/.github/labels.yml.njk`](../sync-templates/.github/labels.yml.njk) and the `repo_labels` variable in [`.github/sync.yml`](../.github/sync.yml); don't edit the synced file in the target repository. See the [PR Status Labels documentation](../.github/actions/pr-status-labels/README.md) for the handoff rules, configuration, opt-in steps, hold check, label catalog, limitations, and trust model.

## Dependabot failures

[`dependabot-failures.yml`](./dependabot-failures.yml) runs daily and keeps one open `test-failure` issue listing the Dependabot updates whose latest run failed, with links to the runs and the error types from their logs. A failed Dependabot update opens no pull request, so without this the failure goes unnoticed. See the [Dependabot Failures documentation](../.github/actions/dependabot-failures/README.md) for how the issue is kept up to date, configuration, and testing.
