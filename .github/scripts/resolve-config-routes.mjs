import path from 'node:path';
import process from 'node:process';

import { buildRuntimeConfigFromTree } from './lib/config-tree.mjs';
import { normalizeRoute } from './lib/rules.mjs';

function getOption(name, fallback = '') {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function toPortablePath(value) {
  return value.replace(/\\/gu, '/');
}

function routeFromConfigFile(configRoot, changedFile) {
  const relativePath = toPortablePath(path.relative(configRoot, changedFile));
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  if (segments.at(-1) === 'feed.json') {
    return null;
  }
  if (!segments.at(-1)?.endsWith('.json')) {
    return null;
  }

  const routeSegments = [...segments.slice(1, -1), segments.at(-1).replace(/\.json$/u, '')];
  return normalizeRoute(routeSegments.join('/'));
}

function dirKeyFromDefaultsFile(configRoot, changedFile) {
  const relativePath = toPortablePath(path.relative(configRoot, changedFile));
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.at(-1) !== 'feed.json') {
    return null;
  }
  return segments.slice(0, -1).join('/');
}

function matchesDirKey(route, dirKey) {
  if (!dirKey) {
    return true;
  }
  const routePath = route.split('/');
  const dirPath = dirKey.split('/').filter(Boolean);
  if (dirPath.length === 0) {
    return true;
  }
  if (dirPath.length === 1) {
    return true;
  }
  const expected = dirPath.slice(1);
  return expected.every((segment, index) => routePath[index] === segment);
}

export async function resolveAffectedRoutes({ configRoot, changedFiles }) {
  const runtimeConfig = await buildRuntimeConfigFromTree(configRoot);
  const allRoutes = Object.values(runtimeConfig)
    .flatMap((group) => Object.keys(group.routes ?? {}))
    .sort();

  const normalizedFiles = changedFiles
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  if (normalizedFiles.length === 0) {
    return { mode: 'none', routes: [] };
  }

  const routeSet = new Set();
  let fullRefresh = false;

  for (const changedFile of normalizedFiles) {
    const relativePath = toPortablePath(path.relative(configRoot, changedFile));
    if (relativePath.startsWith('..')) {
      continue;
    }
    if (relativePath === 'README.md' || relativePath === 'config.schema.json') {
      continue;
    }
    if (relativePath === 'feed.json') {
      fullRefresh = true;
      break;
    }

    const route = routeFromConfigFile(configRoot, changedFile);
    if (route) {
      routeSet.add(route);
      continue;
    }

    const dirKey = dirKeyFromDefaultsFile(configRoot, changedFile);
    if (dirKey !== null) {
      for (const candidate of allRoutes) {
        if (matchesDirKey(candidate, dirKey)) {
          routeSet.add(candidate);
        }
      }
    }
  }

  if (fullRefresh) {
    return { mode: 'all', routes: allRoutes };
  }

  return {
    mode: routeSet.size > 0 ? 'partial' : 'none',
    routes: [...routeSet].sort(),
  };
}

async function main() {
  const configRoot = path.resolve(getOption('config-root', 'config'));
  const changedFiles = getOption('changed-files', '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const result = await resolveAffectedRoutes({ configRoot, changedFiles });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
