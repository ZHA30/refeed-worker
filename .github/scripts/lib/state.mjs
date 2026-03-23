import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeRoute } from "./rules.mjs";

export const STATE_VERSION = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function toIsoTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function readTextValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isPlainObject(value) && typeof value["#text"] === "string") {
    return value["#text"].trim();
  }
  return "";
}

function createFallbackItemId(item) {
  const digest = createHash("sha1")
    .update(JSON.stringify(item))
    .digest("hex");
  return `generated:${digest}`;
}

function extractItemIdentity(item) {
  const guid = readTextValue(item?.guid);
  if (guid) {
    return {
      id: `guid:${guid}`,
      guid,
      link: readTextValue(item?.link) || null,
    };
  }

  const link = readTextValue(item?.link);
  if (link) {
    return {
      id: `link:${link}`,
      guid: null,
      link,
    };
  }

  return {
    id: createFallbackItemId(item),
    guid: null,
    link: null,
  };
}

function extractPublishedAt(item) {
  const candidates = [
    item?.pubDate,
    item?.published,
    item?.updated,
    item?.["dc:date"],
  ];

  for (const candidate of candidates) {
    const normalized = toIsoTimestamp(readTextValue(candidate));
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function buildErrorPayload(error, attempts, now, stage = "publish") {
  return {
    at: now,
    message: error?.message ?? String(error),
    attempts,
    stage,
  };
}

function buildBaseState(existingState, rule, now, { preservePayload = false } = {}) {
  const sourceChanged =
    existingState?.source &&
    typeof existingState.source === "string" &&
    existingState.source !== rule.source;
  const resetPayload =
    !isPlainObject(existingState) || (!preservePayload && sourceChanged);

  return {
    route: normalizeRoute(rule.route),
    group: rule.group ?? existingState?.group ?? "",
    source: rule.source,
    enabled: rule.enabled,
    version: STATE_VERSION,
    addedAt: existingState?.addedAt ?? now,
    disabledAt: rule.enabled
      ? null
      : existingState?.disabledAt ?? now,
    updatedAt: existingState?.updatedAt ?? existingState?.addedAt ?? now,
    lastAttemptAt: existingState?.lastAttemptAt ?? null,
    lastSuccessAt: resetPayload ? null : existingState?.lastSuccessAt ?? null,
    lastError: resetPayload ? null : cloneValue(existingState?.lastError ?? null),
    lastSuccessfulTitle: resetPayload
      ? ""
      : existingState?.lastSuccessfulTitle ?? "",
    channel:
      resetPayload || !isPlainObject(existingState?.channel)
        ? {}
        : cloneValue(existingState.channel),
    items:
      resetPayload || !isPlainObject(existingState?.items)
        ? {}
        : cloneValue(existingState.items),
  };
}

export function routeToStateFile(route) {
  return `${normalizeRoute(route)}.json`;
}

export function routeToStatePath(stateDir, route) {
  return path.join(stateDir, routeToStateFile(route));
}

export async function loadRouteState(stateDir, route) {
  const statePath = routeToStatePath(stateDir, route);
  try {
    const rawText = await readFile(statePath, "utf8");
    const parsed = JSON.parse(rawText);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadStatesForRules(stateDir, rules) {
  const entries = await Promise.all(
    rules.map(async (rule) => [rule.route, await loadRouteState(stateDir, rule.route)])
  );
  return Object.fromEntries(entries);
}

export async function saveRouteState(stateDir, state) {
  const statePath = routeToStatePath(stateDir, state.route);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function syncRuleState(existingState, rule, now) {
  const nextState = buildBaseState(existingState, rule, now);
  nextState.updatedAt = now;
  if (!rule.enabled && !nextState.disabledAt) {
    nextState.disabledAt = now;
  }
  if (rule.enabled) {
    nextState.disabledAt = null;
  }
  return nextState;
}

function applySourceFeedToState(nextState, sourceFeed, now) {
  nextState.lastAttemptAt = now;
  nextState.lastSuccessAt = now;
  nextState.lastError = null;
  nextState.channel = cloneValue(sourceFeed.channel ?? {});

  const channelTitle = readTextValue(sourceFeed.channel?.title);
  if (channelTitle) {
    nextState.lastSuccessfulTitle = channelTitle;
  }

  for (const rawItem of sourceFeed.items ?? []) {
    const identity = extractItemIdentity(rawItem);
    const existingEntry = isPlainObject(nextState.items[identity.id])
      ? nextState.items[identity.id]
      : {};
    nextState.items[identity.id] = {
      id: identity.id,
      guid: identity.guid ?? existingEntry.guid ?? null,
      link: identity.link ?? existingEntry.link ?? null,
      publishedAt: extractPublishedAt(rawItem) ?? existingEntry.publishedAt ?? null,
      firstSeenAt: existingEntry.firstSeenAt ?? now,
      lastSeenAt: now,
      lastPublishedAt: existingEntry.lastPublishedAt ?? null,
      raw: cloneValue(rawItem),
    };
  }

  return nextState;
}

export function mergeSourceFeedIntoState(existingState, rule, sourceFeed, now) {
  return applySourceFeedToState(syncRuleState(existingState, rule, now), sourceFeed, now);
}

export function rebuildRouteStateFromSource(rule, sourceFeed, now) {
  return applySourceFeedToState(syncRuleState(null, rule, now), sourceFeed, now);
}

export function markRouteStateFailure(
  existingState,
  rule,
  { now, error, attempts, stage = "publish" }
) {
  const nextState = buildBaseState(existingState, rule, now, {
    preservePayload: true,
  });
  nextState.updatedAt = now;
  if (!rule.enabled && !nextState.disabledAt) {
    nextState.disabledAt = now;
  }
  if (rule.enabled) {
    nextState.disabledAt = null;
  }
  nextState.lastAttemptAt = now;
  nextState.lastError = buildErrorPayload(error, attempts, now, stage);
  return nextState;
}

export function summarizeItemChanges(previousState, nextState) {
  const previousIds = new Set(Object.keys(previousState?.items ?? {}));
  const nextIds = new Set(Object.keys(nextState?.items ?? {}));
  let newItems = 0;
  let deletedItems = 0;

  for (const itemId of nextIds) {
    if (!previousIds.has(itemId)) {
      newItems += 1;
    }
  }

  for (const itemId of previousIds) {
    if (!nextIds.has(itemId)) {
      deletedItems += 1;
    }
  }

  return { newItems, deletedItems };
}

function compareStateItems(left, right) {
  const leftPublished = left.publishedAt ?? "";
  const rightPublished = right.publishedAt ?? "";
  if (leftPublished !== rightPublished) {
    return rightPublished.localeCompare(leftPublished);
  }

  const leftFirstSeen = left.firstSeenAt ?? "";
  const rightFirstSeen = right.firstSeenAt ?? "";
  if (leftFirstSeen !== rightFirstSeen) {
    return rightFirstSeen.localeCompare(leftFirstSeen);
  }

  return String(left.id).localeCompare(String(right.id));
}

function listSortedStateEntries(state) {
  return Object.values(state.items ?? {})
    .filter((entry) => isPlainObject(entry?.raw))
    .sort(compareStateItems);
}

export function limitRouteStateItems(state, statelimit) {
  if (!Number.isInteger(statelimit) || statelimit <= 0) {
    return cloneValue(state);
  }

  const nextState = cloneValue(state);
  const retainedEntries = listSortedStateEntries(state).slice(0, statelimit);
  nextState.items = Object.fromEntries(retainedEntries.map((entry) => [entry.id, cloneValue(entry)]));
  return nextState;
}

export function buildSourceFeedFromState(state) {
  const entries = listSortedStateEntries(state);

  return {
    channel: cloneValue(state.channel ?? {}),
    items: entries.map((entry) => cloneValue(entry.raw)),
    itemIds: entries.map((entry) => entry.id),
  };
}

export function markRouteStatePublished(existingState, itemIds, now) {
  const nextState = cloneValue(existingState);
  nextState.updatedAt = now;

  for (const itemId of itemIds) {
    if (!isPlainObject(nextState.items?.[itemId])) {
      continue;
    }
    nextState.items[itemId].lastPublishedAt = now;
  }

  return nextState;
}
