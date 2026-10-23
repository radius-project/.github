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

// Dependabot runs update jobs in a GitHub-managed dynamic workflow, so failures
// cannot be reported from inside the run. This script reads the recent runs of
// that workflow and keeps one open issue per repository listing the updates
// whose latest run failed.

export const WORKFLOW_PATH = "dynamic/dependabot/dependabot-updates";
export const ISSUE_TITLE = "Dependabot updates are failing";
export const MARKER = "<!-- dependabot-failures -->";
const STATE_PREFIX = "<!-- dependabot-failures-state: ";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const LABEL_COLOR = "d73a4a";
const LABEL_DESCRIPTION = "A scheduled workflow or update job failed";
const DAY_MS = 24 * 60 * 60 * 1000;

// Run titles look like "npm_and_yarn in /docs - Update #123" for version
// updates and "npm_and_yarn in /docs for vite - Update #123" for security
// updates. Grouped security updates list every dependency, and the order of
// directories and dependencies changes between runs, so they are normalized.
// Returns { key, name, base, deps } where key identifies the update across
// runs and base is the ecosystem and directories.
export function parseTitle(title) {
  const text = String(title ?? "")
    .replace(/\s+-\s+Update\s+#\d+\s*$/u, "")
    .trim();
  const match = text.match(/^(\S+) in (.+?)(?: for (.+))?$/u);
  if (!match) {
    return { key: text, name: text, base: text, deps: [] };
  }
  const [, ecosystem, dirList, depList] = match;
  const split = (list) => [...new Set(list.split(",").map((s) => s.trim()).filter(Boolean))];
  const dirs = split(dirList).sort();
  const deps = depList ? split(depList).sort() : [];
  const base = `${ecosystem} in ${dirs.join(", ")}`;
  if (deps.length === 0) {
    return { key: base, name: base, base, deps };
  }
  if (deps.length === 1) {
    const name = `${base} for ${deps[0]}`;
    return { key: name, name, base, deps };
  }
  const shown = deps.slice(0, 8).join(", ");
  const more = deps.length > 8 ? ` and ${deps.length - 8} more` : "";
  return { key: `${base} for multiple dependencies`, name: `${base} for ${shown}${more}`, base, deps };
}

// The updater prints the errors as a table at the end of a failed job, either
//   | Type                         | Details                          |
//   | security_update_not_possible | {                                |
//   |                              |   "dependency-name": "vite",     |
// or, when single dependencies failed,
//   | Dependency | Error Type                            | Error Details |
//   | morgan     | private_source_authentication_failure | {...}         |
// The Details JSON spans continuation rows with an empty type, so those rows
// belong to the last row that had one.
// Returns [{ type, dependencies }] in the order the types first appear.
export function parseErrors(log) {
  const errors = new Map();
  const pipes = (line) => [...line.matchAll(/\|/gu)].map((m) => m.index);
  const addDependency = (entry, name) => {
    if (name && !entry.dependencies.includes(name)) {
      entry.dependencies.push(name);
    }
  };
  let typeCol = -1;
  let depCol = -1;
  let headerPipes = [];
  let current = null;
  for (const raw of String(log ?? "").split(/\r?\n/u)) {
    const line = raw
      .replace(/\u001b\[[0-9;]*m/gu, "")
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/u, "")
      .trim();
    if (!line.startsWith("|") && !line.startsWith("+")) {
      typeCol = -1;
      current = null;
      continue;
    }
    if (!line.startsWith("|") || !line.endsWith("|")) {
      continue;
    }
    const cells = line.slice(1, -1).split("|").map((c) => c.trim());
    const header = cells.findIndex((c) => /^(Error )?Type$/u.test(c));
    if (header >= 0) {
      typeCol = header;
      depCol = cells.indexOf("Dependency");
      headerPipes = pipes(line).slice(0, header + 2);
      current = null;
      continue;
    }
    // Lines from other log streams can be spliced into the table, so only
    // trust rows whose columns line up with the header.
    const rowPipes = pipes(line).slice(0, headerPipes.length);
    if (typeCol < 0 || rowPipes.some((p, i) => p !== headerPipes[i])) {
      continue;
    }
    const type = cells[typeCol];
    if (/^[a-z][a-z0-9_]*$/u.test(type ?? "")) {
      current = errors.get(type) ?? { type, dependencies: [] };
      errors.set(type, current);
      addDependency(current, depCol >= 0 ? cells[depCol] : "");
    } else if (type !== "" || !current) {
      continue;
    }
    const details = cells.slice(typeCol + 1).join(" ");
    for (const match of details.matchAll(/"dependency-name":\s*"([^"]+)"/gu)) {
      addDependency(current, match[1]);
    }
  }
  return [...errors.values()];
}

// Keeps the latest run per update and returns the updates whose latest run
// failed, newest first. A single-dependency failure is also cleared by a later
// successful grouped run in the same ecosystem and directories that includes
// that dependency.
export function failingUpdates(runs) {
  const byKey = new Map();
  const groupSuccesses = [];
  for (const run of runs) {
    const { key, name, base, deps } = parseTitle(run.display_title);
    if (!key) {
      continue;
    }
    if (run.conclusion === "success" && deps.length > 1) {
      groupSuccesses.push({ base, deps, created_at: run.created_at });
    }
    const entry = byKey.get(key) ?? { key, name, base, deps, latest: null, failures: 0 };
    if (FAILED.has(run.conclusion)) {
      entry.failures += 1;
    }
    if (!entry.latest || new Date(run.created_at) > new Date(entry.latest.created_at)) {
      entry.latest = run;
      entry.name = name;
    }
    byKey.set(key, entry);
  }
  const clearedByGroup = (entry) =>
    entry.deps.length === 1 &&
    groupSuccesses.some(
      (g) =>
        g.base === entry.base &&
        g.deps.includes(entry.deps[0]) &&
        new Date(g.created_at) > new Date(entry.latest.created_at)
    );
  return [...byKey.values()]
    .filter((entry) => FAILED.has(entry.latest.conclusion) && !clearedByGroup(entry))
    .sort((a, b) => new Date(b.latest.created_at) - new Date(a.latest.created_at));
}

// The open issue stores the keys of the updates it lists, so a later run can
// tell which failures are new and comment only about those.
export function readState(body) {
  const line = String(body ?? "")
    .split("\n")
    .find((l) => l.startsWith(STATE_PREFIX));
  if (!line) {
    return [];
  }
  try {
    const names = JSON.parse(line.slice(STATE_PREFIX.length).replace(/\s*-->\s*$/u, ""));
    return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function writeState(names) {
  // "--" would end the HTML comment early; JSON.parse turns \u002d back into "-".
  return `${STATE_PREFIX}${JSON.stringify(names).replace(/--/gu, "-\\u002d")} -->`;
}

function cell(text) {
  return String(text).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function formatErrors(errors) {
  if (!errors?.length) {
    return "See run log";
  }
  return errors
    .map(({ type, dependencies }) => {
      if (!dependencies.length) {
        return `\`${type}\``;
      }
      const shown = dependencies.slice(0, 5).map(cell).join(", ");
      const more = dependencies.length > 5 ? ` and ${dependencies.length - 5} more` : "";
      return `\`${type}\` (${shown}${more})`;
    })
    .join("<br>");
}

export function table(updates) {
  const rows = updates.map((u) => {
    const errors = formatErrors(u.errors);
    const date = String(u.latest.created_at).slice(0, 10);
    return `| ${cell(u.name)} | [${date}](${u.latest.html_url}) | ${errors} | ${u.failures} |`;
  });
  return [
    "| Update | Latest failed run | Error type | Failed runs |",
    "| ------ | ----------------- | ---------- | ----------- |",
    ...rows
  ].join("\n");
}

export function issueBody({ repo, updates, lookbackDays, checkedAt, workflowUrl }) {
  const lines = [MARKER, writeState(updates.map((u) => u.key)), ""];
  if (updates.length > 0) {
    lines.push(
      `These Dependabot updates failed on their latest run in the last ${lookbackDays} days. A failed update opens no pull request, so these dependencies are not being updated.`,
      "",
      table(updates)
    );
  } else {
    lines.push(
      `Every Dependabot update that ran in the last ${lookbackDays} days succeeded on its latest run. Close this issue once the earlier failures are understood.`
    );
  }
  const workflow = workflowUrl ? `[Dependabot Failures](${workflowUrl})` : "Dependabot Failures";
  lines.push(
    "",
    "## How to fix",
    "",
    `- Open the failed run for the full log. The same log is on the [Dependabot page](https://github.com/${repo}/network/updates) (requires write access).`,
    "- Error types are explained in [Troubleshooting Dependabot errors](https://docs.github.com/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-errors).",
    "- `.github/dependabot.yml` is synced from [radius-project/.github](https://github.com/radius-project/.github/blob/main/.github/sync.yml) in most repositories. Change the config there, not in this repository.",
    "",
    `The ${workflow} workflow updates this issue daily and comments when a new update starts failing. Last checked ${checkedAt}.`
  );
  return lines.join("\n");
}

async function findWorkflow(github, owner, repo) {
  const workflows = await github.paginate(github.rest.actions.listRepoWorkflows, {
    owner,
    repo,
    per_page: 100
  });
  return workflows.find((w) => w.path === WORKFLOW_PATH);
}

async function listReports(github, owner, repo, label, state, since) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state,
    labels: label,
    ...(since ? { since: since.toISOString() } : {}),
    per_page: 100
  });
  return issues.filter((i) => !i.pull_request && String(i.body ?? "").startsWith(MARKER));
}

// The oldest open report, so every run keeps updating the same one.
async function findOpenReport(github, owner, repo, label) {
  const reports = await listReports(github, owner, repo, label, "open");
  return reports.sort((a, b) => a.number - b.number)[0];
}

// The latest closing time of a report closed after `since`. A closed issue's
// updated_at is never earlier than its closed_at, so filtering on updated_at
// keeps every report that could move the cutoff.
async function lastClosedAt(github, owner, repo, label, since) {
  const reports = await listReports(github, owner, repo, label, "closed", since);
  return reports
    .map((i) => (i.closed_at ? new Date(i.closed_at) : null))
    .filter((d) => d && d > since)
    .sort((a, b) => b - a)[0];
}

async function runErrors(github, owner, repo, runId, core) {
  try {
    const jobs = await github.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      filter: "latest"
    });
    const errors = [];
    for (const job of jobs.data.jobs) {
      if (!FAILED.has(job.conclusion)) {
        continue;
      }
      const log = await github.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id
      });
      const text =
        typeof log.data === "string" ? log.data : Buffer.from(log.data).toString("utf8");
      errors.push(...parseErrors(text));
    }
    return errors;
  } catch (error) {
    core.warning(`Could not read the log of run ${runId}: ${error.message}`);
    return [];
  }
}

async function ensureLabel(github, owner, repo, label) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: label });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: label,
      color: LABEL_COLOR,
      description: LABEL_DESCRIPTION
    });
  }
}

export default async function run({ github, context, core }, options = {}) {
  const { owner, repo } = context.repo;
  const label = String(options.label || "test-failure").trim();
  const lookbackDays = Number(options.lookbackDays || 8);
  const maxLogs = Number(options.maxLogs ?? 30);
  const dryRun = options.dryRun === true || String(options.dryRun) === "true";
  const now = options.now ? new Date(options.now) : new Date();

  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
    throw new Error("lookback-days must be a whole number from 1 to 90");
  }

  const workflow = await findWorkflow(github, owner, repo);
  if (!workflow) {
    core.info("Dependabot Updates has never run in this repository. Nothing to check.");
    return { failing: [], added: [], action: "none" };
  }

  const openIssue = await findOpenReport(github, owner, repo, label);

  // Once an issue is closed, only failures after that point open a new one.
  let since = new Date(now.getTime() - lookbackDays * DAY_MS);
  if (!openIssue) {
    since = (await lastClosedAt(github, owner, repo, label, since)) ?? since;
  }

  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: workflow.id,
    status: "completed",
    created: `>=${since.toISOString().replace(/\.\d+Z$/u, "Z")}`,
    per_page: 100
  });
  core.info(`Found ${runs.length} completed Dependabot runs since ${since.toISOString()}.`);

  const failing = failingUpdates(runs);
  for (const [index, update] of failing.entries()) {
    update.errors =
      index < maxLogs ? await runErrors(github, owner, repo, update.latest.id, core) : [];
  }

  const previous = readState(openIssue?.body);
  const added = failing.filter((u) => !previous.includes(u.key));
  const body = issueBody({
    repo: `${owner}/${repo}`,
    updates: failing,
    lookbackDays,
    checkedAt: now.toISOString().replace(/\.\d+Z$/u, "Z"),
    workflowUrl: options.workflowUrl
  });
  const comment = added.length
    ? [
        added.length === 1 ? "A new update is failing:" : `${added.length} new updates are failing:`,
        "",
        table(added)
      ].join("\n")
    : "";

  let action = "none";
  if (openIssue) {
    action = comment ? "update-and-comment" : "update";
  } else if (failing.length > 0) {
    action = "create";
  }

  core.info(`${failing.length} updates failing, ${added.length} new. Action: ${action}.`);
  for (const update of failing) {
    const types = (update.errors ?? []).map((e) => e.type).join(", ") || "unknown error";
    core.info(`- ${update.name} (${types}): ${update.latest.html_url}`);
  }

  if (dryRun) {
    core.info("Dry run: no issue was created or changed.");
    await core.summary
      .addHeading("Dependabot failures (dry run)", 2)
      .addRaw(`Action: ${action}${openIssue ? ` on #${openIssue.number}` : ""}\n\n`)
      .addRaw(`${body}\n`)
      .write();
    return { failing, added, action, body, comment, issue: openIssue?.number };
  }

  if (action === "create") {
    await ensureLabel(github, owner, repo, label);
    const created = await github.rest.issues.create({
      owner,
      repo,
      title: ISSUE_TITLE,
      body,
      labels: [label]
    });
    core.notice(`Opened ${created.data.html_url}`);
    return { failing, added, action, issue: created.data.number };
  }

  if (openIssue) {
    // Comment before saving the new state in the body. If the comment fails,
    // the run fails and the next run still sees the update as new and retries.
    if (comment) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: openIssue.number,
        body: comment
      });
    }
    if (openIssue.body !== body) {
      await github.rest.issues.update({ owner, repo, issue_number: openIssue.number, body });
    }
    core.info(`Updated ${openIssue.html_url}`);
  }
  return { failing, added, action, issue: openIssue?.number };
}
