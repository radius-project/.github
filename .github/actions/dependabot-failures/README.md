# Dependabot Failures

Dependabot runs each update job in a GitHub-managed workflow named **Dependabot Updates**. When a job fails, it opens no pull request and nothing else reports it, so a repository can stop getting dependency updates without anyone noticing.

This automation checks those runs once a day and keeps one open issue per repository that lists the updates whose latest run failed.

- [Components](#components)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Testing](#testing)
- [Limitations](#limitations)

## Components

| Path | Purpose |
| ---- | ------- |
| [`.github/actions/dependabot-failures/`](./action.yml) | Composite action holding the script, [`dependabot-failures.mjs`](./dependabot-failures.mjs). |
| [`.github/workflows/__dependabot-failures.yml`](../../workflows/__dependabot-failures.yml) | Reusable workflow holding the job, its permissions, and its run filter. Loads the action with `$/` at the same commit. |
| [`workflow-templates/dependabot-failures.yml`](../../../workflow-templates/dependabot-failures.yml) | Caller (`Dependabot Failures`) with the daily schedule and manual trigger. Synced to every repository in the first group of [`.github/sync.yml`](../../sync.yml). |

The job needs `actions: read` to list runs and read job logs, and `issues: write` to write the issue. It does not check out any code.

## How it works

1. Finds the repository's Dependabot Updates workflow (`dynamic/dependabot/dependabot-updates`). Repositories where Dependabot has never run are skipped.
2. Lists its completed runs from the last 8 days. Version updates run weekly, so every configured update has at least one run in that window.
3. Groups runs by update, using the run title (package ecosystem, directories, and, for security updates, the dependency). An update counts as failing only when its latest run failed, so a failure that was fixed by a later run is not reported.
4. Reads the log of each failing update's latest run and pulls the error types (for example `security_update_not_possible`) and the affected dependencies from the table Dependabot prints at the end of the job.
5. Writes one issue titled `Dependabot updates are failing` with the `test-failure` label:
   - If no such issue is open and something is failing, opens one.
   - If one is open, rewrites its table with the current state and adds a comment only when an update that was not listed before starts failing.
   - If nothing is failing, it does not open an issue. An open issue is updated to say so and left for someone to close.

The issue is found by the label and a hidden marker at the start of its body, not by the title. After an issue is closed, only failures that happen later open a new one.

## Configuration

The reusable workflow accepts these inputs. The synced caller uses the defaults.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `label` | `test-failure` | Label used to find and tag the issue. Created if the repository does not have it. |
| `lookback-days` | `8` | How many days of runs to check. Keep it above 7 so weekly version updates are always included. |
| `dry-run` | `false` | Log the issue that would be written, in the job log and job summary, and change nothing. |

## Testing

Run the **Dependabot Failures** workflow manually with **dry_run** checked. The job summary shows the issue body it would write and whether it would open, update, or leave the issue alone. Manual runs also work from a fork; scheduled runs are limited to the `radius-project` organization.

## Limitations

- Only runs of the Dependabot Updates workflow are checked. Problems that stop Dependabot before a run starts, such as an invalid `.github/dependabot.yml`, show up on the repository's **Insights > Dependency graph > Dependabot** page instead.
- Job logs are read for at most 30 failing updates per run. Others show "See run log" as the error type.
- Workflow run logs are kept for 90 days at most, and the repository's retention setting can make that shorter.
- Scheduled workflows run only from the default branch. docs and samples sync to `edge`, which is not their default branch, so their daily check starts once the next release branch is cut from `edge`. Until then, run it manually from `edge`.
