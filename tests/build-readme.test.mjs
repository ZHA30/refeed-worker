import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildFeedUrl,
  buildReadme,
  loadRules,
  readArgs,
  renderReadme,
  routeToConfigPath,
  routeToFeedPath,
  routeToRulePath,
} from "../.github/scripts/build-readme.mjs";

async function writeConfig(rootDir, payload) {
  const filePath = path.join(rootDir, "config.json");
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

async function writeState(rootDir, route, payload) {
  const filePath = path.join(rootDir, "state", `${route}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function writeFeedXml(rootDir, route, title) {
  const filePath = path.join(rootDir, routeToFeedPath(route));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${title}</title><link>https://feeds.example.com/${routeToFeedPath(route)}</link></channel></rss>\n`,
    "utf8"
  );
}

async function writeReport(rootDir, payload) {
  const filePath = path.join(rootDir, "build", "feed-report.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyGithubFetch(url) {
  if (url.includes("/actions/workflows/")) {
    return jsonResponse({ workflow_runs: [] });
  }
  if (url.includes("/issues?state=open")) {
    return jsonResponse([]);
  }
  throw new Error(`unexpected url: ${url}`);
}

test("route helpers map routes to config and feed paths", () => {
  assert.equal(routeToConfigPath("hackernews/main"), "config");
  assert.equal(routeToRulePath("nga"), "config");
  assert.equal(routeToFeedPath("hackernews/main"), "hackernews/main.xml");
  assert.equal(
    buildFeedUrl("hackernews/main", "https://feeds.example.com/"),
    "https://feeds.example.com/hackernews/main.xml"
  );
});

test("readArgs keeps base-url, repo, and workflow-repo values isolated", () => {
  const options = readArgs([
    "--config",
    "build/config.runtime.json",
    "--state-dir",
    "data-repo/state",
    "--feed-dir",
    "dist-feed",
    "--config-root",
    "data-repo/config",
    "--report-path",
    "build/feed-report.json",
    "--base-url",
    "https://refeed.pages.dev",
    "--repo",
    "ZHA30/refeed",
    "--workflow-repo",
    "ZHA30/refeed-worker",
    "--output",
    "data-repo/README.md",
  ]);

  assert.equal(options.baseUrl, "https://refeed.pages.dev");
  assert.equal(options.repoSlug, "ZHA30/refeed");
  assert.equal(options.workflowRepoSlug, "ZHA30/refeed-worker");
  assert.equal(options.outputFile, "data-repo/README.md");
  assert.equal(options.configRoot, "data-repo/config");
});

test("loadRules preserves config insertion order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-readme-order-"));
  const configPath = await writeConfig(tempDir, {
    demo: {
      routes: {
        "b/main": {
          feed: {
            source: "https://example.com/b.xml",
          },
        },
        "a/main": {
          feed: {
            source: "https://example.com/a.xml",
            enabled: false,
          },
        },
      },
    },
  });

  const rules = await loadRules(configPath);
  assert.deepEqual(
    rules.map((rule) => rule.route),
    ["b/main", "a/main"]
  );
});

test("renderReadme preserves provided rule order and keeps issue details out of the dashboard", () => {
  const content = renderReadme({
    rules: [
      {
        group: "alpha",
        route: "b/main",
        source: "https://example.com/b.xml",
        enabled: true,
      },
      {
        group: "beta",
        route: "a/main",
        source: "https://example.com/a.xml",
        enabled: false,
      },
    ],
    diagnostics: [
      {
        line: 12,
        path: 'feeds.routes["b/main"].debug',
        message: 'ignored unknown route field "debug"',
      },
    ],
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    recentRuns: [
      {
        label: "#42",
        url: "https://github.com/owner/repo/actions/runs/42",
        event: "workflow_dispatch",
        status: "✅ success",
        updatedAt: "2026-03-20T08:40:00Z",
      },
    ],
    recentFailureIssues: [
      {
        route: "b/main",
        url: "https://github.com/owner/repo/issues/7",
        updatedAt: "2026-03-20T08:35:00Z",
      },
    ],
    feedTitles: {
      "b/main": "B Feed",
      "a/main": "A Feed",
    },
    routeStatusByRoute: {
      "b/main": { enabled: true, stateItems: 8, outputItems: 5 },
      "a/main": { enabled: false, stateItems: 3, outputItems: 0 },
    },
    stateCount: 0,
    totalStateItems: 11,
    latestGeneratedAt: "2026-03-20T08:30:00Z",
    previousGeneratedAt: "2026-03-20T07:00:00Z",
    itemStats: { newItems: 3, deletedItems: 1, outputItems: 9 },
  });

  assert.match(content, /## 📊 总览看板/u);
  assert.match(content, /<strong>📊 运行概览<\/strong>/u);
  assert.doesNotMatch(content, /ignored unknown route field/u);
  assert.doesNotMatch(content, /## 📈 数据图表/u);
  assert.match(content, /### alpha/u);
  assert.match(content, /### beta/u);
  assert.match(content, /\| 1 \| 1 \| 8 \| 5 \|/u);
  assert.match(content, /\| 1 \| 0 \| 3 \| 0 \|/u);
  assert.match(content, /\[内部清单\]\(https:\/\/github\.com\/owner\/repo\/blob\/main\/config\/alpha\/README\.md\)/u);
  assert.match(content, /\[公开清单\]\(https:\/\/feeds\.example\.com\/feeds\/groups\/be76331b95df\.html\)/u);
});

test("buildReadme prefers feed xml titles and surfaces fatal config diagnostics", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-"));
  await writeConfig(tempDir, {
    demo: {
      routes: {
        "demo/main": {
          feed: { source: "https://example.com/demo.xml" },
          schema: { item: { title: "{{ $item.title }}" } },
        },
      },
    },
  });
  await writeFeedXml(path.join(tempDir, "dist-feed"), "demo/main", "Demo Feed");
  await writeState(tempDir, "demo/main", {
    route: "demo/main",
    addedAt: "2026-03-19T16:30:00Z",
    lastSuccessAt: "2026-03-20T08:30:00Z",
    lastSuccessfulTitle: "Demo Feed",
  });

  const result = await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    fetchImpl: emptyGithubFetch,
  });

  const readme = await readFile(path.join(tempDir, "README.md"), "utf8");
  assert.equal(result.hasFatalErrors, true);
  assert.match(readme, /当前还没有可展示的订阅/u);
});

test("buildReadme shows latest and previous generation times for valid configs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-times-"));
  await writeConfig(tempDir, {
    demo: { routes: { "demo/main": { feed: { source: "https://example.com/demo.xml" } } } },
    alpha: { routes: { "demo/older": { feed: { source: "https://example.com/older.xml" } } } },
  });
  await writeFeedXml(path.join(tempDir, "dist-feed"), "demo/main", "Demo Feed");
  await writeFeedXml(path.join(tempDir, "dist-feed"), "demo/older", "Older Feed");
  await writeState(tempDir, "demo/main", {
    route: "demo/main",
    addedAt: "2026-03-19T16:30:00Z",
    lastSuccessAt: "2026-03-20T08:30:00Z",
    lastSuccessfulTitle: "Demo Feed",
  });
  await writeState(tempDir, "demo/older", {
    route: "demo/older",
    addedAt: "2026-03-18T16:30:00Z",
    lastSuccessAt: "2026-03-20T07:00:00Z",
    lastSuccessfulTitle: "Older Feed",
  });
  const reportPath = await writeReport(tempDir, {
    totals: { newItems: 2, deletedItems: 1, outputItems: 7 },
  });

  await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    reportPath,
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    fetchImpl: emptyGithubFetch,
  });

  const readme = await readFile(path.join(tempDir, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\| Demo Feed \|/u);
  assert.doesNotMatch(readme, /\| Older Feed \|/u);
  assert.match(readme, /### demo/u);
  assert.match(readme, /### alpha/u);
});

test("buildReadme renders real workflow runs and open failure issues from GitHub data", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-github-"));
  await writeConfig(tempDir, {
    demo: { routes: { "demo/main": { feed: { source: "https://example.com/demo.xml" } } } },
  });
  await writeFeedXml(path.join(tempDir, "dist-feed"), "demo/main", "Demo Feed");
  await writeState(tempDir, "demo/main", {
    route: "demo/main",
    addedAt: "2026-03-19T16:30:00Z",
    lastSuccessAt: "2026-03-20T08:30:00Z",
    lastSuccessfulTitle: "Demo Feed",
  });

  const fetchImpl = async (url) => {
    if (url.includes("/actions/workflows/publish-feed.yml/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            run_number: 42,
            html_url: "https://github.com/owner/repo/actions/runs/42",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-03-20T08:40:00Z",
          },
        ],
      });
    }
    if (url.includes("/issues?state=open")) {
      return jsonResponse([
        {
          title: "[refeed] feed failure: demo/main",
          body: "<!-- refeed-route: demo/main -->",
          html_url: "https://github.com/owner/repo/issues/9",
          updated_at: "2026-03-20T08:35:00Z",
        },
      ]);
    }
    throw new Error(`unexpected url: ${url}`);
  };

  await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    githubToken: "token",
    fetchImpl,
  });

  const readme = await readFile(path.join(tempDir, "README.md"), "utf8");
  assert.match(readme, /#42/u);
  assert.match(readme, /\| 1 \| 1 \| 0 \| 0 \|/u);
});

test("buildReadme excludes the current in-progress workflow run from publish history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-runs-"));
  await writeConfig(tempDir, {
    demo: { routes: { "demo/main": { feed: { source: "https://example.com/demo.xml" } } } },
  });
  await writeFeedXml(path.join(tempDir, "dist-feed"), "demo/main", "Demo Feed");
  await writeState(tempDir, "demo/main", {
    route: "demo/main",
    addedAt: "2026-03-19T16:30:00Z",
    lastSuccessAt: "2026-03-20T08:30:00Z",
    lastSuccessfulTitle: "Demo Feed",
  });

  const fetchImpl = async (url) => {
    if (url.includes("/actions/workflows/publish-feed.yml/runs")) {
      return jsonResponse({
        workflow_runs: [
          { id: 200, run_number: 54, html_url: "https://github.com/owner/repo/actions/runs/200", event: "issues", status: "in_progress", conclusion: null, updated_at: "2026-03-20T09:03:00Z" },
          { id: 199, run_number: 53, html_url: "https://github.com/owner/repo/actions/runs/199", event: "schedule", status: "completed", conclusion: "success", updated_at: "2026-03-20T08:58:40Z" },
        ],
      });
    }
    if (url.includes("/issues?state=open")) {
      return jsonResponse([]);
    }
    throw new Error(`unexpected url: ${url}`);
  };

  await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    githubToken: "token",
    currentRunId: "200",
    fetchImpl,
  });

  const readme = await readFile(path.join(tempDir, "README.md"), "utf8");
  assert.doesNotMatch(readme, /#54/u);
  assert.match(readme, /#53/u);
});

test("buildReadme shows retained state and output counts in subscription status cells", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-status-"));
  await writeConfig(tempDir, {
    demo: {
      feed: { itemlimit: 2 },
      routes: {
        "demo/main": { feed: { source: "https://example.com/demo.xml" } },
        "demo/disabled": { feed: { source: "https://example.com/disabled.xml", enabled: false } },
      },
    },
  });
  await writeFeedXml(path.join(tempDir, "dist-feed"), "demo/main", "Demo Feed");
  await writeState(tempDir, "demo/main", {
    route: "demo/main",
    addedAt: "2026-03-19T16:30:00Z",
    lastSuccessAt: "2026-03-20T08:30:00Z",
    lastSuccessfulTitle: "Demo Feed",
    items: { one: { id: "one" }, two: { id: "two" }, three: { id: "three" } },
  });
  await writeState(tempDir, "demo/disabled", {
    route: "demo/disabled",
    addedAt: "2026-03-19T16:30:00Z",
    disabledAt: "2026-03-20T08:20:00Z",
    items: { one: { id: "one" }, two: { id: "two" } },
  });

  await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    fetchImpl: emptyGithubFetch,
  });

  const readme = await readFile(path.join(tempDir, "README.md"), "utf8");
  const groupReadme = await readFile(path.join(tempDir, "config", "demo", "README.md"), "utf8");
  const publicCatalog = await readFile(path.join(tempDir, "dist-feed", "groups", "89e495e7941c.html"), "utf8");
  assert.doesNotMatch(readme, /\| Demo Feed \|/u);
  assert.match(groupReadme, /\| Demo Feed \| <ul><li>状态：✅ 已启用<\/li><li>储存：3 条<\/li><li>输出：2 条<\/li><\/ul> \|/u);
  assert.match(groupReadme, /\| 待获取 \| <ul><li>状态：⏸️ 已关闭<\/li><li>储存：2 条<\/li><li>输出：0 条<\/li><\/ul> \|/u);
  assert.match(publicCatalog, /<h1>demo<\/h1>/u);
  assert.match(publicCatalog, /<th>订阅<\/th>/u);
  assert.doesNotMatch(publicCatalog, /<li>状态：✅ 已启用<\/li>/u);
});

test("buildReadme writes group readmes and public catalogs for non-ascii group names", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-group-files-"));
  await writeConfig(tempDir, {
    "女神的古拉20": {
      routes: {
        "jike/topic/55fadac08cc2e30e00e2e42a": {
          feed: { source: "https://example.com/jike.xml" },
        },
      },
    },
  });

  await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    fetchImpl: emptyGithubFetch,
  });

  const groupReadme = await readFile(path.join(tempDir, "config", "女神的古拉20", "README.md"), "utf8");
  const publicCatalog = await readFile(path.join(tempDir, "dist-feed", "groups", "10d638ba7171.html"), "utf8");
  assert.match(groupReadme, /## 女神的古拉20/u);
  assert.match(groupReadme, /\[公开清单\]\(https:\/\/feeds\.example\.com\/feeds\/groups\/10d638ba7171\.html\)/u);
  assert.match(publicCatalog, /<h1>女神的古拉20<\/h1>/u);
});

test("buildReadme filters failure issues for routes already fixed in the current run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-build-readme-zero-chart-"));
  await writeConfig(tempDir, {
    demo: { routes: { "demo/main": { feed: { source: "https://example.com/demo.xml" } } } },
  });

  await buildReadme({
    configPath: path.join(tempDir, "config.json"),
    stateDir: path.join(tempDir, "state"),
    feedDir: path.join(tempDir, "dist-feed"),
    reportPath: await writeReport(tempDir, {
      successfulRoutes: [{ route: "demo/main" }],
      totals: { newItems: 1, deletedItems: 0, outputItems: 1 },
    }),
    outputFile: path.join(tempDir, "README.md"),
    baseUrl: "https://feeds.example.com",
    repoSlug: "owner/repo",
    fetchImpl: async (url) => {
      if (url.includes("/actions/workflows/publish-feed.yml/runs")) {
        return jsonResponse({ workflow_runs: [] });
      }
      if (url.includes("/issues?state=open")) {
        return jsonResponse([
          {
            title: "[refeed] feed failure: demo/main",
            body: "<!-- refeed-route: demo/main -->",
            html_url: "https://github.com/owner/repo/issues/9",
            updated_at: "2026-03-20T08:35:00Z",
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const readme = await readFile(path.join(tempDir, "README.md"), "utf8");
  assert.doesNotMatch(readme, /demo\/main<\/code><\/a> · 2026\/03\/20 16:35/u);
});
