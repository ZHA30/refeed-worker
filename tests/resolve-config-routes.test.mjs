import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';

import { resolveAffectedRoutes } from '../.github/scripts/resolve-config-routes.mjs';

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function createConfigTree() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refeed-resolve-routes-'));
  const configRoot = path.join(tempDir, 'config');

  await writeJson(path.join(configRoot, 'feed.json'), {
    feed: { itemlimit: 30 },
  });
  await writeJson(path.join(configRoot, 'group-a', 'feed.json'), {
    channel: { language: 'zh-cn' },
  });
  await writeJson(path.join(configRoot, 'group-a', 'weixin', 'feed.json'), {
    channel: { generator: false },
  });
  await writeJson(path.join(configRoot, 'group-a', 'weixin', 'main.json'), {
    feed: { source: 'https://example.com/a.xml' },
  });
  await writeJson(path.join(configRoot, 'group-a', 'weixin', 'alt.json'), {
    feed: { source: 'https://example.com/b.xml' },
  });
  await writeJson(path.join(configRoot, 'group-b', 'zhihu', 'daily.json'), {
    feed: { source: 'https://example.com/c.xml' },
  });
  await writeFile(path.join(configRoot, 'README.md'), '# docs\n', 'utf8');
  await writeJson(path.join(configRoot, 'config.schema.json'), {
    title: 'schema',
  });

  return { tempDir, configRoot };
}

test('resolveAffectedRoutes returns none for empty change set', async () => {
  const { configRoot } = await createConfigTree();
  const result = await resolveAffectedRoutes({ configRoot, changedFiles: [] });

  assert.deepEqual(result, { mode: 'none', routes: [] });
});

test('resolveAffectedRoutes scopes a direct route file change to one route', async () => {
  const { configRoot } = await createConfigTree();
  const changedFile = path.join(configRoot, 'group-a', 'weixin', 'main.json');
  const result = await resolveAffectedRoutes({ configRoot, changedFiles: [changedFile] });

  assert.deepEqual(result, { mode: 'partial', routes: ['weixin/main'] });
});

test('resolveAffectedRoutes expands nested feed.json changes to subtree routes', async () => {
  const { configRoot } = await createConfigTree();
  const changedFile = path.join(configRoot, 'group-a', 'weixin', 'feed.json');
  const result = await resolveAffectedRoutes({ configRoot, changedFiles: [changedFile] });

  assert.deepEqual(result, {
    mode: 'partial',
    routes: ['weixin/alt', 'weixin/main'],
  });
});

test('resolveAffectedRoutes expands root feed.json changes to all routes', async () => {
  const { configRoot } = await createConfigTree();
  const changedFile = path.join(configRoot, 'feed.json');
  const result = await resolveAffectedRoutes({ configRoot, changedFiles: [changedFile] });

  assert.deepEqual(result, {
    mode: 'all',
    routes: ['weixin/alt', 'weixin/main', 'zhihu/daily'],
  });
});

test('resolveAffectedRoutes ignores documentation-only config changes', async () => {
  const { configRoot } = await createConfigTree();
  const result = await resolveAffectedRoutes({
    configRoot,
    changedFiles: [
      path.join(configRoot, 'README.md'),
      path.join(configRoot, 'config.schema.json'),
    ],
  });

  assert.deepEqual(result, { mode: 'none', routes: [] });
});
