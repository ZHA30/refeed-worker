import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  formatConfigPath,
  lookupPathLine,
  parseJsonDocument,
  sortDiagnostics,
} from "./config-diagnostics.mjs";
import { parseTemplatePath } from "./dsl.mjs";

const GROUP_RECOGNIZED_KEYS = new Set([
  "feed",
  "channel",
  "item",
  "routes",
]);
const ROUTE_RECOGNIZED_KEYS = new Set([
  "feed",
  "channel",
  "item",
]);
const GROUP_FEED_RECOGNIZED_KEYS = new Set([
  "enabled",
  "htmlcleanup",
  "itemlimit",
  "statelimit",
]);
const ROUTE_FEED_RECOGNIZED_KEYS = new Set([
  "source",
  "enabled",
  "htmlcleanup",
  "itemlimit",
  "statelimit",
]);
const LEGACY_SCHEMA_KEY = "schema";
export const DEFAULT_FEED_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

export const CONFIG_FILE_NAME = path.join("config", "config.json");

export class ConfigValidationError extends Error {
  constructor(message, analysis) {
    super(message);
    this.name = "ConfigValidationError";
    this.analysis = analysis;
  }
}

export { ConfigValidationError as ConfigAnalysisError };

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function createAnalysis(configPath, rawText = "") {
  return {
    configPath,
    rawText,
    rules: [],
    diagnostics: [],
    fatalErrors: [],
    hasFatalErrors: false,
  };
}

function pushDiagnostic(
  analysis,
  { severity, code, pathSegments = [], key = "", line = null, message }
) {
  const diagnostic = {
    severity,
    code,
    path: formatConfigPath(pathSegments),
    key,
    line,
    message,
  };
  analysis.diagnostics.push(diagnostic);
  if (severity === "error") {
    analysis.fatalErrors.push(diagnostic);
    analysis.hasFatalErrors = true;
  }
  return diagnostic;
}

function reportError(analysis, code, pathSegments, message, keyLocations, key = "") {
  return pushDiagnostic(analysis, {
    severity: "error",
    code,
    pathSegments,
    key,
    line: lookupPathLine(keyLocations, pathSegments),
    message,
  });
}

function reportWarning(analysis, code, pathSegments, message, keyLocations, key = "") {
  return pushDiagnostic(analysis, {
    severity: "warning",
    code,
    pathSegments,
    key,
    line: lookupPathLine(keyLocations, pathSegments),
    message,
  });
}

function finalizeAnalysis(analysis) {
  analysis.diagnostics = sortDiagnostics(analysis.diagnostics);
  analysis.fatalErrors = analysis.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  );
  analysis.hasFatalErrors = analysis.fatalErrors.length > 0;
  return analysis;
}

function buildGroupPath(groupName) {
  return [groupName];
}

function buildRoutePath(groupName, rawRoute) {
  return [groupName, "routes", rawRoute];
}

function validateTemplateString(template, pathSegments, analysis, keyLocations) {
  let index = 0;

  while (index < template.length) {
    const open = template.indexOf("{{", index);
    const close = template.indexOf("}}", index);

    if (close !== -1 && (open === -1 || close < open)) {
      reportError(
        analysis,
        "invalid-template",
        pathSegments,
        `unmatched template closing braces at ${formatConfigPath(pathSegments)}`,
        keyLocations
      );
      return false;
    }

    if (open === -1) {
      break;
    }

    const end = template.indexOf("}}", open + 2);
    if (end === -1) {
      reportError(
        analysis,
        "invalid-template",
        pathSegments,
        `unterminated template expression at ${formatConfigPath(pathSegments)}`,
        keyLocations
      );
      return false;
    }

    const expression = template.slice(open + 2, end).trim();
    try {
      parseTemplatePath(expression);
    } catch (error) {
      reportError(
        analysis,
        "invalid-template",
        pathSegments,
        `invalid DSL expression at ${formatConfigPath(pathSegments)}: ${error.message}`,
        keyLocations
      );
      return false;
    }

    index = end + 2;
  }

  return true;
}

function validatePatchValue(value, pathSegments, analysis, keyLocations) {
  if (value === null) {
    reportError(
      analysis,
      "invalid-null",
      pathSegments,
      `null is not allowed at ${formatConfigPath(pathSegments)}`,
      keyLocations
    );
    return false;
  }

  if (typeof value === "string") {
    return validateTemplateString(value, pathSegments, analysis, keyLocations);
  }

  if (Array.isArray(value)) {
    let valid = true;
    value.forEach((entry, index) => {
      valid =
        validatePatchValue(entry, [...pathSegments, index], analysis, keyLocations) &&
        valid;
    });
    return valid;
  }

  if (!isPlainObject(value)) {
    return true;
  }

  let valid = true;
  for (const [key, entry] of Object.entries(value)) {
    valid =
      validatePatchValue(entry, [...pathSegments, key], analysis, keyLocations) &&
      valid;
  }
  return valid;
}

function validatePatchObject(value, pathSegments, analysis, keyLocations) {
  if (!isPlainObject(value)) {
    reportError(
      analysis,
      "invalid-patch-object",
      pathSegments,
      `${formatConfigPath(pathSegments)} must be an object`,
      keyLocations
    );
    return false;
  }
  return validatePatchValue(value, pathSegments, analysis, keyLocations);
}

export function mergeConfigPatchValue(baseValue, overlayValue) {
  if (overlayValue === undefined || overlayValue === true) {
    return cloneValue(baseValue);
  }

  if (overlayValue === false) {
    return false;
  }

  if (!isPlainObject(overlayValue)) {
    return cloneValue(overlayValue);
  }

  const baseObject = isPlainObject(baseValue) ? baseValue : {};
  const result = {};
  const keys = new Set([
    ...Object.keys(baseObject),
    ...Object.keys(overlayValue),
  ]);

  for (const key of keys) {
    if (!Object.hasOwn(overlayValue, key)) {
      result[key] = cloneValue(baseObject[key]);
      continue;
    }

    const merged = mergeConfigPatchValue(baseObject[key], overlayValue[key]);
    if (merged !== undefined) {
      result[key] = merged;
    }
  }

  return result;
}

export function pruneConfigPatchContainer(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value).length === 0 ? undefined : value;
}

function mergeRoutePatches(groupChannel, groupItem, routeChannel, routeItem) {
  const merged = {};

  if (groupChannel !== undefined || routeChannel !== undefined) {
    merged.channel = pruneConfigPatchContainer(
      mergeConfigPatchValue(groupChannel, routeChannel)
    );
  }

  if (groupItem !== undefined || routeItem !== undefined) {
    merged.item = pruneConfigPatchContainer(
      mergeConfigPatchValue(groupItem, routeItem)
    );
  }

  return merged;
}

function normalizeBooleanOption(
  rawValue,
  defaultValue,
  pathSegments,
  analysis,
  keyLocations,
  { code, label }
) {
  if (rawValue === undefined) {
    return { value: defaultValue, valid: true };
  }

  if (typeof rawValue !== "boolean") {
    reportError(
      analysis,
      code,
      pathSegments,
      `${formatConfigPath(pathSegments)} must be a boolean ${label}`,
      keyLocations
    );
    return { value: defaultValue, valid: false };
  }

  return { value: rawValue, valid: true };
}

function normalizePositiveInteger(
  rawValue,
  defaultValue,
  pathSegments,
  analysis,
  keyLocations,
  { code, label }
) {
  if (rawValue === undefined) {
    return { value: defaultValue, valid: true };
  }

  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    reportError(
      analysis,
      code,
      pathSegments,
      `${formatConfigPath(pathSegments)} must be a positive integer ${label}`,
      keyLocations
    );
    return { value: defaultValue, valid: false };
  }

  return { value: rawValue, valid: true };
}

function normalizeSource(rawValue, pathSegments, analysis, keyLocations, configPath) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    reportError(
      analysis,
      "invalid-source",
      pathSegments,
      `${formatConfigPath(pathSegments)} must be a non-empty string: ${configPath}`,
      keyLocations
    );
    return { value: "", valid: false };
  }

  return { value: rawValue.trim(), valid: true };
}

function validateFeedObject(value, pathSegments, analysis, keyLocations) {
  if (!isPlainObject(value)) {
    reportError(
      analysis,
      "invalid-feed-object",
      pathSegments,
      `${formatConfigPath(pathSegments)} must be an object`,
      keyLocations
    );
    return false;
  }

  return true;
}

function analyzeGroup(groupName, groupConfig, configPath, analysis, keyLocations, seenRoutes) {
  const groupPath = buildGroupPath(groupName);

  if (!isPlainObject(groupConfig)) {
    reportError(
      analysis,
      "invalid-group",
      groupPath,
      `group "${groupName}" must be an object: ${configPath}`,
      keyLocations
    );
    return;
  }

  let groupFatal = false;

  for (const key of Object.keys(groupConfig)) {
    const keyPath = [...groupPath, key];
    if (key === LEGACY_SCHEMA_KEY) {
      reportError(
        analysis,
        "legacy-schema",
        keyPath,
        `legacy \`schema\` key is not supported at ${formatConfigPath(keyPath)}`,
        keyLocations,
        key
      );
      groupFatal = true;
      continue;
    }

    if (key === "enabled") {
      reportError(
        analysis,
        "legacy-control-location",
        keyPath,
        `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
          ...groupPath,
          "feed",
          "enabled",
        ])}`,
        keyLocations,
        key
      );
      groupFatal = true;
      continue;
    }

    if (key === "maxitems") {
      reportError(
        analysis,
        "legacy-control-location",
        keyPath,
        `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
          ...groupPath,
          "feed",
          "itemlimit",
        ])}`,
        keyLocations,
        key
      );
      groupFatal = true;
      continue;
    }

    if (key === "itemlimit" || key === "statelimit") {
      reportError(
        analysis,
        "invalid-control-location",
        keyPath,
        `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
          ...groupPath,
          "feed",
          key,
        ])}`,
        keyLocations,
        key
      );
      groupFatal = true;
      continue;
    }

    if (!GROUP_RECOGNIZED_KEYS.has(key)) {
      reportWarning(
        analysis,
        "unknown-group-key",
        keyPath,
        `ignored unknown group key "${key}" at ${formatConfigPath(keyPath)}`,
        keyLocations,
        key
      );
    }
  }

  let groupEnabled = true;
  let groupHtmlCleanup = false;
  let groupItemLimit;
  let groupStateLimit;
  if (groupConfig.feed !== undefined) {
    if (validateFeedObject(groupConfig.feed, [...groupPath, "feed"], analysis, keyLocations)) {
      for (const key of Object.keys(groupConfig.feed)) {
        const keyPath = [...groupPath, "feed", key];

        if (key === "source") {
          reportError(
            analysis,
            "invalid-group-feed-key",
            keyPath,
            `${formatConfigPath(keyPath)} is not supported; route-level source must live under route.feed.source`,
            keyLocations,
            key
          );
          groupFatal = true;
          continue;
        }

        if (!GROUP_FEED_RECOGNIZED_KEYS.has(key)) {
          reportWarning(
            analysis,
            "unknown-group-feed-key",
            keyPath,
            `ignored unknown group feed key "${key}" at ${formatConfigPath(keyPath)}`,
            keyLocations,
            key
          );
        }
      }
    } else {
      groupFatal = true;
    }
  }

  const groupEnabledResult = normalizeBooleanOption(
    groupConfig.feed?.enabled,
    true,
    [...groupPath, "feed", "enabled"],
    analysis,
    keyLocations,
    { code: "invalid-enabled", label: "enabled" }
  );
  groupEnabled = groupEnabledResult.value;
  if (!groupEnabledResult.valid) {
    groupFatal = true;
  }

  const groupHtmlCleanupResult = normalizeBooleanOption(
    groupConfig.feed?.htmlcleanup,
    false,
    [...groupPath, "feed", "htmlcleanup"],
    analysis,
    keyLocations,
    { code: "invalid-htmlcleanup", label: "htmlcleanup" }
  );
  groupHtmlCleanup = groupHtmlCleanupResult.value;
  if (!groupHtmlCleanupResult.valid) {
    groupFatal = true;
  }

  const groupItemLimitResult = normalizePositiveInteger(
    groupConfig.feed?.itemlimit,
    undefined,
    [...groupPath, "feed", "itemlimit"],
    analysis,
    keyLocations,
    { code: "invalid-itemlimit", label: "itemlimit" }
  );
  groupItemLimit = groupItemLimitResult.value;
  if (!groupItemLimitResult.valid) {
    groupFatal = true;
  }

  const groupStateLimitResult = normalizePositiveInteger(
    groupConfig.feed?.statelimit,
    undefined,
    [...groupPath, "feed", "statelimit"],
    analysis,
    keyLocations,
    { code: "invalid-statelimit", label: "statelimit" }
  );
  groupStateLimit = groupStateLimitResult.value;
  if (!groupStateLimitResult.valid) {
    groupFatal = true;
  }

  let groupChannel;
  if (groupConfig.channel !== undefined) {
    if (
      validatePatchObject(
        groupConfig.channel,
        [...groupPath, "channel"],
        analysis,
        keyLocations
      )
    ) {
      groupChannel = groupConfig.channel;
    } else {
      groupFatal = true;
    }
  }

  let groupItem;
  if (groupConfig.item !== undefined) {
    if (
      validatePatchObject(
        groupConfig.item,
        [...groupPath, "item"],
        analysis,
        keyLocations
      )
    ) {
      groupItem = groupConfig.item;
    } else {
      groupFatal = true;
    }
  }

  if (!isPlainObject(groupConfig.routes)) {
    reportError(
      analysis,
      "invalid-routes",
      [...groupPath, "routes"],
      `group "${groupName}".routes must be an object: ${configPath}`,
      keyLocations
    );
    return;
  }

  for (const [rawRoute, routeConfig] of Object.entries(groupConfig.routes)) {
    const routePath = buildRoutePath(groupName, rawRoute);
    let routeFatal = groupFatal;
    let routeFeedValid = true;
    let route;

    try {
      route = normalizeRoute(rawRoute);
    } catch (error) {
      reportError(
        analysis,
        "invalid-route",
        routePath,
        error.message,
        keyLocations
      );
      continue;
    }

    if (seenRoutes.has(route)) {
      reportError(
        analysis,
        "duplicate-route",
        routePath,
        `duplicate route detected: ${route}`,
        keyLocations
      );
      continue;
    }
    seenRoutes.add(route);

    if (!isPlainObject(routeConfig)) {
      reportError(
        analysis,
        "invalid-route-config",
        routePath,
        `route "${route}" must be an object in group "${groupName}": ${configPath}`,
        keyLocations
      );
      continue;
    }

    for (const key of Object.keys(routeConfig)) {
      const keyPath = [...routePath, key];
      if (key === LEGACY_SCHEMA_KEY) {
        reportError(
          analysis,
          "legacy-schema",
          keyPath,
          `legacy \`schema\` key is not supported at ${formatConfigPath(keyPath)}`,
          keyLocations,
          key
        );
        routeFatal = true;
        continue;
      }

      if (key === "source") {
        reportError(
          analysis,
          "legacy-control-location",
          keyPath,
          `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
            ...routePath,
            "feed",
            "source",
          ])}`,
          keyLocations,
          key
        );
        routeFatal = true;
        continue;
      }

      if (key === "enabled") {
        reportError(
          analysis,
          "legacy-control-location",
          keyPath,
          `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
            ...routePath,
            "feed",
            "enabled",
          ])}`,
          keyLocations,
          key
        );
        routeFatal = true;
        continue;
      }

      if (key === "maxitems") {
        reportError(
          analysis,
          "legacy-control-location",
          keyPath,
          `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
            ...routePath,
            "feed",
            "itemlimit",
          ])}`,
          keyLocations,
          key
        );
        routeFatal = true;
        continue;
      }

      if (key === "itemlimit" || key === "statelimit") {
        reportError(
          analysis,
          "invalid-control-location",
          keyPath,
          `move ${formatConfigPath(keyPath)} under ${formatConfigPath([
            ...routePath,
            "feed",
            key,
          ])}`,
          keyLocations,
          key
        );
        routeFatal = true;
        continue;
      }

      if (!ROUTE_RECOGNIZED_KEYS.has(key)) {
        reportWarning(
          analysis,
          "unknown-route-key",
          keyPath,
          `ignored unknown route key "${key}" at ${formatConfigPath(keyPath)}`,
          keyLocations,
          key
        );
      }
    }

    if (routeConfig.feed !== undefined) {
      if (validateFeedObject(routeConfig.feed, [...routePath, "feed"], analysis, keyLocations)) {
        for (const key of Object.keys(routeConfig.feed)) {
          const keyPath = [...routePath, "feed", key];
          if (!ROUTE_FEED_RECOGNIZED_KEYS.has(key)) {
            reportWarning(
              analysis,
              "unknown-route-feed-key",
              keyPath,
              `ignored unknown route feed key "${key}" at ${formatConfigPath(keyPath)}`,
              keyLocations,
              key
            );
          }
        }
      } else {
        routeFeedValid = false;
        routeFatal = true;
      }
    }

    let routeSource = "";
    if (routeFeedValid && !Object.hasOwn(routeConfig, "source")) {
      const routeSourceResult = normalizeSource(
        routeConfig.feed?.source,
        [...routePath, "feed", "source"],
        analysis,
        keyLocations,
        configPath
      );
      routeSource = routeSourceResult.value;
      if (!routeSourceResult.valid) {
        routeFatal = true;
      }
    }

    const routeEnabledResult = normalizeBooleanOption(
      routeConfig.feed?.enabled,
      groupEnabled,
      [...routePath, "feed", "enabled"],
      analysis,
      keyLocations,
      { code: "invalid-enabled", label: "enabled" }
    );
    const routeEnabled = routeEnabledResult.value;
    if (!routeEnabledResult.valid) {
      routeFatal = true;
    }

    const routeHtmlCleanupResult = normalizeBooleanOption(
      routeConfig.feed?.htmlcleanup,
      groupHtmlCleanup,
      [...routePath, "feed", "htmlcleanup"],
      analysis,
      keyLocations,
      { code: "invalid-htmlcleanup", label: "htmlcleanup" }
    );
    const routeHtmlCleanup = routeHtmlCleanupResult.value;
    if (!routeHtmlCleanupResult.valid) {
      routeFatal = true;
    }

    const routeItemLimitResult = normalizePositiveInteger(
      routeConfig.feed?.itemlimit,
      groupItemLimit,
      [...routePath, "feed", "itemlimit"],
      analysis,
      keyLocations,
      { code: "invalid-itemlimit", label: "itemlimit" }
    );
    const routeItemLimit = routeItemLimitResult.value;
    if (!routeItemLimitResult.valid) {
      routeFatal = true;
    }

    const routeStateLimitResult = normalizePositiveInteger(
      routeConfig.feed?.statelimit,
      groupStateLimit,
      [...routePath, "feed", "statelimit"],
      analysis,
      keyLocations,
      { code: "invalid-statelimit", label: "statelimit" }
    );
    const routeStateLimit = routeStateLimitResult.value;
    if (!routeStateLimitResult.valid) {
      routeFatal = true;
    }

    let routeChannel;
    if (routeConfig.channel !== undefined) {
      if (
        validatePatchObject(
          routeConfig.channel,
          [...routePath, "channel"],
          analysis,
          keyLocations
        )
      ) {
        routeChannel = routeConfig.channel;
      } else {
        routeFatal = true;
      }
    }

    let routeItem;
    if (routeConfig.item !== undefined) {
      if (
        validatePatchObject(
          routeConfig.item,
          [...routePath, "item"],
          analysis,
          keyLocations
        )
      ) {
        routeItem = routeConfig.item;
      } else {
        routeFatal = true;
      }
    }

    if (routeFatal) {
      continue;
    }

    const merged = mergeRoutePatches(
      groupChannel,
      groupItem,
      routeChannel,
      routeItem
    );

    analysis.rules.push({
      route,
      group: groupName,
      source: routeSource,
      enabled: routeEnabled,
      htmlCleanup: routeHtmlCleanup,
      itemLimit: routeItemLimit,
      stateLimit: routeStateLimit,
      channel: merged.channel,
      item: merged.item,
      configPath,
      filePath: configPath,
    });
  }
}

function flattenConfig(rawConfig, configPath, analysis, keyLocations) {
  if (!isPlainObject(rawConfig)) {
    reportError(
      analysis,
      "invalid-config-root",
      [],
      `config file must contain an object: ${configPath}`,
      keyLocations
    );
    return analysis;
  }

  const seenRoutes = new Set();
  for (const [groupName, groupConfig] of Object.entries(rawConfig)) {
    analyzeGroup(groupName, groupConfig, configPath, analysis, keyLocations, seenRoutes);
  }
  return analysis;
}

function validateLegacyTemplateString(template, fieldPath) {
  let index = 0;

  while (index < template.length) {
    const open = template.indexOf("{{", index);
    const close = template.indexOf("}}", index);
    if (close !== -1 && (open === -1 || close < open)) {
      throw new Error(`unmatched template closing braces at ${fieldPath}`);
    }
    if (open === -1) {
      break;
    }
    const end = template.indexOf("}}", open + 2);
    if (end === -1) {
      throw new Error(`unterminated template expression at ${fieldPath}`);
    }
    const expression = template.slice(open + 2, end).trim();
    try {
      parseTemplatePath(expression);
    } catch (error) {
      throw new Error(`invalid DSL expression at ${fieldPath}: ${error.message}`);
    }
    index = end + 2;
  }
}

function validateLegacyPatchValue(value, fieldPath) {
  if (value === null) {
    throw new Error(`null is not allowed at ${fieldPath}`);
  }

  if (typeof value === "string") {
    validateLegacyTemplateString(value, fieldPath);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateLegacyPatchValue(entry, `${fieldPath}[${index}]`);
    });
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    validateLegacyPatchValue(entry, `${fieldPath}.${key}`);
  }
}

function validateLegacySchema(schema) {
  if (!isPlainObject(schema)) {
    throw new Error("rule schema must be an object");
  }
  if (!schema.channel && !schema.item) {
    throw new Error("rule schema must define channel or item");
  }
  if (schema.channel) {
    if (!isPlainObject(schema.channel)) {
      throw new Error("schema.channel must be an object");
    }
    validateLegacyPatchValue(schema.channel, "schema.channel");
  }
  if (schema.item) {
    if (!isPlainObject(schema.item)) {
      throw new Error("schema.item must be an object");
    }
    validateLegacyPatchValue(schema.item, "schema.item");
  }
}

export function normalizeRoute(route) {
  if (typeof route !== "string") {
    throw new Error("route must be a string");
  }

  const cleaned = route.trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) {
    throw new Error("route must not be empty");
  }

  const segments = cleaned.split("/");
  for (const segment of segments) {
    if (!segment) {
      throw new Error(`route must not contain empty segments: ${route}`);
    }
    if (segment === "." || segment === "..") {
      throw new Error(`route must not contain dot segments: ${route}`);
    }
    if (segment.includes("\\")) {
      throw new Error(`route must not contain backslashes: ${route}`);
    }
  }

  return cleaned;
}

export function routeToRuleFile(route) {
  return `${normalizeRoute(route)}.json`;
}

export function routeToConfigFile() {
  return CONFIG_FILE_NAME;
}

export function routeToOutputFile(route) {
  return `${normalizeRoute(route)}.xml`;
}

async function walkJsonFiles(rootDir, currentDir = rootDir) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT" && currentDir === rootDir) {
      return [];
    }
    throw error;
  }

  const output = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await walkJsonFiles(rootDir, absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      output.push(absolutePath);
    }
  }

  return output.sort();
}

export function validateLegacyRule(rawRule, filePath, rulesDir) {
  if (!isPlainObject(rawRule)) {
    throw new Error(`rule file must contain an object: ${filePath}`);
  }

  const route = normalizeRoute(rawRule.route);
  const expectedRoute = normalizeRoute(
    path
      .relative(rulesDir, filePath)
      .replace(/\.json$/u, "")
      .split(path.sep)
      .join("/")
  );

  if (route !== expectedRoute) {
    throw new Error(
      `rule route must match file path: ${route} !== ${expectedRoute} (${filePath})`
    );
  }

  if (typeof rawRule.source !== "string" || !rawRule.source.trim()) {
    throw new Error(`rule source must be a non-empty string: ${filePath}`);
  }

  try {
    validateLegacySchema(rawRule.schema);
  } catch (error) {
    throw new Error(`${error.message}: ${filePath}`);
  }

  return {
    route,
    source: rawRule.source.trim(),
    enabled: rawRule.enabled !== false,
    schema: rawRule.schema,
    filePath,
  };
}

export async function loadLegacyRules(rulesDir) {
  const files = await walkJsonFiles(rulesDir);
  const seenRoutes = new Set();
  const rules = [];

  for (const filePath of files) {
    const rawText = await readFile(filePath, "utf8");
    const rawRule = JSON.parse(rawText);
    const rule = validateLegacyRule(rawRule, filePath, rulesDir);
    if (seenRoutes.has(rule.route)) {
      throw new Error(`duplicate route detected: ${rule.route}`);
    }
    seenRoutes.add(rule.route);
    rules.push(rule);
  }

  return rules.sort((left, right) => left.route.localeCompare(right.route));
}

export async function analyzeConfig(configPath = CONFIG_FILE_NAME) {
  let rawText;
  try {
    rawText = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return finalizeAnalysis(createAnalysis(configPath));
    }
    throw error;
  }

  const analysis = createAnalysis(configPath, rawText);
  const parsed = parseJsonDocument(rawText);
  if (parsed.parseError) {
    pushDiagnostic(analysis, {
      severity: "error",
      code: "invalid-json",
      pathSegments: [],
      line: parsed.parseError.line,
      message: `config JSON parse error: ${parsed.parseError.message}`,
    });
    return finalizeAnalysis(analysis);
  }

  flattenConfig(parsed.value, configPath, analysis, parsed.keyLocations);
  return finalizeAnalysis(analysis);
}

export function analyzeConfigText(rawText, configPath = CONFIG_FILE_NAME) {
  const analysis = createAnalysis(configPath, rawText);
  const parsed = parseJsonDocument(rawText);
  if (parsed.parseError) {
    pushDiagnostic(analysis, {
      severity: "error",
      code: "invalid-json",
      pathSegments: [],
      line: parsed.parseError.line,
      message: `config JSON parse error: ${parsed.parseError.message}`,
    });
    return finalizeAnalysis(analysis);
  }

  flattenConfig(parsed.value, configPath, analysis, parsed.keyLocations);
  return finalizeAnalysis(analysis);
}

export async function loadRules(configPath = CONFIG_FILE_NAME) {
  const analysis = await analyzeConfig(configPath);
  if (!analysis.hasFatalErrors) {
    return analysis.rules;
  }

  throw new ConfigValidationError(
    analysis.fatalErrors[0]?.message ?? `invalid config: ${configPath}`,
    analysis
  );
}
