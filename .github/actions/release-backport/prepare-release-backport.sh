#!/bin/bash

# ------------------------------------------------------------
# Copyright 2026 The Radius Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

git fetch origin "${SOURCE_COMMIT}"
git fetch origin \
    "refs/heads/release/${CHANNEL}:refs/remotes/origin/release/${CHANNEL}"
branch="automation/backport-${SOURCE_PR}-to-${CHANNEL}"
bash "${SCRIPT_DIR}/collect-release-backports.sh" \
    --repository "${GITHUB_REPOSITORY}" --channel "${CHANNEL}" \
    --explicit-prs "${SOURCE_PR}" \
    --output "${RUNNER_TEMP}/source-backport.json"
source_entry="$(
    jq -c --argjson source_pr "${SOURCE_PR}" \
        '[.[] | select(.source_pr == $source_pr)]' \
        "${RUNNER_TEMP}/source-backport.json"
)"
[[ "$(jq 'length' <<< "${source_entry}")" == "1" ]] || {
    echo "::error::Expected exactly one backport record for #${SOURCE_PR}."
    exit 1
}
if [[ "$(jq -r '.[0].backport_merged' <<< "${source_entry}")" == "true" ]]; then
    {
        echo "status=$(jq -r 'if .[0].already_present then "already-present" else "existing" end' <<< "${source_entry}")"
        echo "url=$(jq -r '.[0].backport_url // .[0].source_url' <<< "${source_entry}")"
    } >> "${GITHUB_OUTPUT}"
    exit 0
fi
result="$(
    gh pr list --repo "${GITHUB_REPOSITORY}" --state open --limit 1000 \
        --base "release/${CHANNEL}" --json number,url,headRefName,isCrossRepository \
        --jq '[.[] | select(.isCrossRepository == false and (.headRefName | startswith("automation/backport-")))][0] // empty'
)"
if [[ -n "${result}" ]]; then
    {
        echo "url=$(jq -r .url <<< "${result}")"
        echo "status=$(jq -r --arg branch "${branch}" 'if .headRefName == $branch then "existing" else "deferred" end' <<< "${result}")"
    } >> "${GITHUB_OUTPUT}"
    exit 0
fi
remote_sha="$(git ls-remote origin "refs/heads/${branch}" | awk '{print $1}')"
if [[ -n "${remote_sha}" ]]; then
    echo "::error::Branch ${branch} exists without an open PR. Inspect it before deleting or recreating the backport."
    exit 1
fi

output_dir="${RUNNER_TEMP}/release-backport"
args=(
    --source-pr "${SOURCE_PR}" --source-commit "${SOURCE_COMMIT}"
    --source-title "${SOURCE_TITLE}" --source-url "${SOURCE_URL}"
    --channel "${CHANNEL}" --output-dir "${output_dir}"
)
if [[ -n "${EXPECTED_BASE:-}" ]]; then
    args+=(--expected-base "${EXPECTED_BASE}")
fi
bash "${SCRIPT_DIR}/create-release-backport.sh" "${args[@]}"
{
    echo "status=$(< "${output_dir}/status.txt")"
    echo "branch=$(< "${output_dir}/branch.txt")"
    echo "title=$(< "${output_dir}/title.txt")"
    echo "author=$(< "${output_dir}/author.txt")"
} >> "${GITHUB_OUTPUT}"
delimiter="release_commit_$(openssl rand -hex 16)"
{
    echo "commit-message<<${delimiter}"
    cat "${output_dir}/commit-message.txt"
    echo "${delimiter}"
} >> "${GITHUB_OUTPUT}"
