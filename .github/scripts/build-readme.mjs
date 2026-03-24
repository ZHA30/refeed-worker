import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  analyzeConfig,
  loadRules,
  normalizeRoute,
  routeToOutputFile,
  routeToConfigFile,
} from "./lib/rules.mjs";
import { loadStatesForRules } from "./lib/state.mjs";

export { loadRules, normalizeRoute };

const DASHBOARD_TIME_ZONE = "Asia/Shanghai";
const PUBLISH_WORKFLOW_FILE = "publish-feed.yml";
const FAILURE_TITLE_PREFIX = "[refeed] feed failure: ";
const FAILURE_ROUTE_MARKER = "refeed-route";

export function routeToFeedPath(route) {
  return routeToOutputFile(route);
}

export function routeToRulePath(route) {
  return routeToConfigPath(route);
}

export function routeToConfigPath() {
  return "config";
}

export function buildFeedUrl(route, baseUrl) {
  if (!baseUrl) {
    return "";
  }
  return `${baseUrl.replace(/\/+$/u, "")}/${routeToOutputFile(route)}`;
}

function slugifyGroupName(value) {
  return encodeURIComponent(value.trim());
}

function buildGroupCatalogUrl(groupName, baseUrl) {
  if (!baseUrl || !groupName) {
    return "";
  }
  return `${baseUrl.replace(/\/+$/u, "")}/feeds/groups/${slugifyGroupName(groupName)}.html`;
}

function buildGroupConfigReadmePath(groupName) {
  return path.join(routeToConfigPath(), groupName, 'README.md');
}

function escapeTableCell(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function formatDate(value) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: DASHBOARD_TIME_ZONE,
  }).format(date);
}

function formatDateTime(value) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: DASHBOARD_TIME_ZONE,
  }).format(date);
}

function formatCount(value) {
  return Number.isInteger(value) ? String(value) : "未知";
}

function buildFeedTarget(route, baseUrl, repoSlug) {
  const feedUrl = buildFeedUrl(route, baseUrl);
  if (feedUrl) {
    return feedUrl;
  }
  return "";
}

function buildRuleTarget(repoSlug) {
  if (!repoSlug) {
    return "";
  }
  const rulePath = routeToConfigPath().split(path.sep).join("/");
  return buildRepoUrl(repoSlug, `/tree/main/${rulePath}`);
}

function buildRepoUrl(repoSlug, suffix) {
  if (!repoSlug) {
    return "";
  }
  return `https://github.com/${repoSlug}${suffix}`;
}

function buildWorkflowTarget(repoSlug) {
  return buildRepoUrl(repoSlug, "/actions/workflows/publish-feed.yml");
}

function buildFailureIssueTarget(repoSlug) {
  return buildRepoUrl(
    repoSlug,
    '/issues?q=is%3Aissue+is%3Aopen+%22%5Brefeed%5D+feed+failure%3A%22'
  );
}

async function githubRequest(fetchImpl, repository, token, resource) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}${resource}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${resource} failed: ${response.status} ${body}`);
  }

  return response.json();
}

function parseFailureRoute(issue) {
  const title = issue.title ?? "";
  if (title.startsWith(FAILURE_TITLE_PREFIX)) {
    return title.slice(FAILURE_TITLE_PREFIX.length).trim();
  }

  const body = issue.body ?? "";
  const match = body.match(
    new RegExp(`<!--\\s*${FAILURE_ROUTE_MARKER}:\\s*(.+?)\\s*-->`, "u")
  );
  return match ? match[1].trim() : "";
}

function formatWorkflowRunStatus(run) {
  if (run.status && run.status !== "completed") {
    return `🟡 ${run.status}`;
  }

  switch (run.conclusion) {
    case "success":
      return "✅ success";
    case "failure":
      return "❌ failure";
    case "cancelled":
      return "⏹️ cancelled";
    case "skipped":
      return "⏭️ skipped";
    case "timed_out":
      return "⏱️ timed_out";
    case "action_required":
      return "⚠️ action_required";
    case "neutral":
      return "⚪ neutral";
    case "stale":
      return "🧊 stale";
    default:
      return run.conclusion ?? run.status ?? "unknown";
  }
}

function renderMarkdownLink(label, url) {
  if (!url) {
    return escapeTableCell(label);
  }
  return `[${escapeTableCell(label)}](${url})`;
}

function renderCodeLink(label, url) {
  const safeLabel = escapeHtml(label);
  if (!url) {
    return `<code>${safeLabel}</code>`;
  }
  return `<a href="${escapeHtml(url)}"><code>${safeLabel}</code></a>`;
}

function renderHtmlLink(label, url) {
  const safeLabel = escapeHtml(label);
  if (!url) {
    return safeLabel;
  }
  return `<a href="${escapeHtml(url)}">${safeLabel}</a>`;
}

async function listRecentWorkflowRuns({
  repository,
  token,
  fetchImpl = fetch,
  limit = 5,
  excludeRunId = "",
}) {
  if (!repository) {
    return [];
  }

  try {
    const payload = await githubRequest(
      fetchImpl,
      repository,
      token,
      `/actions/workflows/${PUBLISH_WORKFLOW_FILE}/runs?per_page=${Math.max(limit + 3, 10)}`
    );

    return (payload.workflow_runs ?? [])
      .filter((run) => {
        const runId = run?.id ? String(run.id) : "";
        if (excludeRunId && runId === excludeRunId) {
          return false;
        }
        return run?.status === "completed";
      })
      .slice(0, limit)
      .map((run) => ({
        label: `#${run.run_number ?? "?"}`,
        url: run.html_url ?? "",
        event: run.event ?? "unknown",
        status: formatWorkflowRunStatus(run),
        updatedAt: run.updated_at ?? run.run_started_at ?? run.created_at ?? "",
      }));
  } catch {
    return [];
  }
}

async function listOpenFailureIssues({
  repository,
  token,
  fetchImpl = fetch,
  limit = 5,
}) {
  if (!repository) {
    return [];
  }

  try {
    const payload = await githubRequest(
      fetchImpl,
      repository,
      token,
      "/issues?state=open&per_page=100&sort=updated&direction=desc"
    );

    return (payload ?? [])
      .map((issue) => ({
        route: parseFailureRoute(issue),
        url: issue.html_url ?? "",
        updatedAt: issue.updated_at ?? "",
      }))
      .filter((entry) => entry.route)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function extractFeedChannelTitle(xmlText) {
  const channelMatch = xmlText.match(/<channel\b[\s\S]*?<\/channel>/u);
  if (!channelMatch) {
    return "";
  }
  const titleMatch = channelMatch[0].match(/<title>([\s\S]*?)<\/title>/u);
  if (!titleMatch) {
    return "";
  }
  return decodeXmlEntities(titleMatch[1]).trim();
}

function decodeXmlEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/gu, (entity, code) => {
    switch (code) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (code.startsWith("#x")) {
          return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
        }
        if (code.startsWith("#")) {
          return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
        }
        return entity;
    }
  });
}

async function collectFeedTitles(rules, feedDir, statesByRoute = {}) {
  const entries = await Promise.all(
    rules.map(async (rule) => {
      if (!feedDir) {
        return [rule.route, statesByRoute[rule.route]?.lastSuccessfulTitle ?? ""];
      }

      const feedPath = path.join(feedDir, routeToOutputFile(rule.route));
      try {
        const xmlText = await readFile(feedPath, "utf8");
        const extractedTitle = extractFeedChannelTitle(xmlText);
        return [
          rule.route,
          extractedTitle || (statesByRoute[rule.route]?.lastSuccessfulTitle ?? ""),
        ];
      } catch {
        return [rule.route, statesByRoute[rule.route]?.lastSuccessfulTitle ?? ""];
      }
    })
  );

  return Object.fromEntries(entries);
}

function collectRecentAdded(rules, statesByRoute, limit) {
  const entries = rules.map((rule) => ({
    route: rule.route,
    enabled: rule.enabled,
    addedAt: statesByRoute[rule.route]?.addedAt ?? "",
  }));
  return entries
    .filter((entry) => entry.addedAt)
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))
    .slice(0, limit);
}

function collectRecentClosed(rules, statesByRoute, limit) {
  const entries = rules
    .filter((rule) => !rule.enabled)
    .map((rule) => ({
      route: rule.route,
      closedAt: statesByRoute[rule.route]?.disabledAt ?? "",
    }));
  return entries
    .filter((entry) => entry.closedAt)
    .sort((left, right) => right.closedAt.localeCompare(left.closedAt))
    .slice(0, limit);
}

function renderActionLinks(repoSlug, workflowRepoSlug = repoSlug) {
  const actions = [
    ["📝 配置目录", buildRepoUrl(repoSlug, `/tree/main/${routeToConfigPath()}`)],
    ["📘 配置说明", buildRepoUrl(repoSlug, "/blob/main/config/README.md")],
    ["🗂️ 储存目录", buildRepoUrl(repoSlug, "/tree/main/state")],
    ["📰 Feed 目录", buildRepoUrl(repoSlug, "/tree/main/feeds")],
    ["🚀 发布记录", buildWorkflowTarget(workflowRepoSlug)],
    ["🔄 全量刷新", buildWorkflowTarget(workflowRepoSlug)],
  ].filter(([, url]) => url);

  if (actions.length === 0) {
    return ["- 暂未配置仓库快捷入口"];
  }

  return actions.map(([label, url]) => `[${label}](${url})`);
}

function renderHeading(title, url = "") {
  if (!url) {
    return `## ${title}`;
  }
  return `## [${title}](${url})`;
}

function renderSimpleTable(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];

  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }

  return lines;
}

function groupRulesByGroup(rules) {
  const buckets = new Map();

  for (const rule of rules) {
    const groupName = rule.group || "Ungrouped";
    const bucket = buckets.get(groupName) ?? [];
    bucket.push(rule);
    buckets.set(groupName, bucket);
  }

  return [...buckets.entries()];
}

function renderRecentSection(title, headers, rows, emptyText) {
  const lines = [title, ""];
  if (rows.length === 0) {
    lines.push(emptyText, "");
    return lines;
  }
  lines.push(...renderSimpleTable(headers, rows), "");
  return lines;
}

function collectGenerationTimes(statesByRoute) {
  return [...new Set(
    Object.values(statesByRoute)
      .map((entry) => entry?.lastSuccessAt ?? "")
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left))
  )];
}

function renderDiagnosticsSection(diagnostics) {
  const lines = ["## ⚠️ 配置诊断", ""];
  if (!diagnostics || diagnostics.length === 0) {
    lines.push("当前没有配置诊断。", "");
    return lines;
  }

  for (const entry of diagnostics) {
    const lineText = entry.line ? `L${entry.line}` : "L?";
    lines.push(
      `- <code>${escapeHtml(`${lineText} ${entry.path}`)}</code>: ${escapeHtml(entry.message)}`
    );
  }
  lines.push("");
  return lines;
}

function renderExternalFeedLink(url) {
  if (!url) {
    return "待配置";
  }
  const safeUrl = escapeHtml(url);
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
}

function renderRouteLink(route, target) {
  const label = `<code>${escapeHtml(route)}</code>`;
  if (!target) {
    return label;
  }
  return `<a href="${escapeHtml(target)}">${label}</a>`;
}

function renderSourceLink(url) {
  const safeUrl = escapeHtml(url);
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
}

function renderLinksCell({ route, ruleTarget, sourceUrl, feedTarget }) {
  return [
    "<ul>",
    `<li>路由：${renderRouteLink(route, ruleTarget)}</li>`,
    `<li>来源：${renderSourceLink(sourceUrl)}</li>`,
    `<li>订阅链接：${renderExternalFeedLink(feedTarget)}</li>`,
    "</ul>",
  ].join("");
}

function renderPublicFeedCell(feedTarget) {
  return renderExternalFeedLink(feedTarget);
}

function countRouteStateItems(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return 0;
  }

  if (!state.items || typeof state.items !== "object" || Array.isArray(state.items)) {
    return 0;
  }

  return Object.keys(state.items).length;
}

function buildRouteStatusByRoute(rules, statesByRoute) {
  return Object.fromEntries(
    rules.map((rule) => {
      const stateItems = countRouteStateItems(statesByRoute[rule.route]);
      const outputItems = rule.enabled
        ? Number.isInteger(rule.itemLimit) && rule.itemLimit > 0
          ? Math.min(stateItems, rule.itemLimit)
          : stateItems
        : 0;

      return [
        rule.route,
        {
          enabled: rule.enabled,
          stateItems,
          outputItems,
        },
      ];
    })
  );
}

function renderStatusCell(status) {
  const enabledLabel = status?.enabled ? "✅ 已启用" : "⏸️ 已关闭";
  const stateItems = Number.isInteger(status?.stateItems) ? status.stateItems : 0;
  const outputItems = Number.isInteger(status?.outputItems) ? status.outputItems : 0;

  return [
    "<ul>",
    `<li>状态：${enabledLabel}</li>`,
    `<li>储存：${stateItems} 条</li>`,
    `<li>输出：${outputItems} 条</li>`,
    "</ul>",
  ].join("");
}

function renderCardTitle(title, url = "") {
  const safeTitle = escapeHtml(title);
  if (!url) {
    return `<p><strong>${safeTitle}</strong></p>`;
  }
  return `<p><a href="${escapeHtml(url)}"><strong>${safeTitle}</strong></a></p>`;
}

function renderCardMetricList(rows) {
  return [
    "<ul>",
    ...rows.map(
      ([label, value]) => `<li>${escapeHtml(label)}：<code>${escapeHtml(value)}</code></li>`
    ),
    "</ul>",
  ].join("");
}

function renderCardList(items, emptyText) {
  if (items.length === 0) {
    return `<p>${escapeHtml(emptyText)}</p>`;
  }

  return [
    "<ul>",
    ...items.map((item) => `<li>${item}</li>`),
    "</ul>",
  ].join("");
}

function renderDashboardCard({ title, url = "", body }) {
  return [
    renderCardTitle(title, url),
    body,
  ].join("");
}

function renderDashboardGrid(rows) {
  const lines = [
    '<table>',
  ];

  for (const row of rows) {
    lines.push('<tr>');
    for (const card of row) {
      lines.push('<td valign="top" width="50%">');
      lines.push(card);
      lines.push('</td>');
    }
    lines.push('</tr>');
  }

  lines.push('</table>');
  return lines;
}

export function renderReadme({
  rules,
  baseUrl,
  repoSlug = "",
  workflowRepoSlug = repoSlug,
  recentRuns = [],
  feedTitles = {},
  routeStatusByRoute = {},
  stateCount = 0,
  totalStateItems = 0,
  latestGeneratedAt = "",
  previousGeneratedAt = "",
  itemStats = null,
}) {
  const enabledCount = rules.filter((rule) => rule.enabled).length;
  const actionLinks = renderActionLinks(repoSlug, workflowRepoSlug);
  const workflowTarget = buildWorkflowTarget(workflowRepoSlug);
  const overviewCard = renderDashboardCard({
    title: "📊 运行概览",
    body: renderCardMetricList([
      ["📦 订阅总数", String(rules.length)],
      ["✅ 已启用", String(enabledCount)],
      ["🗂️ 储存文件", String(stateCount)],
      ["📚 全部数量", String(totalStateItems)],
      ["🆕 新增数量", formatCount(itemStats?.newItems)],
      ["🗑️ 删除数量", formatCount(itemStats?.deletedItems)],
      ["📤 输出数量", formatCount(itemStats?.outputItems)],
      ["🕒 最新生成", formatDateTime(latestGeneratedAt)],
      ["🕰️ 上次生成", formatDateTime(previousGeneratedAt)],
    ]),
  });
  const publishCard = renderDashboardCard({
    title: "🚀 发布记录",
    url: workflowTarget,
    body: renderCardList(
      recentRuns.map((entry) =>
        `${renderHtmlLink(entry.label, entry.url)} · <code>${escapeHtml(entry.event)}</code> · ${escapeHtml(entry.status)} · ${escapeHtml(formatDateTime(entry.updatedAt))}`
      ),
      "当前没有最近的发布记录"
    ),
  });
  const lines = [
    "<!-- AUTO-GENERATED: DO NOT EDIT -->",
    "",
    "## 🧭 固定入口",
    "",
    actionLinks.join(" · "),
    "",
    "## 📊 总览看板",
    "",
    ...renderDashboardGrid([
      [overviewCard, publishCard],
    ]),
    "",
    "## 🗂️ 分组总览",
    "",
  ];

  if (rules.length === 0) {
    lines.push("当前还没有可展示的订阅。");
    return `${lines.join("\n")}\n`;
  }

  for (const [groupName, groupRules] of groupRulesByGroup(rules)) {
    const enabledRules = groupRules.filter((rule) => rule.enabled).length;
    const totalStateItemsForGroup = groupRules.reduce(
      (sum, rule) => sum + (routeStatusByRoute[rule.route]?.stateItems ?? 0),
      0
    );
    const totalOutputItemsForGroup = groupRules.reduce(
      (sum, rule) => sum + (routeStatusByRoute[rule.route]?.outputItems ?? 0),
      0
    );
    const groupConfigTarget = buildRepoUrl(repoSlug, `/blob/main/${buildGroupConfigReadmePath(groupName).split(path.sep).join('/')}`);
    const groupPublicTarget = buildGroupCatalogUrl(groupName, baseUrl);

    lines.push(`### ${escapeHtml(groupName)}`);
    lines.push("");
    lines.push("| 订阅数 | 已启用 | 储存总数 | 输出总数 | 入口 |");
    lines.push("| --- | --- | --- | --- | --- |");
    lines.push(
      `| ${groupRules.length} | ${enabledRules} | ${totalStateItemsForGroup} | ${totalOutputItemsForGroup} | ${[
        renderMarkdownLink('内部清单', groupConfigTarget),
        renderMarkdownLink('公开清单', groupPublicTarget),
      ].join(' · ')} |`
    );

    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return `${lines.join("\n")}\n`;
}

function renderGroupReadme({ groupName, groupRules, baseUrl, repoSlug, feedTitles, routeStatusByRoute }) {
  const lines = [
    '<!-- AUTO-GENERATED: DO NOT EDIT -->',
    '',
    `## ${escapeHtml(groupName)}`,
    '',
    '| 标题 | 状态 | 链接 |',
    '| --- | --- | --- |',
  ];

  for (const rule of groupRules) {
    const feedTarget = buildFeedTarget(rule.route, baseUrl, repoSlug);
    const ruleTarget = buildRuleTarget(repoSlug);
    const sourceUrl = rule.source.trim();
    const titleCell = escapeTableCell(feedTitles[rule.route] || '待获取');
    const statusCell = renderStatusCell(routeStatusByRoute[rule.route]);
    const linksCell = renderLinksCell({ route: rule.route, ruleTarget, sourceUrl, feedTarget });
    lines.push(`| ${titleCell} | ${statusCell} | ${linksCell} |`);
  }

  return `${lines.join('\n')}\n`;
}

function renderPublicGroupCatalog({ groupName, groupRules, baseUrl, feedTitles, routeStatusByRoute }) {
  const lines = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(groupName)} · Refeed</title>`,
    '  <style>',
    '    body{font-family:Georgia,"Noto Serif SC",serif;margin:0;background:#f6f0e7;color:#1f1a14;padding:24px;}',
    '    main{max-width:980px;margin:0 auto;background:#fffdf9;border:1px solid #d8c8ad;padding:24px;}',
    '    h1{margin-top:0;font-size:34px;}',
    '    p{color:#5e564b;line-height:1.7;}',
    '    table{width:100%;border-collapse:collapse;margin-top:20px;}',
    '    th,td{border:1px solid #d8c8ad;padding:12px;vertical-align:top;text-align:left;}',
    '    th{background:#f2eadf;}',
    '    a{color:#0f766e;}',
    '    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
    '    ul{margin:0;padding-left:18px;}',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    `    <h1>${escapeHtml(groupName)}</h1>`,
    '    <p>公开订阅清单，仅保留标题、状态和订阅链接。</p>',
    '    <table>',
    '      <thead><tr><th>标题</th><th>状态</th><th>订阅</th></tr></thead>',
    '      <tbody>',
  ];

  for (const rule of groupRules) {
    const feedTarget = buildFeedTarget(rule.route, baseUrl, '');
    const titleCell = escapeHtml(feedTitles[rule.route] || '待获取');
    const enabled = Boolean(routeStatusByRoute[rule.route]?.enabled);
    const statusClass = enabled ? 'status' : 'status off';
    const statusLabel = enabled ? '✅ 已启用' : '⏸️ 已关闭';
    const feedCell = renderPublicFeedCell(feedTarget);
    lines.push(`          <tr><td>${titleCell}</td><td><span class="${statusClass}">${statusLabel}</span></td><td class="feed-link">${feedCell}</td></tr>`);
  }

  lines.push('      </tbody>');
  lines.push('    </table>');
  lines.push('  </main>');
  lines.push('</body>');
  lines.push('</html>');
  return `${lines.join('\n')}\n`;
}

async function loadPublishReport(reportPath) {
  if (!reportPath) {
    return null;
  }

  try {
    const rawText = await readFile(reportPath, "utf8");
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function buildReadme({
  configPath,
  rulesDir,
  stateDir,
  outputFile,
  baseUrl,
  repoSlug,
  workflowRepoSlug = repoSlug,
  feedDir,
  configRoot = process.env.REFEED_CONFIG_ROOT ?? "",
  reportPath = "",
  githubToken = process.env.GITHUB_TOKEN ?? "",
  currentRunId = process.env.GITHUB_RUN_ID ?? "",
  fetchImpl = fetch,
}) {
  const resolvedConfigPath = path.resolve(configPath ?? rulesDir ?? routeToConfigPath());
  const resolvedStateDir = stateDir ?? "state";
  const analysis = await analyzeConfig(resolvedConfigPath);
  const rules = analysis.rules;
  const statesByRoute = await loadStatesForRules(resolvedStateDir, rules);
  const [feedTitles, publishReport, recentRuns, githubFailureIssues] = await Promise.all([
    collectFeedTitles(rules, feedDir, statesByRoute),
    loadPublishReport(reportPath),
    listRecentWorkflowRuns({
      repository: workflowRepoSlug,
      token: githubToken,
      fetchImpl,
      excludeRunId: currentRunId,
    }),
    listOpenFailureIssues({
      repository: workflowRepoSlug,
      token: githubToken,
      fetchImpl,
    }),
  ]);
  const successfulRoutesInCurrentRun = new Set(
    (publishReport?.successfulRoutes ?? []).map((entry) => normalizeRoute(entry.route))
  );
  const recentFailureIssues = githubFailureIssues.filter(
    (entry) => !successfulRoutesInCurrentRun.has(normalizeRoute(entry.route))
  );
  const stateEntries = Object.values(statesByRoute).filter(Boolean);
  const generationTimes = collectGenerationTimes(statesByRoute);
  const latestGeneratedAt = generationTimes[0] ?? "";
  const previousGeneratedAt = generationTimes[1] ?? "";
  const routeStatusByRoute = buildRouteStatusByRoute(rules, statesByRoute);
  const totalStateItems = Object.values(routeStatusByRoute).reduce(
    (sum, entry) => sum + (entry.stateItems ?? 0),
    0
  );
  const content = renderReadme({
    rules,
    diagnostics: analysis.diagnostics,
    baseUrl,
    repoSlug,
    workflowRepoSlug,
    recentRuns,
    recentFailureIssues,
    feedTitles,
    routeStatusByRoute,
    stateCount: stateEntries.length,
    totalStateItems,
    latestGeneratedAt,
    previousGeneratedAt,
    itemStats: publishReport?.totals
      ? {
          newItems: publishReport.totals.newItems,
          deletedItems: publishReport.totals.deletedItems,
          outputItems: publishReport.totals.outputItems,
        }
      : null,
  });

  const configRootDir = configRoot
    ? path.resolve(configRoot)
    : analysis.configRoot
      ? path.resolve(analysis.configRoot)
      : resolvedConfigPath.endsWith(".json")
        ? path.join(path.dirname(resolvedConfigPath), routeToConfigPath())
        : resolvedConfigPath;
  const groupArtifacts = [];

  for (const [groupName, groupRules] of groupRulesByGroup(rules)) {
    const groupReadmePath = path.join(configRootDir, groupName, "README.md");
    const groupCatalogPath = feedDir
      ? path.join(path.resolve(feedDir), "groups", `${groupName}.html`)
      : "";
    const groupReadme = renderGroupReadme({
      groupName,
      groupRules,
      baseUrl,
      repoSlug,
      feedTitles,
      routeStatusByRoute,
    });

    await mkdir(path.dirname(groupReadmePath), { recursive: true });
    await writeFile(groupReadmePath, groupReadme, "utf8");

    if (groupCatalogPath) {
      const groupCatalog = renderPublicGroupCatalog({
        groupName,
        groupRules,
        baseUrl,
        feedTitles,
        routeStatusByRoute,
      });
      await mkdir(path.dirname(groupCatalogPath), { recursive: true });
      await writeFile(groupCatalogPath, groupCatalog, "utf8");
    }

    groupArtifacts.push({ groupName, groupReadmePath, groupCatalogPath });
  }

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, content, "utf8");
  return {
    groupArtifacts,
    rules,
    diagnostics: analysis.diagnostics,
    hasFatalErrors: analysis.hasFatalErrors,
    statesByRoute,
    content,
    recentRuns,
    recentFailureIssues,
    publishReport,
  };
}
export function readArgs(argv) {
  const options = {
    configPath: process.env.REFEED_CONFIG_PATH ?? routeToConfigPath(),
    stateDir: process.env.REFEED_STATE_DIR ?? "state",
    outputFile: "README.md",
    baseUrl:
      process.env.REFEED_PUBLIC_BASE_URL ??
      process.env.PUBLIC_FEED_BASE_URL ??
      "",
    repoSlug:
      process.env.REFEED_REPOSITORY ??
      process.env.GITHUB_REPOSITORY ??
      "",
    workflowRepoSlug:
      process.env.REFEED_WORKFLOW_REPOSITORY ??
      process.env.GITHUB_REPOSITORY ??
      "",
    feedDir: process.env.REFEED_FEED_DIR ?? "dist-feed",
    configRoot: process.env.REFEED_CONFIG_ROOT ?? "",
    reportPath: process.env.REFEED_REPORT_PATH ?? "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--config" && next) {
      options.configPath = next;
      index += 1;
      continue;
    }
    if (current === "--rules-dir" && next) {
      options.configPath = next;
      index += 1;
      continue;
    }
    if (current === "--state-dir" && next) {
      options.stateDir = next;
      index += 1;
      continue;
    }
    if (current === "--output" && next) {
      options.outputFile = next;
      index += 1;
      continue;
    }
    if (current === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
      continue;
    }
    if (current === "--repo" && next) {
      options.repoSlug = next;
      index += 1;
      continue;
    }
    if (current === "--workflow-repo" && next) {
      options.workflowRepoSlug = next;
      index += 1;
      continue;
    }
    if (current === "--feed-dir" && next) {
      options.feedDir = next;
      index += 1;
      continue;
    }
    if (current === "--config-root" && next) {
      options.configRoot = next;
      index += 1;
      continue;
    }
    if (current === "--report-path" && next) {
      options.reportPath = next;
      index += 1;
    }
  }

  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = readArgs(process.argv.slice(2));
  const result = await buildReadme({
    ...options,
    repoSlug: options.repoSlug,
    workflowRepoSlug: options.workflowRepoSlug,
  });
  process.stdout.write(`README updated for ${result.rules.length} rule(s)\n`);
}
