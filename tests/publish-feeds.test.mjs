import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildRssXml,
  parseRssDocument,
  publishFeeds,
  renderRule,
} from "../.github/scripts/publish-feeds.mjs";
import { DEFAULT_FEED_SIZE_LIMIT_BYTES } from "../.github/scripts/lib/rules.mjs";

const execFileAsync = promisify(execFile);

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Source Feed</title>
    <link>https://example.com</link>
    <description>Source Description</description>
    <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title>Hello</title>
      <link>https://example.com/1</link>
      <description>First item</description>
      <author>Alice</author>
      <guid>item-1</guid>
    </item>
  </channel>
</rss>`;

const RSS_WITH_ARRAY_FIELDS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Array Feed</title>
    <link>https://example.com/array</link>
    <item>
      <title>Indexed Item</title>
      <link>https://example.com/indexed</link>
      <category>one</category>
      <category>two</category>
      <enclosure url="https://example.com/a.jpg" type="image/jpeg"/>
      <enclosure url="https://example.com/b.jpg" type="image/jpeg"/>
    </item>
  </channel>
</rss>`;

const RSS_WITH_STYLED_HTML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Styled Feed</title>
    <link>https://example.com/styled</link>
    <item>
      <title>Styled Item</title>
      <link>https://example.com/styled-item</link>
      <description><![CDATA[<section class="wrapper"><p class="lead" style="color:red" id="lead">Text <span style="font-size:14px">inside</span></p><p> </p><img src="https://example.com/a.jpg" width="640" height="480" class="cover"><details><summary style="font-weight:bold">More</summary><font class="legacy">detail</font></details><script>alert(1)</script></section>]]></description>
      <guid>styled-item</guid>
    </item>
  </channel>
</rss>`;

const RSS_WITH_NAMESPACED_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Namespaced Feed</title>
    <link>https://example.com/namespaced</link>
    <item>
      <title>Namespaced Item</title>
      <link>https://example.com/namespaced-item</link>
      <description>Short summary</description>
      <content:encoded><![CDATA[<section data-pm-slice="0 0 []"><p>Long body</p></section>]]></content:encoded>
      <guid>namespaced-item</guid>
    </item>
  </channel>
</rss>`;

const RSS_WITH_ITUNES_DURATION = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Podcast Feed</title>
    <link>https://example.com/podcast</link>
    <item>
      <title>Podcast Item</title>
      <link>https://example.com/podcast-item</link>
      <description>Episode summary</description>
      <itunes:duration>0:17:10</itunes:duration>
      <guid>podcast-item</guid>
    </item>
  </channel>
</rss>`;

const RSS_CHANNEL_ONLY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Channel Refresh</title>
    <link>https://example.com/refresh</link>
    <description>Refreshed only</description>
  </channel>
</rss>`;

const RSS_TWO_ITEMS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Dual Feed</title>
    <link>https://example.com/dual</link>
    <item>
      <title>First</title>
      <link>https://example.com/1</link>
      <description>First item</description>
      <guid>item-1</guid>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/2</link>
      <description>Second item</description>
      <guid>item-2</guid>
    </item>
  </channel>
</rss>`;

const LARGE_RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Large Feed</title>
    <link>https://example.com/large</link>
    <item>
      <title>Large Item</title>
      <link>https://example.com/large-item</link>
      <description>${"x".repeat(1_500_000)}</description>
      <guid>large-item</guid>
    </item>
  </channel>
</rss>`;

const OVERSIZED_RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Oversized Feed</title>
    <link>https://example.com/oversized</link>
    <item>
      <title>Oversized Item</title>
      <link>https://example.com/oversized-item</link>
      <description>${"x".repeat(DEFAULT_FEED_SIZE_LIMIT_BYTES + 1024)}</description>
      <guid>oversized-item</guid>
    </item>
  </channel>
</rss>`;

const OUTPUT_LIMIT_SOURCE_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Output Limited Feed</title>
    <link>https://example.com/output-limited</link>
    <item>
      <title>Output Limited Item</title>
      <link>https://example.com/output-limited-item</link>
      <description>Short source text</description>
      <guid>output-limited-item</guid>
    </item>
  </channel>
</rss>`;

async function writeConfig(rootDir, payload) {
  await writeFile(
    path.join(rootDir, "config.json"),
    JSON.stringify(payload, null, 2),
    "utf8"
  );
}

async function writeRouteState(stateDir, route, payload) {
  const statePath = path.join(stateDir, `${route}.json`);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readRouteState(stateDir, route) {
  return JSON.parse(await readFile(path.join(stateDir, `${route}.json`), "utf8"));
}

test("parseRssDocument extracts channel and items", () => {
  const parsed = parseRssDocument(RSS_SAMPLE);
  assert.equal(parsed.channel.title, "Source Feed");
  assert.equal(parsed.items[0].author, "Alice");
});

test("parseRssDocument handles entity-heavy payloads within configured limits", () => {
  const entityHeavyXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Entity Feed</title>
    <link>https://example.com/entity</link>
    <item>
      <title>Entity Item</title>
      <link>https://example.com/entity-item</link>
      <description>${"&amp;".repeat(25000)}</description>
      <guid>entity-item</guid>
    </item>
  </channel>
</rss>`;

  const parsed = parseRssDocument(entityHeavyXml);
  assert.equal(parsed.channel.title, "Entity Feed");
  assert.equal(parsed.items[0].guid, "entity-item");
  assert.equal(parsed.items[0].description.length, 25000);
});

test("renderRule preserves source fields and applies direct patches", () => {
  const rendered = renderRule(
    {
      route: "demo/main",
      source: "https://example.com/demo.xml",
      channel: {
        "atom:link": false,
        webMaster: "admin@example.com",
      },
      item: {
        title: "作者: {{ $item.author }}，标题: {{ $item.title }}",
        author: false,
        guid: true,
      },
    },
    parseRssDocument(RSS_SAMPLE),
    "https://feeds.example.com"
  );

  assert.equal(rendered.channel.title, "Source Feed");
  assert.equal(rendered.channel.link, "https://example.com");
  assert.equal(rendered.channel.webMaster, "admin@example.com");
  assert.equal(rendered.channel["atom:link"], undefined);
  assert.equal(rendered.items[0].title, "作者: Alice，标题: Hello");
  assert.equal(rendered.items[0].description, "First item");
  assert.equal(rendered.items[0].author, undefined);
  assert.equal(rendered.items[0].guid, "item-1");
});

test("renderRule applies route-level false patch keys without requiring group defaults", () => {
  const rendered = renderRule(
    {
      route: "demo/main",
      source: "https://example.com/demo.xml",
      channel: {
        image: false,
      },
      item: {
        author: false,
      },
    },
    parseRssDocument(RSS_SAMPLE),
    "https://feeds.example.com"
  );

  assert.equal(rendered.channel.image, undefined);
  assert.equal(rendered.items[0].author, undefined);
});

test("renderRule supports numeric array index access for repeated nodes", () => {
  const rendered = renderRule(
    {
      route: "demo/index-access",
      source: "https://example.com/indexed.xml",
      item: {
        category: "{{ $item.category[0] }}",
        enclosure: {
          "@_url": "{{ $item.enclosure[0]['@_url'] }}",
          "@_type": "{{ $item.enclosure[0]['@_type'] }}",
        },
      },
    },
    parseRssDocument(RSS_WITH_ARRAY_FIELDS),
    "https://feeds.example.com"
  );

  assert.equal(rendered.items[0].category, "one");
  assert.deepEqual(rendered.items[0].enclosure, {
    "@_url": "https://example.com/a.jpg",
    "@_type": "image/jpeg",
  });
});

test("renderRule cleans styled item.description HTML when feed.htmlcleanup is enabled", () => {
  const rendered = renderRule(
    {
      route: "demo/styled",
      source: "https://example.com/styled.xml",
      htmlCleanup: true,
    },
    parseRssDocument(RSS_WITH_STYLED_HTML),
    "https://feeds.example.com"
  );

  assert.equal(
    rendered.items[0].description,
    '<section><p>Text inside</p><img src="https://example.com/a.jpg"><details><summary>More</summary>detail</details></section>'
  );
});

test("buildRssXml declares namespaces required by prefixed RSS fields", () => {
  const rendered = renderRule(
    {
      route: "demo/namespaced",
      source: "https://example.com/namespaced.xml",
    },
    parseRssDocument(RSS_WITH_NAMESPACED_CONTENT),
    "https://feeds.example.com"
  );

  const xml = buildRssXml(rendered);
  assert.match(xml, /xmlns:content="http:\/\/purl\.org\/rss\/1\.0\/modules\/content\/"/u);

  const parsed = parseRssDocument(xml);
  assert.match(parsed.items[0]["content:encoded"], /data-pm-slice/u);
});

test("buildRssXml preserves source namespaces for prefixed RSS fields outside the built-in map", () => {
  const rendered = renderRule(
    {
      route: "demo/podcast",
      source: "https://example.com/podcast.xml",
    },
    parseRssDocument(RSS_WITH_ITUNES_DURATION),
    "https://feeds.example.com"
  );

  const xml = buildRssXml(rendered);
  assert.match(xml, /xmlns:itunes="http:\/\/www\.itunes\.com\/dtds\/podcast-1\.0\.dtd"/u);

  const parsed = parseRssDocument(xml);
  assert.equal(parsed.items[0]["itunes:duration"], "0:17:10");
});

test("publishFeeds preserves previous artifact for failed routes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-publish-"));
  const existingDir = path.join(tempDir, "existing");
  const outputDir = path.join(tempDir, "output");
  const stateDir = path.join(tempDir, "state");
  await mkdir(path.join(existingDir, "demo"), { recursive: true });
  await writeFile(
    path.join(existingDir, "demo", "main.xml"),
    "<rss><channel><title>previous</title></channel></rss>",
    "utf8"
  );

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/fail.xml",
          },
        },
        fresh: {
          feed: {
            source: "https://example.com/ok.xml",
          },
          item: {
            title: "{{ $item.title }}",
          },
        },
      },
    },
  });

  const fetchImpl = async (url) => {
    if (url.endsWith("/ok.xml")) {
      return new Response(RSS_SAMPLE, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    }
    return new Response("boom", { status: 500, statusText: "boom" });
  };

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    existingDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 2,
    timeoutMs: 2000,
    fetchImpl,
  });

  const preserved = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  const fresh = await readFile(path.join(outputDir, "fresh.xml"), "utf8");
  const freshState = await readRouteState(stateDir, "fresh");
  const failedState = await readRouteState(stateDir, "demo/main");

  assert.match(preserved, /previous/u);
  assert.match(fresh, /Source Feed/u);
  assert.equal(report.totals.succeeded, 1);
  assert.equal(report.totals.failed, 1);
  assert.equal(freshState.lastSuccessfulTitle, "Source Feed");
  assert.equal(failedState.lastError.stage, "fetch");
  assert.doesNotMatch(report.failedRoutes[0].error, /https?:\/\//u);
  assert.equal(report.failedRoutes[0].newItems, 0);
  assert.equal(report.failedRoutes[0].deletedItems, 0);
  assert.equal(report.failedRoutes[0].outputItems, 0);
});

test("publishFeeds redacts source urls from thrown fetch errors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-redaction-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        secret: {
          feed: {
            source: "https://example.com/private.xml?token=secret",
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: async () => {
      throw new Error("upstream failed for https://example.com/private.xml?token=secret");
    },
  });

  assert.equal(report.totals.failed, 1);
  assert.match(report.failedRoutes[0].error, /<redacted-url>/u);
  assert.doesNotMatch(report.failedRoutes[0].error, /https?:\/\//u);
});

test("publishFeeds re-queues failed fetch attempts behind remaining routes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-fetch-queue-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");
  const requestOrder = [];
  let alphaAttempts = 0;

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        alpha: {
          feed: {
            source: "https://example.com/alpha.xml",
          },
        },
        beta: {
          feed: {
            source: "https://example.com/beta.xml",
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 2,
    timeoutMs: 2000,
    fetchImpl: async (url) => {
      requestOrder.push(url);
      if (url.endsWith("/alpha.xml")) {
        alphaAttempts += 1;
        if (alphaAttempts === 1) {
          return new Response("boom", { status: 500, statusText: "boom" });
        }
      }

      return new Response(RSS_SAMPLE, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
  });

  assert.deepEqual(requestOrder, [
    "https://example.com/alpha.xml",
    "https://example.com/beta.xml",
    "https://example.com/alpha.xml",
  ]);
  assert.equal(report.totals.succeeded, 2);
  assert.equal(report.totals.failed, 0);
  assert.deepEqual(
    report.successfulRoutes.map((entry) => ({
      route: entry.route,
      attempts: entry.attempts,
    })),
    [
      { route: "alpha", attempts: 2 },
      { route: "beta", attempts: 1 },
    ]
  );
});

test("publishFeeds applies feed.itemlimit to output without pruning retained state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-itemlimit-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
            itemlimit: 1,
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: async () =>
      new Response(RSS_TWO_ITEMS, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  const xml = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  const nextState = await readRouteState(stateDir, "demo/main");

  assert.match(xml, /<title>First<\/title>/u);
  assert.doesNotMatch(xml, /<title>Second<\/title>/u);
  assert.equal(Object.keys(nextState.items).length, 2);
  assert.equal(nextState.items["guid:item-1"].lastPublishedAt !== null, true);
  assert.equal(nextState.items["guid:item-2"].lastPublishedAt, null);
  assert.equal(report.totals.newItems, 2);
  assert.equal(report.totals.deletedItems, 0);
  assert.equal(report.totals.outputItems, 1);
  assert.equal(report.successfulRoutes[0].newItems, 2);
  assert.equal(report.successfulRoutes[0].deletedItems, 0);
  assert.equal(report.successfulRoutes[0].outputItems, 1);
});

test("publishFeeds applies feed.statelimit before state-based item statistics", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-statelimit-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");

  await writeRouteState(stateDir, "demo/main", {
    route: "demo/main",
    group: "feeds",
    source: "https://example.com/demo.xml",
    enabled: true,
    version: 1,
    addedAt: "2026-03-20T00:00:00.000Z",
    disabledAt: null,
    updatedAt: "2026-03-20T00:00:00.000Z",
    lastAttemptAt: "2026-03-20T00:00:00.000Z",
    lastSuccessAt: "2026-03-20T00:00:00.000Z",
    lastError: null,
    lastSuccessfulTitle: "Legacy Feed",
    channel: {
      title: "Legacy Feed",
      link: "https://example.com/legacy",
    },
    items: {
      "guid:legacy-item": {
        id: "guid:legacy-item",
        guid: "legacy-item",
        link: "https://example.com/legacy-item",
        publishedAt: null,
        firstSeenAt: "2026-03-20T00:00:00.000Z",
        lastSeenAt: "2026-03-20T00:00:00.000Z",
        lastPublishedAt: "2026-03-20T00:00:00.000Z",
        raw: {
          title: "Legacy",
          link: "https://example.com/legacy-item",
          guid: "legacy-item",
        },
      },
    },
  });

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
            statelimit: 2,
            itemlimit: 1,
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: async () =>
      new Response(RSS_TWO_ITEMS, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  const xml = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  const nextState = await readRouteState(stateDir, "demo/main");

  assert.deepEqual(Object.keys(nextState.items).sort(), [
    "guid:item-1",
    "guid:item-2",
  ]);
  assert.equal(nextState.items["guid:item-1"].lastPublishedAt !== null, true);
  assert.equal(nextState.items["guid:item-2"].lastPublishedAt, null);
  assert.equal(nextState.items["guid:legacy-item"], undefined);
  assert.match(xml, /<title>First<\/title>/u);
  assert.doesNotMatch(xml, /<title>Second<\/title>/u);
  assert.equal(report.totals.newItems, 2);
  assert.equal(report.totals.deletedItems, 1);
  assert.equal(report.totals.outputItems, 1);
});

test("publishFeeds applies feed.statelimit before computing state deletions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-statelimit-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
            statelimit: 1,
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: async () =>
      new Response(RSS_TWO_ITEMS, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  const xml = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  const nextState = await readRouteState(stateDir, "demo/main");

  assert.equal(Object.keys(nextState.items).length, 1);
  assert.match(xml, /<title>First<\/title>/u);
  assert.doesNotMatch(xml, /<title>Second<\/title>/u);
  assert.equal(report.totals.newItems, 1);
  assert.equal(report.totals.deletedItems, 0);
  assert.equal(report.totals.outputItems, 1);
});

test("publishFeeds keeps retained state items publishable when the latest fetch has none", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-state-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
        },
      },
    },
  });

  await writeRouteState(stateDir, "demo/main", {
    route: "demo/main",
    group: "feeds",
    source: "https://example.com/demo.xml",
    enabled: true,
    version: 1,
    addedAt: "2026-03-20T00:00:00.000Z",
    disabledAt: null,
    updatedAt: "2026-03-20T00:00:00.000Z",
    lastAttemptAt: "2026-03-20T00:00:00.000Z",
    lastSuccessAt: "2026-03-20T00:00:00.000Z",
    lastError: null,
    lastSuccessfulTitle: "Legacy Feed",
    channel: {
      title: "Legacy Feed",
      link: "https://example.com/legacy",
      description: "Legacy description",
    },
    items: {
      "guid:item-1": {
        id: "guid:item-1",
        guid: "item-1",
        link: "https://example.com/1",
        publishedAt: "2026-03-20T00:00:00.000Z",
        firstSeenAt: "2026-03-20T00:00:00.000Z",
        lastSeenAt: "2026-03-20T00:00:00.000Z",
        lastPublishedAt: "2026-03-20T00:00:00.000Z",
        raw: {
          title: "Hello",
          link: "https://example.com/1",
          description: "First item",
          guid: "item-1",
        },
      },
    },
  });

  await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 2,
    timeoutMs: 2000,
    fetchImpl: async () =>
      new Response(RSS_CHANNEL_ONLY, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  const xml = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  const nextState = await readRouteState(stateDir, "demo/main");

  assert.match(xml, /<title>Hello<\/title>/u);
  assert.equal(nextState.lastSuccessfulTitle, "Channel Refresh");
});

test("publishFeeds full-refresh rebuilds scoped route state and reports deletions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-full-refresh-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
        },
      },
    },
  });

  await writeRouteState(stateDir, "demo/main", {
    route: "demo/main",
    group: "feeds",
    source: "https://example.com/demo.xml",
    enabled: true,
    version: 1,
    addedAt: "2026-03-20T00:00:00.000Z",
    disabledAt: null,
    updatedAt: "2026-03-20T00:00:00.000Z",
    lastAttemptAt: "2026-03-20T00:00:00.000Z",
    lastSuccessAt: "2026-03-20T00:00:00.000Z",
    lastError: null,
    lastSuccessfulTitle: "Legacy Feed",
    channel: {
      title: "Legacy Feed",
      link: "https://example.com/legacy",
    },
    items: {
      "guid:legacy-item": {
        id: "guid:legacy-item",
        guid: "legacy-item",
        link: "https://example.com/legacy-item",
        publishedAt: "2026-03-20T00:00:00.000Z",
        firstSeenAt: "2026-03-20T00:00:00.000Z",
        lastSeenAt: "2026-03-20T00:00:00.000Z",
        lastPublishedAt: "2026-03-20T00:00:00.000Z",
        raw: {
          title: "Legacy",
          link: "https://example.com/legacy-item",
          guid: "legacy-item",
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    route: "demo/main",
    mode: "full-refresh",
    fetchImpl: async () =>
      new Response(RSS_TWO_ITEMS, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  const nextState = await readRouteState(stateDir, "demo/main");

  assert.deepEqual(Object.keys(nextState.items).sort(), [
    "guid:item-1",
    "guid:item-2",
  ]);
  assert.equal(report.mode, "full-refresh");
  assert.equal(report.totals.newItems, 2);
  assert.equal(report.totals.deletedItems, 1);
  assert.equal(report.totals.outputItems, 2);
});

test("publishFeeds preserves prior route payload when full-refresh fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-full-refresh-fail-"));
  const existingDir = path.join(tempDir, "existing");
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "output");
  await mkdir(path.join(existingDir, "demo"), { recursive: true });
  await writeFile(
    path.join(existingDir, "demo", "main.xml"),
    "<rss><channel><title>previous</title><item><title>Legacy</title></item></channel></rss>",
    "utf8"
  );

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
        },
      },
    },
  });

  await writeRouteState(stateDir, "demo/main", {
    route: "demo/main",
    group: "feeds",
    source: "https://example.com/demo.xml",
    enabled: true,
    version: 1,
    addedAt: "2026-03-20T00:00:00.000Z",
    disabledAt: null,
    updatedAt: "2026-03-20T00:00:00.000Z",
    lastAttemptAt: "2026-03-20T00:00:00.000Z",
    lastSuccessAt: "2026-03-20T00:00:00.000Z",
    lastError: null,
    lastSuccessfulTitle: "Legacy Feed",
    channel: {
      title: "Legacy Feed",
      link: "https://example.com/legacy",
    },
    items: {
      "guid:legacy-item": {
        id: "guid:legacy-item",
        guid: "legacy-item",
        link: "https://example.com/legacy-item",
        publishedAt: "2026-03-20T00:00:00.000Z",
        firstSeenAt: "2026-03-20T00:00:00.000Z",
        lastSeenAt: "2026-03-20T00:00:00.000Z",
        lastPublishedAt: "2026-03-20T00:00:00.000Z",
        raw: {
          title: "Legacy",
          link: "https://example.com/legacy-item",
          guid: "legacy-item",
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    existingDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    route: "demo/main",
    mode: "full-refresh",
    fetchImpl: async () => new Response("boom", { status: 500, statusText: "boom" }),
  });

  const xml = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  const nextState = await readRouteState(stateDir, "demo/main");

  assert.match(xml, /previous/u);
  assert.deepEqual(Object.keys(nextState.items), ["guid:legacy-item"]);
  assert.equal(nextState.lastError.stage, "fetch");
  assert.equal(report.failedRoutes[0].newItems, 0);
  assert.equal(report.failedRoutes[0].deletedItems, 0);
  assert.equal(report.failedRoutes[0].outputItems, 0);
});

test("publishFeeds streams curl responses through temp files for large feeds", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-curl-large-"));
  const stateDir = path.join(tempDir, "state");
  const outputDir = path.join(tempDir, "dist-feed");
  let capturedOutputPath = "";

  await writeConfig(tempDir, {
    demo: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/large.xml",
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: fetch,
    curlExecFile: async (command, args) => {
      assert.equal(command, "curl");
      const outputFlagIndex = args.indexOf("-o");
      assert.notEqual(outputFlagIndex, -1);
      capturedOutputPath = args[outputFlagIndex + 1];
      await writeFile(capturedOutputPath, LARGE_RSS_SAMPLE, "utf8");
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(report.totals.succeeded, 1);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.successfulRoutes[0].route, "demo/main");
  assert.equal(report.successfulRoutes[0].outputItems, 1);

  const renderedXml = await readFile(path.join(outputDir, "demo", "main.xml"), "utf8");
  assert.match(renderedXml, /<title>Large Feed<\/title>/u);
  assert.match(renderedXml, /<guid>large-item<\/guid>/u);

  await assert.rejects(() => readFile(capturedOutputPath, "utf8"));
});

test("publishFeeds removes oversized source feed artifacts from output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-source-limit-"));
  const existingDir = path.join(tempDir, "existing");
  const outputDir = path.join(tempDir, "output");
  const stateDir = path.join(tempDir, "state");

  await mkdir(path.join(existingDir, "demo"), { recursive: true });
  await writeFile(
    path.join(existingDir, "demo", "main.xml"),
    "<rss><channel><title>previous-source</title></channel></rss>",
    "utf8"
  );

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/large.xml",
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    existingDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: async () =>
      new Response(OVERSIZED_RSS_SAMPLE, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  await assert.rejects(() => readFile(path.join(outputDir, "demo", "main.xml"), "utf8"));
  const failedState = await readRouteState(stateDir, "demo/main");

  assert.equal(report.totals.succeeded, 0);
  assert.equal(report.totals.failed, 1);
  assert.match(report.failedRoutes[0].error, /source feed size exceeds limit/u);
  assert.equal(failedState.lastError.stage, "fetch");
});

test("publishFeeds removes oversized rendered feed artifacts from output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-output-limit-"));
  const existingDir = path.join(tempDir, "existing");
  const outputDir = path.join(tempDir, "output");
  const stateDir = path.join(tempDir, "state");

  await mkdir(path.join(existingDir, "demo"), { recursive: true });
  await writeFile(
    path.join(existingDir, "demo", "main.xml"),
    "<rss><channel><title>previous-output</title></channel></rss>",
    "utf8"
  );

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
          item: {
            description: `${"x".repeat(DEFAULT_FEED_SIZE_LIMIT_BYTES + 1024)}`,
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    existingDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 1,
    timeoutMs: 2000,
    fetchImpl: async () =>
      new Response(OUTPUT_LIMIT_SOURCE_SAMPLE, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  });

  await assert.rejects(() => readFile(path.join(outputDir, "demo", "main.xml"), "utf8"));
  const failedState = await readRouteState(stateDir, "demo/main");

  assert.equal(report.totals.succeeded, 0);
  assert.equal(report.totals.failed, 1);
  assert.match(report.failedRoutes[0].error, /output feed size exceeds limit/u);
  assert.equal(failedState.lastError.stage, "render");
});

test("publishFeeds fails fast for unknown scoped routes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-scoped-missing-"));
  const outputDir = path.join(tempDir, "output");

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
        },
      },
    },
  });

  await assert.rejects(
    () =>
      publishFeeds({
        configPath: path.join(tempDir, "config.json"),
        stateDir: path.join(tempDir, "state"),
        outputDir,
        reportPath: path.join(tempDir, "report.json"),
        route: "missing/route",
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
      }),
    /unknown scoped route/u
  );
});

test("publishFeeds writes fatal config diagnostics without touching output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-config-fatal-"));
  const existingDir = path.join(tempDir, "existing");
  const outputDir = path.join(tempDir, "output");
  const stateDir = path.join(tempDir, "state");

  await mkdir(path.join(existingDir, "demo"), { recursive: true });
  await writeFile(
    path.join(existingDir, "demo", "main.xml"),
    "<rss><channel><title>previous</title></channel></rss>",
    "utf8"
  );

  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
          schema: {
            item: {
              title: "{{ $item.title }}",
            },
          },
        },
      },
    },
  });

  const report = await publishFeeds({
    configPath: path.join(tempDir, "config.json"),
    stateDir,
    outputDir,
    existingDir,
    reportPath: path.join(tempDir, "report.json"),
    publicBaseUrl: "https://feeds.example.com",
    retries: 2,
    timeoutMs: 2000,
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(report.hasFatalConfigErrors, true);
  assert.match(report.configDiagnostics[0].message, /legacy `schema`/u);
  assert.equal(report.failedRoutes[0].route, "[config]");
  const existingXml = await readFile(path.join(existingDir, "demo", "main.xml"), "utf8");
  assert.match(existingXml, /previous/u);
  await assert.rejects(() => readFile(path.join(outputDir, "demo", "main.xml"), "utf8"));
  await assert.rejects(() => readFile(path.join(stateDir, "demo", "main.json"), "utf8"));
});

test("publish-feeds CLI exits non-zero on fatal config diagnostics", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refeed-cli-fatal-"));
  await writeConfig(tempDir, {
    feeds: {
      routes: {
        "demo/main": {
          feed: {
            source: "https://example.com/demo.xml",
          },
          schema: {
            item: {
              title: "{{ $item.title }}",
            },
          },
        },
      },
    },
  });

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          ".github/scripts/publish-feeds.mjs",
          `--config=${path.join(tempDir, "config.json")}`,
          `--state-dir=${path.join(tempDir, "state")}`,
          `--output-dir=${path.join(tempDir, "dist-feed")}`,
          `--report-path=${path.join(tempDir, "report.json")}`,
        ],
        { cwd: process.cwd() }
      ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /publish skipped by fatal config diagnostics/u);
      return true;
    }
  );
});

test('publishFeeds supports multiple scoped routes', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refeed-publish-routes-'));
  const outputDir = path.join(tempDir, 'dist');
  const stateDir = path.join(tempDir, 'state');
  await writeConfig(tempDir, {
    demo: {
      routes: {
        'alpha/main': {
          feed: {
            source: 'https://example.com/a.xml',
          },
        },
        'beta/main': {
          feed: {
            source: 'https://example.com/b.xml',
          },
        },
        'gamma/main': {
          feed: {
            source: 'https://example.com/c.xml',
          },
        },
      },
    },
  });

  const fetchImpl = async (url) => {
    if (url === 'https://example.com/a.xml') {
      return new Response(RSS_SAMPLE, { status: 200 });
    }
    if (url === 'https://example.com/c.xml') {
      return new Response(RSS_CHANNEL_ONLY, { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const report = await publishFeeds({
    configPath: path.join(tempDir, 'config.json'),
    stateDir,
    outputDir,
    routes: ['alpha/main', 'gamma/main'],
    fetchImpl,
  });

  assert.deepEqual(report.scopedRoutes, ['alpha/main', 'gamma/main']);
  assert.equal(report.totals.processed, 2);
  assert.equal(report.totals.enabled, 3);
  assert.equal(report.totals.succeeded, 2);
  await assert.rejects(() => readFile(path.join(outputDir, 'beta', 'main.xml'), 'utf8'), /ENOENT/u);
  assert.match(await readFile(path.join(outputDir, 'alpha', 'main.xml'), 'utf8'), /Source Feed/u);
  assert.match(await readFile(path.join(outputDir, 'gamma', 'main.xml'), 'utf8'), /Channel Refresh/u);
});
