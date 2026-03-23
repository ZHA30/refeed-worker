import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { parseJsonDocument } from './config-diagnostics.mjs';
import {
  mergeConfigPatchValue,
  normalizeRoute,
  pruneConfigPatchContainer,
} from './rules.mjs';

const DEFAULTS_FILE_NAME = 'feed.json';
const ROOT_IGNORED_FILES = new Set(['config.schema.json']);
const AUTHORING_ALLOWED_KEYS = new Set(['feed', 'channel', 'item']);
const DEFAULTS_FORBIDDEN_FEED_KEYS = new Set(['source']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function walkJsonFiles(rootDir, currentDir = rootDir) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' && currentDir === rootDir) {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(rootDir, absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(absolutePath);
    }
  }

  return files.sort();
}

function toPortablePath(segments) {
  return segments.join('/');
}

function pathSegmentsFrom(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).filter(Boolean);
}

function parseJsonFile(rawText, filePath) {
  const parsed = parseJsonDocument(rawText);
  if (parsed.parseError) {
    const lineText = parsed.parseError.line ? `L${parsed.parseError.line}` : 'L?';
    throw new Error(`${lineText} invalid JSON in ${filePath}: ${parsed.parseError.message}`);
  }
  return parsed.value;
}

function normalizeAuthoringConfig(rawValue, filePath, { defaultsFile = false } = {}) {
  if (!isPlainObject(rawValue)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }

  for (const key of Object.keys(rawValue)) {
    if (!AUTHORING_ALLOWED_KEYS.has(key)) {
      throw new Error(`${filePath} contains unsupported top-level key "${key}"`);
    }
  }

  if (rawValue.feed !== undefined && !isPlainObject(rawValue.feed)) {
    throw new Error(`${filePath} field "feed" must be an object`);
  }
  if (rawValue.channel !== undefined && !isPlainObject(rawValue.channel)) {
    throw new Error(`${filePath} field "channel" must be an object`);
  }
  if (rawValue.item !== undefined && !isPlainObject(rawValue.item)) {
    throw new Error(`${filePath} field "item" must be an object`);
  }

  if (defaultsFile) {
    for (const key of DEFAULTS_FORBIDDEN_FEED_KEYS) {
      if (Object.hasOwn(rawValue.feed ?? {}, key)) {
        throw new Error(`${filePath} must not define feed.${key}`);
      }
    }
  }

  return {
    feed: cloneValue(rawValue.feed ?? {}),
    channel: cloneValue(rawValue.channel),
    item: cloneValue(rawValue.item),
  };
}

function mergeFeedControls(baseValue, overlayValue) {
  return {
    ...(cloneValue(baseValue) ?? {}),
    ...(cloneValue(overlayValue) ?? {}),
  };
}

function mergePatchContainers(baseValue, overlayValue) {
  return pruneConfigPatchContainer(mergeConfigPatchValue(baseValue, overlayValue));
}

function mergeAuthoringLayers(baseLayer, overlayLayer) {
  return {
    feed: mergeFeedControls(baseLayer.feed, overlayLayer.feed),
    channel: mergePatchContainers(baseLayer.channel, overlayLayer.channel),
    item: mergePatchContainers(baseLayer.item, overlayLayer.item),
  };
}

function ensureRouteSource(routeConfig, filePath) {
  const source = routeConfig.feed?.source;
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error(`${filePath} must define feed.source as a non-empty string`);
  }
}

function routeFromFileSegments(fileSegments) {
  if (fileSegments.length < 2) {
    throw new Error(
      `route config files must live under config/<group>/..., got ${fileSegments.join('/')}`
    );
  }

  const routeSegments = [...fileSegments.slice(1, -1), fileSegments.at(-1).replace(/\.json$/u, '')];
  return normalizeRoute(routeSegments.join('/'));
}

function createEmptyLayer() {
  return {
    feed: {},
    channel: undefined,
    item: undefined,
  };
}

export async function buildRuntimeConfigFromTree(configRoot) {
  const resolvedRoot = path.resolve(configRoot);
  const files = await walkJsonFiles(resolvedRoot);
  const defaultsByDir = new Map();
  const routeFiles = [];

  for (const filePath of files) {
    const rawText = await readFile(filePath, 'utf8');
    const rawValue = parseJsonFile(rawText, filePath);
    const segments = pathSegmentsFrom(resolvedRoot, filePath);

    if (segments.length === 1) {
      if (segments[0] === DEFAULTS_FILE_NAME) {
        defaultsByDir.set('', normalizeAuthoringConfig(rawValue, filePath, { defaultsFile: true }));
        continue;
      }
      if (ROOT_IGNORED_FILES.has(segments[0])) {
        continue;
      }
      throw new Error(`unexpected root-level config file: ${filePath}`);
    }

    if (segments.at(-1) === DEFAULTS_FILE_NAME) {
      const dirKey = toPortablePath(segments.slice(0, -1));
      defaultsByDir.set(
        dirKey,
        normalizeAuthoringConfig(rawValue, filePath, { defaultsFile: true })
      );
      continue;
    }

    routeFiles.push({
      filePath,
      segments,
      config: normalizeAuthoringConfig(rawValue, filePath),
    });
  }

  const groups = new Map();
  const seenRoutes = new Map();

  for (const entry of routeFiles) {
    const groupName = entry.segments[0];
    const route = routeFromFileSegments(entry.segments);

    if (seenRoutes.has(route)) {
      throw new Error(
        `duplicate route detected: ${route} (${seenRoutes.get(route)} and ${entry.filePath})`
      );
    }
    seenRoutes.set(route, entry.filePath);

    let merged = createEmptyLayer();
    const directoryPrefixes = [''];
    for (let length = 1; length < entry.segments.length; length += 1) {
      directoryPrefixes.push(toPortablePath(entry.segments.slice(0, length)));
    }

    for (const dirKey of directoryPrefixes) {
      const defaults = defaultsByDir.get(dirKey);
      if (defaults) {
        merged = mergeAuthoringLayers(merged, defaults);
      }
    }

    merged = mergeAuthoringLayers(merged, entry.config);
    ensureRouteSource(merged, entry.filePath);

    const groupConfig = groups.get(groupName) ?? { routes: {} };
    groupConfig.routes[route] = {
      feed: merged.feed,
      ...(merged.channel !== undefined ? { channel: merged.channel } : {}),
      ...(merged.item !== undefined ? { item: merged.item } : {}),
    };
    groups.set(groupName, groupConfig);
  }

  return Object.fromEntries(groups.entries());
}

export async function writeRuntimeConfigFromTree({ configRoot, outputPath }) {
  const runtimeConfig = await buildRuntimeConfigFromTree(configRoot);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');
  return runtimeConfig;
}

function getOption(name, fallback = '') {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function main() {
  const configRoot = getOption('config-root', path.resolve('config'));
  const outputPath = getOption('output', path.resolve('build', 'config.runtime.json'));
  const runtimeConfig = await writeRuntimeConfigFromTree({ configRoot, outputPath });
  process.stdout.write(
    `compiled ${Object.keys(runtimeConfig).length} group(s) from ${configRoot} into ${outputPath}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
