import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { load as loadHtml } from 'cheerio';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

import {
  analyzeConfig,
  DEFAULT_FEED_SIZE_LIMIT_BYTES,
  normalizeRoute,
  routeToConfigFile,
  routeToOutputFile,
} from './lib/rules.mjs';
import { pruneRenderedValue, renderSchemaValue } from './lib/dsl.mjs';
import {
  buildSourceFeedFromState,
  limitRouteStateItems,
  loadRouteState,
  markRouteStateFailure,
  markRouteStatePublished,
  rebuildRouteStateFromSource,
  mergeSourceFeedIntoState,
  saveRouteState,
  summarizeItemChanges,
  syncRuleState,
} from './lib/state.mjs';
import { redactSensitiveText, sanitizeErrorMessage } from './lib/redaction.mjs';

const parser = new XMLParser({
  attributeNamePrefix: '@_',
  processEntities: {
    enabled: true,
    maxEntitySize: 100000,
    maxExpansionDepth: 20,
    maxTotalExpansions: 200000,
    maxExpandedLength: 6000000,
    maxEntityCount: 200000,
  },
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: '#text',
  trimValues: false,
});

const builder = new XMLBuilder({
  attributeNamePrefix: '@_',
  format: true,
  ignoreAttributes: false,
  suppressEmptyNode: true,
});

const execFileAsync = promisify(execFile);
const FATAL_CONFIG_ROUTE = "[config]";
const VALID_MODES = new Set(["incremental", "full-refresh"]);
const KNOWN_NAMESPACE_URIS = new Map([
  ['admin', 'http://webns.net/mvcb/'],
  ['atom', 'http://www.w3.org/2005/Atom'],
  ['content', 'http://purl.org/rss/1.0/modules/content/'],
  ['dc', 'http://purl.org/dc/elements/1.1/'],
  ['dcterms', 'http://purl.org/dc/terms/'],
  ['geo', 'http://www.w3.org/2003/01/geo/wgs84_pos#'],
  ['georss', 'http://www.georss.org/georss'],
  ['media', 'http://search.yahoo.com/mrss/'],
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['slash', 'http://purl.org/rss/1.0/modules/slash/'],
  ['sy', 'http://purl.org/rss/1.0/modules/syndication/'],
  ['thr', 'http://purl.org/syndication/thread/1.0'],
  ['wfw', 'http://wellformedweb.org/CommentAPI/'],
]);
const HTML_CLEANUP_REMOVE_TAGS = new Set(['script', 'style']);
const HTML_CLEANUP_UNWRAP_TAGS = new Set(['font', 'span']);
const HTML_CLEANUP_REMOVE_ATTRS = new Set(['class', 'height', 'id', 'style', 'width']);
const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function getOption(name, fallback = '') {
  const prefixed = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefixed));
  if (!match) {
    return fallback;
  }
  return match.slice(prefixed.length);
}

function buildFeedUrl(route, baseUrl) {
  if (!baseUrl) {
    return '';
  }
  return `${baseUrl.replace(/\/+$/u, '')}/${routeToOutputFile(route)}`;
}

function routeToFeedPath(route) {
  return routeToOutputFile(route);
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function applyRenderedPatch(sourceValue, patchValue) {
  if (patchValue === undefined || patchValue === true) {
    return cloneValue(sourceValue);
  }

  if (patchValue === false) {
    return undefined;
  }

  if (Array.isArray(patchValue)) {
    return pruneRenderedValue(cloneValue(patchValue));
  }

  if (!patchValue || typeof patchValue !== 'object') {
    return pruneRenderedValue(cloneValue(patchValue));
  }

  const sourceObject = isPlainObject(sourceValue) ? sourceValue : {};
  const result = {};

  for (const key of new Set([...Object.keys(sourceObject), ...Object.keys(patchValue)])) {
    const nextValue = Object.hasOwn(patchValue, key)
      ? applyRenderedPatch(sourceObject[key], patchValue[key])
      : cloneValue(sourceObject[key]);

    if (nextValue !== undefined) {
      result[key] = nextValue;
    }
  }

  return pruneRenderedValue(result);
}

function isExplicitDelete(patchValue, key) {
  return Boolean(
    patchValue &&
    typeof patchValue === 'object' &&
    !Array.isArray(patchValue) &&
    Object.hasOwn(patchValue, key) &&
    patchValue[key] === false
  );
}

function normalizeNode(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeNode(entry));
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim() : value;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeNode(entry)])
  );

  const keys = Object.keys(normalized);
  if (keys.length === 1 && keys[0] === '#text') {
    return typeof normalized['#text'] === 'string'
      ? normalized['#text'].trim()
      : normalized['#text'];
  }

  if (typeof normalized['#text'] === 'string') {
    normalized['#text'] = normalized['#text'].trim();
  }

  return normalized;
}

function cleanHtmlFragment(fragment) {
  if (typeof fragment !== 'string' || !fragment.includes('<')) {
    return fragment;
  }

  const $ = loadHtml(fragment, {}, false);

  for (const tagName of HTML_CLEANUP_REMOVE_TAGS) {
    $(tagName).remove();
  }

  $('*').each((_, element) => {
    for (const attributeName of Object.keys(element.attribs ?? {})) {
      const normalizedAttribute = attributeName.toLowerCase();
      if (
        HTML_CLEANUP_REMOVE_ATTRS.has(normalizedAttribute) ||
        normalizedAttribute.startsWith('on')
      ) {
        $(element).removeAttr(attributeName);
      }
    }
  });

  for (const tagName of HTML_CLEANUP_UNWRAP_TAGS) {
    $(tagName).each((_, element) => {
      $(element).replaceWith($(element).contents());
    });
  }

  $('*')
    .toArray()
    .reverse()
    .forEach((element) => {
      const tagName = element.tagName?.toLowerCase();
      if (!tagName || HTML_VOID_TAGS.has(tagName)) {
        return;
      }

      const hasChildren = $(element).children().length > 0;
      const textContent = $(element).text().replace(/\u00a0/gu, ' ').trim();
      if (!hasChildren && textContent === '') {
        $(element).remove();
      }
    });

  return $.root().html()?.trim() || undefined;
}

function maybeCleanRenderedDescription(rule, renderedItem) {
  if (!rule.htmlCleanup || !renderedItem || typeof renderedItem !== 'object') {
    return renderedItem;
  }

  return pruneRenderedValue({
    ...renderedItem,
    description: cleanHtmlFragment(renderedItem.description),
  });
}

function collectNamespacePrefixes(value, prefixes = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNamespacePrefixes(entry, prefixes);
    }
    return prefixes;
  }

  if (!value || typeof value !== 'object') {
    return prefixes;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.startsWith('@_') ? key.slice(2) : key;
    if (
      normalizedKey.includes(':') &&
      !normalizedKey.startsWith('xmlns:') &&
      normalizedKey !== 'xml:lang'
    ) {
      prefixes.add(normalizedKey.split(':', 1)[0]);
    }
    collectNamespacePrefixes(entry, prefixes);
  }

  return prefixes;
}

function buildNamespaceAttributes(renderedFeed) {
  const prefixes = new Set([
    ...collectNamespacePrefixes(renderedFeed.channel),
    ...collectNamespacePrefixes(renderedFeed.items),
  ]);
  const namespaceAttributes = {};

  for (const prefix of prefixes) {
    const uri = KNOWN_NAMESPACE_URIS.get(prefix);
    if (!uri) {
      continue;
    }
    namespaceAttributes[`@_xmlns:${prefix}`] = uri;
  }

  return namespaceAttributes;
}

export function parseRssDocument(xmlText) {
  const parsed = parser.parse(xmlText);
  const channelNode = parsed?.rss?.channel;
  if (!channelNode) {
    throw new Error('source feed is not RSS 2.0 channel XML');
  }

  const normalizedChannel = normalizeNode(channelNode);
  const itemNodes = asArray(normalizedChannel.item).map((item) => normalizeNode(item));
  delete normalizedChannel.item;

  return {
    channel: normalizedChannel,
    items: itemNodes.filter((item) => item && typeof item === 'object'),
  };
}

export function renderRule(rule, sourceFeed, publicBaseUrl) {
  const feedMeta = {
    path: routeToFeedPath(rule.route),
    url: buildFeedUrl(rule.route, publicBaseUrl),
  };
  const sourceMeta = {
    url: rule.source,
    channel: sourceFeed.channel,
    items: sourceFeed.items,
  };
  const now = new Date().toISOString();
  const renderedChannelPatch = renderSchemaValue(rule.channel ?? {}, {
    channel: sourceFeed.channel,
    $channel: sourceFeed.channel,
    source: sourceMeta,
    $source: sourceMeta,
    rule,
    $rule: rule,
    route: rule.route,
    $route: rule.route,
    now,
    $now: now,
    feed: feedMeta,
    $feed: feedMeta,
  });
  const appliedChannel = applyRenderedPatch(
    sourceFeed.channel,
    renderedChannelPatch ?? {}
  );
  const channel = {
    ...(appliedChannel ?? {}),
    description: isExplicitDelete(renderedChannelPatch, 'description')
      ? appliedChannel?.description
      : appliedChannel?.description ?? appliedChannel?.title,
  };
  const items = sourceFeed.items
    .map((item) =>
      {
        const renderedItemPatch = renderSchemaValue(rule.item ?? {}, {
          channel: sourceFeed.channel,
          $channel: sourceFeed.channel,
          item,
          $item: item,
          source: sourceMeta,
          $source: sourceMeta,
          rule,
          $rule: rule,
          route: rule.route,
          $route: rule.route,
          now,
          $now: now,
          feed: feedMeta,
          $feed: feedMeta,
        });

        const renderedItem = applyRenderedPatch(item, renderedItemPatch ?? {});

        if (!renderedItem || typeof renderedItem !== 'object' || Array.isArray(renderedItem)) {
          return renderedItem;
        }

        const fallbackText =
          renderedItem.title ?? renderedItem.description ?? renderedItem.link;

        return maybeCleanRenderedDescription(rule, {
          ...renderedItem,
          title: isExplicitDelete(renderedItemPatch, 'title')
            ? renderedItem.title
            : renderedItem.title ?? fallbackText,
          description: isExplicitDelete(renderedItemPatch, 'description')
            ? renderedItem.description
            : renderedItem.description ?? fallbackText,
        });
      }
    )
    .filter(Boolean);

  if (!channel?.title || !channel?.link) {
    throw new Error(
      `rule ${rule.route} must render channel.title and channel.link`
    );
  }

  return { channel, items };
}

export function buildRssXml(renderedFeed) {
  const normalizedItems = renderedFeed.items.filter(
    (item) => item.title || item.description || item.link
  );
  const namespaceAttributes = buildNamespaceAttributes(renderedFeed);
  const xmlObject = {
    rss: {
      '@_version': '2.0',
      ...namespaceAttributes,
      channel: {
        ...renderedFeed.channel,
        item: normalizedItems,
      },
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(xmlObject)}\n`;
}

async function ensureDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

async function removeIfExists(targetPath) {
  try {
    await rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function listXmlFiles(rootDir) {
  const files = [];
  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.xml')) {
        files.push(absolutePath);
      }
    }
  }

  await walk(rootDir);
  return files.sort();
}

function toActiveFileSet(activeRoutes) {
  return new Set([...activeRoutes].map((route) => routeToFeedPath(route)));
}

export async function prepareOutputDirectory(
  outputDir,
  existingDir,
  activeRoutes,
  scopedRoutes = []
) {
  await removeIfExists(outputDir);
  await ensureDirectory(outputDir);

  if (existingDir) {
    try {
      const existingStats = await stat(existingDir);
      if (existingStats.isDirectory()) {
        await cp(existingDir, outputDir, {
          recursive: true,
          filter: (sourcePath) =>
            path.basename(sourcePath) !== '.git',
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const activeFiles = toActiveFileSet(activeRoutes);
  if (scopedRoutes.length > 0) {
    for (const route of scopedRoutes) {
      const scopedOutputPath = path.join(outputDir, routeToFeedPath(route));
      if (!activeFiles.has(routeToFeedPath(route))) {
        await removeIfExists(scopedOutputPath);
      }
    }
    return;
  }

  for (const absolutePath of await listXmlFiles(outputDir)) {
    const relativePath = path.relative(outputDir, absolutePath).replace(/\\/g, '/');
    if (!activeFiles.has(relativePath)) {
      await unlink(absolutePath);
    }
  }
}

async function fetchTextWithHttp(url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      'user-agent': 'refeed-workflow/0.1',
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchTextWithCurl(url, timeoutMs, curlExecFile) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refeed-fetch-'));
  const outputPath = path.join(tempDir, 'source.xml');

  try {
    await curlExecFile('curl', [
      '-L',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      String(seconds),
      '-A',
      'refeed-workflow/0.1',
      '-H',
      'Accept: application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      '-o',
      outputPath,
      url,
    ]);
    return readFile(outputPath, 'utf8');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchText(url, timeoutMs, fetchImpl, curlExecFile) {
  if (fetchImpl === fetch) {
    return fetchTextWithCurl(url, timeoutMs, curlExecFile);
  }
  return fetchTextWithHttp(url, timeoutMs, fetchImpl);
}

function measureUtf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

function formatByteLimit(bytes) {
  const mib = bytes / (1024 * 1024);
  const rounded = Number.isInteger(mib) ? String(mib) : mib.toFixed(2).replace(/\.0+$/u, '');
  return `${rounded} MiB`;
}

function assertWithinByteLimit(kind, route, actualBytes, limitBytes) {
  if (!Number.isInteger(limitBytes) || limitBytes <= 0 || actualBytes <= limitBytes) {
    return;
  }

  const error = new Error(
    `${kind} exceeds limit for ${route}: ${actualBytes} bytes > ${limitBytes} bytes (${formatByteLimit(limitBytes)})`
  );
  error.code = 'FEED_SIZE_LIMIT';
  throw error;
}

async function fetchOnce(url, timeoutMs, fetchImpl, curlExecFile) {
  return fetchText(url, timeoutMs, fetchImpl, curlExecFile);
}

function buildRetryFailureError(retries, lastError) {
  return new Error(`failed after ${retries} attempt(s): ${sanitizeErrorMessage(lastError)}`);
}

function countPreservedFiles(outputDir) {
  return listXmlFiles(outputDir).then((files) => files.length);
}

function limitOutputFeed(stateFeed, itemLimit) {
  if (!Number.isInteger(itemLimit) || itemLimit <= 0) {
    return stateFeed;
  }

  return {
    channel: stateFeed.channel,
    items: stateFeed.items.slice(0, itemLimit),
    itemIds: stateFeed.itemIds.slice(0, itemLimit),
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function routeHostname(rule) {
  try {
    return new URL(rule.source).host || rule.route;
  } catch {
    return rule.route;
  }
}

async function processRouteEntry({
  entry,
  stateDir,
  report,
  outputDir,
  mode,
  timeoutMs,
  retries,
  publicBaseUrl,
  fetchImpl,
  curlExecFile,
}) {
  const { rule, outputPath, existingState } = entry;
  const redactionOptions = {};
  await ensureDirectory(path.dirname(outputPath));
  const now = new Date().toISOString();
  let stage = 'fetch';
  let attempts = entry.attempts;

  try {
    let xmlText;
    try {
      xmlText = await fetchOnce(rule.source, timeoutMs, fetchImpl, curlExecFile);
      attempts = entry.attempts + 1;
    } catch (error) {
      entry.attempts += 1;
      entry.lastFetchError = error;
      if (entry.attempts < retries) {
        return { status: 'retry', entry };
      }
      attempts = entry.attempts;
      throw buildRetryFailureError(retries, entry.lastFetchError);
    }

    assertWithinByteLimit(
      'source feed size',
      rule.route,
      measureUtf8Bytes(xmlText),
      DEFAULT_FEED_SIZE_LIMIT_BYTES
    );
    stage = 'parse';
    const sourceFeed = parseRssDocument(xmlText);
    stage = 'merge';
    const nextState =
      mode === 'full-refresh'
        ? rebuildRouteStateFromSource(rule, sourceFeed, now)
        : mergeSourceFeedIntoState(existingState, rule, sourceFeed, now);
    const retainedState = limitRouteStateItems(nextState, rule.stateLimit);
    const itemStats = summarizeItemChanges(existingState, retainedState);
    stage = 'render';
    const stateFeed = buildSourceFeedFromState(retainedState);
    const limitedFeed = limitOutputFeed(stateFeed, rule.itemLimit);
    const rendered = renderRule(rule, limitedFeed, publicBaseUrl);
    const payload = buildRssXml(rendered);
    assertWithinByteLimit(
      'output feed size',
      rule.route,
      measureUtf8Bytes(payload),
      DEFAULT_FEED_SIZE_LIMIT_BYTES
    );
    stage = 'publish';
    await writeFile(outputPath, payload, 'utf8');
    const publishedState = markRouteStatePublished(retainedState, limitedFeed.itemIds, now);
    await saveRouteState(stateDir, publishedState);
    process.stdout.write(`generated ${rule.route} -> ${routeToFeedPath(rule.route)}\n`);

    return {
      status: 'success',
      route: rule.route,
      attempts,
      itemStats,
      outputItems: limitedFeed.itemIds.length,
    };
  } catch (error) {
    const sanitizedError = sanitizeErrorMessage(error, redactionOptions);
    if (error?.code === 'FEED_SIZE_LIMIT') {
      await removeIfExists(outputPath);
    }
    const failedState = markRouteStateFailure(existingState, rule, {
      now,
      error: new Error(sanitizedError),
      attempts,
      stage,
    });
    await saveRouteState(stateDir, failedState);
    process.stderr.write(`skipped ${rule.route}: ${sanitizedError}\n`);

    return {
      status: 'failed',
      route: rule.route,
      attempts,
      error: sanitizedError,
    };
  }
}

async function publishFetchQueue({
  fetchQueue,
  stateDir,
  report,
  outputDir,
  mode,
  timeoutMs,
  retries,
  publicBaseUrl,
  fetchImpl,
  curlExecFile,
  fetchConcurrency,
  perHostConcurrency,
}) {
  const pendingQueue = [...fetchQueue];
  const activeHosts = new Map();
  const activeTasks = new Set();
  const results = [];

  function canRunHost(host) {
    return (activeHosts.get(host) ?? 0) < perHostConcurrency;
  }

  function startEntry(entry) {
    const host = routeHostname(entry.rule);
    activeHosts.set(host, (activeHosts.get(host) ?? 0) + 1);

    const task = processRouteEntry({
      entry,
      stateDir,
      report,
      outputDir,
      mode,
      timeoutMs,
      retries,
      publicBaseUrl,
      fetchImpl,
      curlExecFile,
    }).then((result) => ({ result, host, entry }));

    activeTasks.add(task);
    task.finally(() => {
      activeTasks.delete(task);
      const nextCount = (activeHosts.get(host) ?? 1) - 1;
      if (nextCount <= 0) {
        activeHosts.delete(host);
      } else {
        activeHosts.set(host, nextCount);
      }
    });
  }

  while (pendingQueue.length > 0 || activeTasks.size > 0) {
    let started = false;

    while (activeTasks.size < fetchConcurrency) {
      const nextIndex = pendingQueue.findIndex((entry) => canRunHost(routeHostname(entry.rule)));
      if (nextIndex === -1) {
        break;
      }
      const [entry] = pendingQueue.splice(nextIndex, 1);
      startEntry(entry);
      started = true;
    }

    if (activeTasks.size === 0) {
      if (!started) {
        break;
      }
      continue;
    }

    const settled = await Promise.race(activeTasks);
    const { result } = settled;
    if (result.status === 'retry') {
      pendingQueue.push(result.entry);
      continue;
    }
    results.push(result);
  }

  return results;
}

export async function publishFeeds({
  configPath = routeToConfigFile(),
  stateDir = 'state',
  outputDir,
  existingDir,
  reportPath,
  publicBaseUrl,
  retries,
  timeoutMs,
  route = '',
  mode = 'incremental',
  fetchConcurrency = 1,
  perHostConcurrency = 1,
  fetchImpl = fetch,
  curlExecFile = execFileAsync,
}) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`invalid publish mode: ${mode}`);
  }

  const analysis = await analyzeConfig(configPath);
  const rules = analysis.rules;
  const scopedRoute = route ? normalizeRoute(route) : '';
  if (mode === 'full-refresh' && !scopedRoute) {
    throw new Error('mode=full-refresh requires --route');
  }

  const scopedRules = scopedRoute
    ? rules.filter((rule) => normalizeRoute(rule.route) === scopedRoute)
    : rules;
  if (scopedRoute && scopedRules.length === 0) {
    throw new Error(`unknown scoped route: ${scopedRoute}`);
  }
  if (scopedRoute && scopedRules.some((rule) => !rule.enabled)) {
    throw new Error(`scoped route is disabled: ${scopedRoute}`);
  }

  const activeRoutes = new Set(
    rules.filter((rule) => rule.enabled).map((rule) => normalizeRoute(rule.route))
  );
  const rulesToProcess = scopedRoute
    ? scopedRules.filter((rule) => rule.enabled)
    : rules.filter((rule) => rule.enabled);
  const disabledRules = scopedRoute
    ? scopedRules.filter((rule) => !rule.enabled)
    : rules.filter((rule) => !rule.enabled);

  const report = {
    generatedAt: new Date().toISOString(),
    publicBaseUrl: publicBaseUrl ?? '',
    hasFatalConfigErrors: analysis.hasFatalErrors,
    configDiagnostics: analysis.diagnostics,
    mode,
    scopedRoutes: scopedRoute ? [scopedRoute] : [],
    totals: {
      rules: rules.length,
      enabled: activeRoutes.size,
      processed: rulesToProcess.length,
      succeeded: 0,
      failed: 0,
      newItems: 0,
      deletedItems: 0,
      outputItems: 0,
    },
    activeRoutes: [...activeRoutes].sort(),
    successfulRoutes: [],
    failedRoutes: [],
  };

  if (analysis.hasFatalErrors) {
    report.totals.failed = 1;
    report.failedRoutes.push({
      route: FATAL_CONFIG_ROUTE,
      source: configPath,
      outputPath: routeToConfigFile(),
      attempts: 0,
      error:
        analysis.diagnostics
          .map((entry) => {
            const lineText = entry.line ? `L${entry.line}` : 'L?';
            return redactSensitiveText(`${lineText} ${entry.path}: ${entry.message}`, {
              configRoot: path.dirname(configPath),
            });
          })
          .join('\n') || 'fatal config diagnostics detected',
    });
    if (reportPath) {
      await ensureDirectory(path.dirname(reportPath));
      await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }
    process.stderr.write('config analysis failed; preserving existing feed artifacts\n');
    return report;
  }

  await prepareOutputDirectory(
    outputDir,
    existingDir,
    activeRoutes,
    scopedRoute ? [scopedRoute] : []
  );

  const fetchQueue = [];
  for (const rule of rulesToProcess) {
    fetchQueue.push({
      rule,
      outputPath: path.join(outputDir, routeToFeedPath(rule.route)),
      existingState: await loadRouteState(stateDir, rule.route),
      attempts: 0,
      lastFetchError: null,
    });
  }

  const routeResults = await publishFetchQueue({
    fetchQueue,
    stateDir,
    report,
    outputDir,
    mode,
    timeoutMs,
    retries,
    publicBaseUrl,
    fetchImpl,
    curlExecFile,
    fetchConcurrency,
    perHostConcurrency,
  });

  for (const result of routeResults.sort((left, right) => left.route.localeCompare(right.route))) {
    if (result.status === 'success') {
      report.totals.succeeded += 1;
      report.totals.newItems += result.itemStats.newItems;
      report.totals.deletedItems += result.itemStats.deletedItems;
      report.totals.outputItems += result.outputItems;
      report.successfulRoutes.push({
        route: result.route,
        outputPath: routeToFeedPath(result.route),
        attempts: result.attempts,
        newItems: result.itemStats.newItems,
        deletedItems: result.itemStats.deletedItems,
        outputItems: result.outputItems,
      });
      continue;
    }

    report.totals.failed += 1;
    report.failedRoutes.push({
      route: result.route,
      outputPath: routeToFeedPath(result.route),
      attempts: result.attempts,
      error: result.error,
      newItems: 0,
      deletedItems: 0,
      outputItems: 0,
    });
  }

  for (const rule of disabledRules) {
    const now = new Date().toISOString();
    const existingState = await loadRouteState(stateDir, rule.route);
    const disabledState = syncRuleState(existingState, rule, now);
    await saveRouteState(stateDir, disabledState);
  }

  if (reportPath) {
    await ensureDirectory(path.dirname(reportPath));
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }

  const publishedFiles = await countPreservedFiles(outputDir);
  if (report.totals.succeeded > 0 && publishedFiles === 0) {
    throw new Error('no feed artifacts available after generation');
  }

  return report;
}

async function main() {
  const configPath = getOption(
    '--config',
    process.env.REFEED_CONFIG_PATH ?? routeToConfigFile()
  );
  const stateDir = getOption('--state-dir', process.env.REFEED_STATE_DIR ?? 'state');
  const outputDir = getOption('--output-dir', process.env.REFEED_OUTPUT_DIR ?? 'dist-feed');
  const existingDir = getOption('--existing-dir', process.env.REFEED_EXISTING_DIR ?? '');
  const route = getOption('--route', process.env.REFEED_ROUTE ?? '');
  const mode = getOption('--mode', process.env.REFEED_MODE ?? 'incremental');
  const reportPath = getOption(
    '--report-path',
    process.env.REFEED_REPORT_PATH ?? path.join(outputDir, '_report.json')
  );
  const publicBaseUrl = getOption(
    '--public-base-url',
    process.env.REFEED_PUBLIC_BASE_URL ?? ''
  );
  const retries = Number.parseInt(
    getOption('--retries', process.env.REFEED_FETCH_RETRIES ?? '3'),
    10
  );
  const fetchConcurrency = parsePositiveInteger(
    getOption('--fetch-concurrency', process.env.REFEED_FETCH_CONCURRENCY ?? '1'),
    1
  );
  const perHostConcurrency = parsePositiveInteger(
    getOption('--per-host-concurrency', process.env.REFEED_FETCH_PER_HOST_CONCURRENCY ?? '1'),
    1
  );
  const timeoutMs = Number.parseInt(
    getOption('--timeout-ms', process.env.REFEED_FETCH_TIMEOUT_MS ?? '20000'),
    10
  );

  const report = await publishFeeds({
    configPath,
    stateDir,
    outputDir,
    existingDir,
    reportPath,
    publicBaseUrl,
    retries,
    fetchConcurrency,
    perHostConcurrency,
    timeoutMs,
    route,
    mode,
  });

  if (report.hasFatalConfigErrors) {
    process.stdout.write(
      `publish skipped by fatal config diagnostics (${report.configDiagnostics.length})\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `completed publish run: ${report.totals.succeeded} succeeded, ${report.totals.failed} failed\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
