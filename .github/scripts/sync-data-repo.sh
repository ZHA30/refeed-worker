#!/usr/bin/env bash
set -euo pipefail

source_state_dir="${1:-state}"
source_feed_dir="${2:-dist-feed}"
target_checkout_dir="${3:-data-repo}"
commit_message="${4:-chore: refresh feed data}"

target_state_dir="${target_checkout_dir}/state"
target_feed_dir="${target_checkout_dir}/feeds"

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
