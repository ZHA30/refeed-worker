import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { parseJsonDocument } from './lib/config-diagnostics.mjs';
import { routeToRuleFile } from './lib/rules.mjs';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getOption(name, fallback = '') {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function loadConfig(configPath) {
  const rawText = await readFile(configPath, 'utf8');
  const parsed = parseJsonDocument(rawText);
  if (parsed.parseError) {
    const lineText = parsed.parseError.line ? `L${parsed.parseError.line}` : 'L?';
    throw new Error(`${lineText} invalid JSON in ${configPath}: ${parsed.parseError.message}`);
  }
  if (!isPlainObject(parsed.value)) {
    throw new Error(`${configPath} must contain an object`);
  }
  return parsed.value;
}

function buildGlobalDefaults(config) {
  const groups = Object.values(config);
  const first = groups[0] ?? {};
  const sharedFeed = cloneValue(first.feed ?? {});
  const sharedChannel = cloneValue(first.channel);
  const sharedItem = cloneValue(first.item);

  const everyGroupMatches = groups.every((group) => {
    const normalizedGroup = isPlainObject(group) ? group : {};
    return (
      deepEqual(normalizedGroup.feed ?? {}, sharedFeed ?? {}) &&
      deepEqual(normalizedGroup.channel, sharedChannel) &&
      deepEqual(normalizedGroup.item, sharedItem)
    );
  });

  if (!everyGroupMatches) {
    return {
      feed: {},
      channel: undefined,
      item: undefined,
    };
  }

  return {
    feed: sharedFeed,
    channel: sharedChannel,
    item: sharedItem,
  };
}

function subtractDefaults(value, defaults) {
  if (value === undefined) {
    return undefined;
  }
  if (deepEqual(value, defaults)) {
    return undefined;
  }
  return cloneValue(value);
}

function createSerializableAuthoringConfig({ feed, channel, item }) {
  const payload = {};
  if (feed && Object.keys(feed).length > 0) {
    payload.feed = feed;
  }
  if (channel !== undefined) {
    payload.channel = channel;
  }
  if (item !== undefined) {
    payload.item = item;
  }
  return payload;
}

export async function migrateConfigToTree({ configPath, outputRoot }) {
  const config = await loadConfig(configPath);
  const globalDefaults = buildGlobalDefaults(config);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  await writeFile(
    path.join(outputRoot, 'feed.json'),
    `${JSON.stringify(createSerializableAuthoringConfig(globalDefaults), null, 2)}\n`,
    'utf8'
  );

  for (const [groupName, groupConfig] of Object.entries(config)) {
    const groupDir = path.join(outputRoot, groupName);
    await mkdir(groupDir, { recursive: true });

    const groupDefaults = createSerializableAuthoringConfig({
      feed: subtractDefaults(groupConfig.feed ?? {}, globalDefaults.feed ?? {}),
      channel: subtractDefaults(groupConfig.channel, globalDefaults.channel),
      item: subtractDefaults(groupConfig.item, globalDefaults.item),
    });

    await writeFile(
      path.join(groupDir, 'feed.json'),
      `${JSON.stringify(groupDefaults, null, 2)}\n`,
      'utf8'
    );

    for (const [route, routeConfig] of Object.entries(groupConfig.routes ?? {})) {
      const routeFile = path.join(groupDir, routeToRuleFile(route));
      await mkdir(path.dirname(routeFile), { recursive: true });

      const routePayload = createSerializableAuthoringConfig({
        feed: cloneValue(routeConfig.feed ?? {}),
        channel: cloneValue(routeConfig.channel),
        item: cloneValue(routeConfig.item),
      });

      await writeFile(routeFile, `${JSON.stringify(routePayload, null, 2)}\n`, 'utf8');
    }
  }

  return {
    groups: Object.keys(config),
    outputRoot,
  };
}

async function main() {
  const configPath = getOption('config', path.resolve('config', 'config.json'));
  const outputRoot = getOption('output-root', path.resolve('config-tree'));
  const result = await migrateConfigToTree({ configPath, outputRoot });
  process.stdout.write(
    `migrated ${result.groups.length} group(s) from ${configPath} into ${outputRoot}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
