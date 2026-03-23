import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  buildRuntimeConfigFromTree,
  writeRuntimeConfigFromTree,
} from '../.github/scripts/lib/config-tree.mjs';
import { loadRules } from '../.github/scripts/lib/rules.mjs';

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('config tree compiles nested feed.json inheritance into runtime config', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refeed-config-tree-'));
  const configRoot = path.join(tempDir, 'config');
  const outputPath = path.join(tempDir, 'build', 'config.runtime.json');

  await writeJson(path.join(configRoot, 'feed.json'), {
    feed: { itemlimit: 50, statelimit: 100 },
    channel: { description: false, generator: false },
  });
  await writeJson(path.join(configRoot, 'demo', 'feed.json'), {
    channel: { webMaster: 'owner@example.com' },
  });
  await writeJson(path.join(configRoot, 'demo', 'weixin', 'feed.json'), {
    channel: { link: 'https://mp.weixin.qq.com' },
  });
  await writeJson(path.join(configRoot, 'demo', 'weixin', 'main.json'), {
    feed: { source: 'https://example.com/feed.xml', htmlcleanup: true },
    channel: { title: 'Demo Feed', image: false },
  });

  const runtimeConfig = await buildRuntimeConfigFromTree(configRoot);
  assert.deepEqual(runtimeConfig, {
    demo: {
      routes: {
        'weixin/main': {
          feed: {
            itemlimit: 50,
            statelimit: 100,
            source: 'https://example.com/feed.xml',
            htmlcleanup: true,
          },
          channel: {
            description: false,
            generator: false,
            webMaster: 'owner@example.com',
            link: 'https://mp.weixin.qq.com',
            title: 'Demo Feed',
            image: false,
          },
        },
      },
    },
  });

  await writeRuntimeConfigFromTree({ configRoot, outputPath });
  const rules = await loadRules(outputPath);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].route, 'weixin/main');
  assert.equal(rules[0].source, 'https://example.com/feed.xml');
  assert.equal(rules[0].htmlCleanup, true);
});

test('config tree rejects duplicate routes across groups', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refeed-config-tree-dup-'));
  const configRoot = path.join(tempDir, 'config');

  await writeJson(path.join(configRoot, 'group-a', 'demo', 'main.json'), {
    feed: { source: 'https://example.com/a.xml' },
  });
  await writeJson(path.join(configRoot, 'group-b', 'demo', 'main.json'), {
    feed: { source: 'https://example.com/b.xml' },
  });

  await assert.rejects(
    () => buildRuntimeConfigFromTree(configRoot),
    /duplicate route detected: demo\/main/u
  );
});

test('config tree rejects feed.source in directory feed.json defaults', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refeed-config-tree-source-'));
  const configRoot = path.join(tempDir, 'config');

  await writeJson(path.join(configRoot, 'demo', 'feed.json'), {
    feed: { source: 'https://example.com/forbidden.xml' },
  });

  await assert.rejects(
    () => buildRuntimeConfigFromTree(configRoot),
    /must not define feed\.source/u
  );
});
