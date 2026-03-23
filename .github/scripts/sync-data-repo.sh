#!/usr/bin/env bash
set -euo pipefail

source_state_dir="${1:-state}"
source_feed_dir="${2:-dist-feed}"
target_checkout_dir="${3:-data-repo}"
commit_message="${4:-chore: refresh feed data}"

if [[ ! -d "${target_checkout_dir}" ]]; then
  echo "target checkout does not exist: ${target_checkout_dir}" >&2
  exit 1
fi

if [[ ! -d "${source_state_dir}" ]]; then
  echo "source state directory does not exist: ${source_state_dir}" >&2
  exit 1
fi

if [[ ! -d "${source_feed_dir}" ]]; then
  echo "source feed directory does not exist: ${source_feed_dir}" >&2
  exit 1
fi

rm -rf "${target_checkout_dir}/state"
mkdir -p "${target_checkout_dir}/state"
cp -R "${source_state_dir}/." "${target_checkout_dir}/state/"

rm -rf "${target_checkout_dir}/feeds"
mkdir -p "${target_checkout_dir}/feeds"
cp -R "${source_feed_dir}/." "${target_checkout_dir}/feeds/"

cd "${target_checkout_dir}"

if git diff --quiet -- state feeds; then
  echo "no data changes detected"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add state feeds
git commit -m "${commit_message}"
git push origin HEAD
