#!/usr/bin/env bash
set -euo pipefail

source_state_dir="${1:-state}"
source_feed_dir="${2:-dist-feed}"
target_checkout_dir="${3:-data-repo}"
commit_message="${4:-chore: refresh feed data}"
source_readme_file="${5:-}"
source_report_file="${6:-}"

target_state_dir="${target_checkout_dir}/state"
target_feed_dir="${target_checkout_dir}/feeds"
target_readme_file="${target_checkout_dir}/README.md"
target_build_dir="${target_checkout_dir}/build"
target_report_file="${target_build_dir}/feed-report.json"

if [[ ! -d "${target_checkout_dir}" ]]; then
  echo "target checkout does not exist: ${target_checkout_dir}" >&2
  exit 1
fi

if [[ ! -d "${source_feed_dir}" ]]; then
  echo "source feed directory does not exist: ${source_feed_dir}" >&2
  exit 1
fi

if [[ -d "${source_state_dir}" && "$(realpath "${source_state_dir}")" != "$(realpath -m "${target_state_dir}")" ]]; then
  rm -rf "${target_state_dir}"
  mkdir -p "${target_state_dir}"
  cp -R "${source_state_dir}/." "${target_state_dir}/"
fi

rm -rf "${target_feed_dir}"
mkdir -p "${target_feed_dir}"
cp -R "${source_feed_dir}/." "${target_feed_dir}/"

if [[ -n "${source_readme_file}" && -f "${source_readme_file}" && "$(realpath "${source_readme_file}")" != "$(realpath -m "${target_readme_file}")" ]]; then
  cp "${source_readme_file}" "${target_readme_file}"
fi

if [[ -n "${source_report_file}" && -f "${source_report_file}" && "$(realpath "${source_report_file}")" != "$(realpath -m "${target_report_file}")" ]]; then
  mkdir -p "${target_build_dir}"
  cp "${source_report_file}" "${target_report_file}"
fi

cd "${target_checkout_dir}"

if git diff --quiet -- state feeds README.md build/feed-report.json; then
  echo "no data changes detected"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add state feeds README.md

if [[ -f "build/feed-report.json" ]]; then
  git add -f build/feed-report.json
fi

git commit -m "${commit_message}"

if git push origin HEAD; then
  exit 0
fi

git fetch origin main
git rebase origin/main
git push origin HEAD:main
