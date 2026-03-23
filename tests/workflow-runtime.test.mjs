import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

async function readWorkflow() {
  return readFile(
    path.join(process.cwd(), '.github', 'workflows', 'publish-feed.yml'),
    'utf8'
  );
}

test('publish workflow exposes route, mode, and concurrency dispatch inputs', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /workflow_dispatch:\s+inputs:/u);
  assert.match(workflow, /route:\s*\n\s+description: 'Optional scoped route'/u);
  assert.match(workflow, /mode:\s*\n\s+description: 'Publish mode'/u);
  assert.match(workflow, /fetch_concurrency:\s*\n\s+description: 'Global fetch concurrency'/u);
  assert.match(workflow, /per_host_concurrency:\s*\n\s+description: 'Per-host fetch concurrency'/u);
  assert.match(workflow, /config_repository:\s*\n\s+description: 'Private config\/state repository slug'/u);
  assert.match(workflow, /default: '5'/u);
  assert.match(workflow, /default: '2'/u);
});

test('publish workflow compiles runtime config before publishing feeds', async () => {
  const workflow = await readWorkflow();

  const buildConfigIndex = workflow.indexOf('- name: Build runtime config');
  const publishIndex = workflow.indexOf('- name: Generate static feeds into feed root');

  assert.ok(buildConfigIndex >= 0);
  assert.ok(publishIndex > buildConfigIndex);
  assert.match(workflow, /node \.github\/scripts\/build-runtime-config\.mjs/u);
  assert.match(workflow, /--config-root=data-repo\/config/u);
  assert.match(workflow, /--output=\$\{\{ env\.REFEED_RUNTIME_CONFIG_PATH \}\}/u);
  assert.match(workflow, /--config=build\/config\.runtime\.json/u);
});

test('publish workflow passes concurrency env values to publish-feeds', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /REFEED_FETCH_CONCURRENCY: \$\{\{ github\.event\.inputs\.fetch_concurrency \|\| '5' \}\}/u);
  assert.match(workflow, /REFEED_FETCH_PER_HOST_CONCURRENCY: \$\{\{ github\.event\.inputs\.per_host_concurrency \|\| '2' \}\}/u);
  assert.match(workflow, /--fetch-concurrency=\$\{\{ github\.event\.inputs\.fetch_concurrency \|\| '5' \}\}/u);
  assert.match(workflow, /--per-host-concurrency=\$\{\{ github\.event\.inputs\.per_host_concurrency \|\| '2' \}\}/u);
});

test('publish workflow checks out the data repository and writes state plus feeds back to it', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /jobs:\s+publish:\s+if: \$\{\{ github\.event\.inputs\.config_repository != '' \|\| vars\.DATA_REPOSITORY != '' \}\}/u);
  assert.match(workflow, /- name: Checkout external config repository/u);
  assert.match(workflow, /repository: \$\{\{ github\.event\.inputs\.config_repository \|\| vars\.DATA_REPOSITORY \|\| github\.repository \}\}/u);
  assert.match(workflow, /token: \$\{\{ secrets\.REFEED_DATA_REPO_TOKEN \}\}/u);
  assert.match(workflow, /path: data-repo/u);
  assert.match(workflow, /--state-dir=data-repo\/state/u);
  assert.match(workflow, /--existing-dir=data-repo\/feeds/u);
  assert.match(workflow, /- name: Sync state and feeds back to data repository/u);
  assert.match(workflow, /sync-data-repo\.sh data-repo\/state dist-feed data-repo/u);
});

test('publish workflow no longer references retry issues or README refresh steps', async () => {
  const workflow = await readWorkflow();

  assert.doesNotMatch(workflow, /issues:\s*\n\s+types:/u);
  assert.doesNotMatch(workflow, /sync-failure-issues/u);
  assert.doesNotMatch(workflow, /README dashboard/u);
  assert.doesNotMatch(workflow, /git add README\.md state/u);
});

test('publish workflow keeps branch publish and minimal summary', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /- name: Write run summary/u);
  assert.match(workflow, /Enabled rules: \$\{report\.totals\.enabled\}/u);
  assert.match(workflow, /Failed routes/u);
  assert.doesNotMatch(workflow, /entry\.source/u);
  assert.match(workflow, /- name: Sync state and feeds back to data repository/u);
  assert.match(workflow, /sync-data-repo\.sh data-repo\/state dist-feed data-repo/u);
});

test('publish workflow keeps scheduled runs hourly and does not cancel active runs', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /cron: '7 \* \* \* \*'/u);
  assert.match(workflow, /concurrency:\s*\n\s+group: publish-feed/u);
  assert.match(workflow, /cancel-in-progress: false/u);
});
