import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  evaluate,
  findExistingChromeDebugPort,
  getDefaultProfileDir,
  getPageSession,
  launchChrome,
  sleep,
  tryConnectExisting,
  type CdpConnection,
  type ChromeSession,
} from './cdp.ts';
import { getBaijiahaoPageState, isBaijiahaoSessionLoggedIn } from './baijiahao-auth.ts';
import {
  assertDeleteSafety,
  collectMetricRecord,
  extractMetricRecordFromText,
  isDeleteConfirmDialogTextSafe,
  isListHydrated,
  METRIC_LABELS,
  parseManageArgs,
} from './baijiahao-manage-parse.ts';
import type { ArticleMetrics, BaijiahaoArticleItem, ManageOptions } from './baijiahao-manage-types.ts';

const BAIJIAHAO_HOME = 'https://baijiahao.baidu.com/';
const BAIJIAHAO_CONTENT_URL = 'https://baijiahao.baidu.com/builder/rc/content';
const RISK_MARKERS = ['验证码', '安全验证', '账号已退出', '请重新登录', '扫码登录', '异常操作'];

interface ManageRuntime {
  cdp: CdpConnection;
  session: ChromeSession;
  chrome: ReturnType<typeof import('node:child_process').spawn> | null;
}

interface ListHydrationSnapshot {
  url: string;
  bodyLength: number;
  anchorCount: number;
  articleLinkCount: number;
  hasListWord: boolean;
  hasContentCount: boolean;
  hasStatusTabs: boolean;
  hasActionText: boolean;
}

function printHelp(): void {
  console.log(`Usage:
  npx -y bun baijiahao-manage.ts list [--search 关键词] [--max-pages 3] [--page-size 10]
  npx -y bun baijiahao-manage.ts get --article-id 123456
  npx -y bun baijiahao-manage.ts delete --article-id 123456 --confirm

Commands:
  list                 Browser-led content list crawl (slow, paged)
  get                  Read article metrics (read/like/collect/share/comment)
  delete               Delete one article with explicit confirmation

Flags:
  --article-id <id>    Target article id
  --nid <id>           Target nid
  --search <text>      Title search keyword (list/get fallback)
  --status <value>     Content status filter (default: all)
  --max-pages <n>      Max pages to visit (default: 3)
  --page-size <n>      Page size (default: 10)
  --profile-dir <dir>  Chrome profile dir override
  --cdp-port <port>    Reuse existing Chrome debug port
  --slow-ms <ms>       Delay between actions (default: 1600)
  --confirm            Required for delete
  --help               Show help
`);
}

function loadExtendFile(filePath: string): Record<string, string> {
  const data: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return data;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    let value = trimmed.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

function resolveOptions(argv: string[]): ManageOptions {
  const parsed = parseManageArgs(argv);
  const projectPath = path.join(process.cwd(), '.thy1cc-skills', 'thy1cc-post-to-baijiahao', 'EXTEND.md');
  const userPath = path.join(os.homedir(), '.thy1cc-skills', 'thy1cc-post-to-baijiahao', 'EXTEND.md');
  const config = {
    ...loadExtendFile(userPath),
    ...loadExtendFile(projectPath),
  };

  return {
    ...parsed,
    profileDir: parsed.profileDir || config.chrome_profile_path || getDefaultProfileDir(),
    pageSize: Math.min(Math.max(parsed.pageSize, 1), 50),
    maxPages: Math.min(Math.max(parsed.maxPages, 1), 50),
    slowMs: Math.min(Math.max(parsed.slowMs, 300), 10000),
  };
}

function buildListUrl(options: ManageOptions, page: number): string {
  const url = new URL(BAIJIAHAO_CONTENT_URL);
  url.searchParams.set('currentPage', String(page));
  url.searchParams.set('pageSize', String(options.pageSize));
  url.searchParams.set('search', options.search);
  url.searchParams.set('type', 'all');
  url.searchParams.set('collection', '');
  url.searchParams.set('status', options.status === 'all' ? '' : options.status);
  url.searchParams.set('startDate', '');
  url.searchParams.set('endDate', '');
  return url.toString();
}

async function attachSessionToTarget(cdp: CdpConnection, targetId: string): Promise<ChromeSession> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, { sessionId });
  await cdp.send('Runtime.enable', {}, { sessionId });
  await cdp.send('DOM.enable', {}, { sessionId });
  return { cdp, sessionId, targetId };
}

async function openRuntime(options: ManageOptions): Promise<ManageRuntime> {
  let cdp: CdpConnection;
  let chrome: ReturnType<typeof import('node:child_process').spawn> | null = null;

  const portToTry = options.cdpPort ?? await findExistingChromeDebugPort({ urlHints: ['baijiahao.baidu.com'] });
  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) {
      cdp = existing;
      console.error(`[baijiahao-manage] Connected to existing Chrome on port ${portToTry}`);
    } else {
      const launched = await launchChrome(BAIJIAHAO_HOME, options.profileDir);
      cdp = launched.cdp;
      chrome = launched.chrome;
    }
  } else {
    const launched = await launchChrome(BAIJIAHAO_HOME, options.profileDir);
    cdp = launched.cdp;
    chrome = launched.chrome;
  }

  await sleep(1500);

  let session: ChromeSession;
  if (!chrome) {
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    const existingTab = targets.targetInfos.find((target) => target.type === 'page' && target.url.includes('baijiahao.baidu.com'));
    if (existingTab) {
      session = await attachSessionToTarget(cdp, existingTab.targetId);
    } else {
      const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: BAIJIAHAO_HOME });
      session = await attachSessionToTarget(cdp, created.targetId);
    }
  } else {
    session = await getPageSession(cdp, 'baijiahao.baidu.com');
  }

  return { cdp, session, chrome };
}

async function waitForLogin(session: ChromeSession, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getBaijiahaoPageState(session);
    if (isBaijiahaoSessionLoggedIn(state)) return;
    console.error('[baijiahao-manage] Waiting for login...');
    await sleep(2000);
  }
  throw new Error('Login timeout');
}

async function assertNoRiskChallenge(session: ChromeSession): Promise<void> {
  const state = await getBaijiahaoPageState(session);
  const body = state.bodyText || '';
  const matched = RISK_MARKERS.find((marker) => body.includes(marker));
  if (matched) {
    throw new Error(`Risk or verification page detected: ${matched}`);
  }
}

async function slowDown(ms: number): Promise<void> {
  const jitter = Math.floor(Math.random() * Math.max(200, Math.floor(ms * 0.3)));
  await sleep(ms + jitter);
}

async function navigate(session: ChromeSession, url: string, slowMs: number): Promise<void> {
  await evaluate(session, `window.location.href = ${JSON.stringify(url)}`);
  await slowDown(slowMs);
}

async function getListHydrationSnapshot(session: ChromeSession): Promise<ListHydrationSnapshot | null> {
  return await evaluate<ListHydrationSnapshot | null>(session, `
    (function() {
      const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        url: window.location.href,
        bodyLength: text.length,
        anchorCount: document.querySelectorAll('a[href]').length,
        articleLinkCount: Array.from(document.querySelectorAll('a[href]'))
          .filter((node) => /builder\\/preview\\/s|builder\\/rc\\/edit|article_id=/.test(String(node.getAttribute('href') || '')))
          .length,
        hasListWord: text.includes('作品管理') && (text.includes('草稿') || text.includes('已发布')),
        hasContentCount: /共\\s*\\d+\\s*篇/.test(text),
        hasStatusTabs: ['全部', '已发布', '草稿'].every((label) => text.includes(label)),
        hasActionText: text.includes('修改') && text.includes('删除'),
      };
    })()
  `);
}

async function waitForListHydration(session: ChromeSession, timeoutMs = 12000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await getListHydrationSnapshot(session);

    if (snapshot && isListHydrated(snapshot)) return true;
    await sleep(500);
  }

  return false;
}

async function clickVisibleText(session: ChromeSession, exactText: string): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      };

      const nodes = Array.from(document.querySelectorAll('a,button,[role="button"],div,span')).filter(visible);
      const exact = nodes.find((node) => norm(node.textContent) === ${JSON.stringify(exactText)});
      const partial = nodes.find((node) => norm(node.textContent).includes(${JSON.stringify(exactText)}));
      const target = exact || partial;
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
}

async function ensureContentManagePage(session: ChromeSession, slowMs: number): Promise<void> {
  const current = await getListHydrationSnapshot(session).catch(() => null);
  if (current && isListHydrated(current)) return;

  await navigate(session, BAIJIAHAO_HOME, slowMs);
  await assertNoRiskChallenge(session);
  await slowDown(Math.max(800, Math.floor(slowMs * 0.6)));
  await clickVisibleText(session, '内容管理').catch(() => false);
  await slowDown(Math.max(700, Math.floor(slowMs * 0.5)));
  const clicked = await clickVisibleText(session, '作品管理');
  if (!clicked) {
    throw new Error('Unable to open 百家号作品管理 page from the logged-in homepage.');
  }

  const hydrated = await waitForListHydration(session, 15000);
  if (!hydrated) {
    throw new Error('作品管理 page did not finish hydrating after sidebar navigation.');
  }
}

function isMetricsEmpty(metrics: ArticleMetrics): boolean {
  return metrics.read === 0 && metrics.like === 0 && metrics.collect === 0 && metrics.share === 0 && metrics.comment === 0;
}

function mergeMetrics(primary: ArticleMetrics, fallback: ArticleMetrics): ArticleMetrics {
  return {
    read: Math.max(primary.read, fallback.read),
    like: Math.max(primary.like, fallback.like),
    collect: Math.max(primary.collect, fallback.collect),
    share: Math.max(primary.share, fallback.share),
    comment: Math.max(primary.comment, fallback.comment),
  };
}

function pickArticle(items: BaijiahaoArticleItem[], options: ManageOptions): BaijiahaoArticleItem | null {
  if (options.articleId) {
    return items.find((item) => item.articleId === options.articleId) || null;
  }
  if (options.nid) {
    return items.find((item) => item.nid === options.nid) || null;
  }
  if (options.search) {
    return items.find((item) => item.title.includes(options.search)) || null;
  }
  return null;
}

async function collectListPageItems(session: ChromeSession): Promise<BaijiahaoArticleItem[]> {
  return await evaluate<BaijiahaoArticleItem[]>(session, `
    (function() {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      const parseIdFromUrl = (href, key) => {
        try {
          const url = new URL(href, location.href);
          return normalize(url.searchParams.get(key));
        } catch {
          const pattern = new RegExp('[?&]' + key + '=([^&#]+)');
          const match = String(href || '').match(pattern);
          return normalize(match ? decodeURIComponent(match[1]) : '');
        }
      };

      const extractDate = (text) => {
        const match = text.match(/(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2})?)/);
        return match ? normalize(match[1]) : '';
      };

      const extractStatus = (text) => {
        const match = text.match(/(草稿|已发布|审核中|驳回|发布成功|待发布|发布失败|已下线)/);
        return match ? normalize(match[1]) : '';
      };

      const extractMetricText = (text) => {
        const output = {};
        for (const label of ${JSON.stringify(METRIC_LABELS)}) {
          const pattern = new RegExp(label + '\\\\s*[:：]?\\\\s*([0-9][0-9,.]*(?:\\\\.[0-9]+)?(?:万|亿)?)');
          const match = text.match(pattern);
          if (match) output[label] = normalize(match[1]);
        }
        return output;
      };

      const map = new Map();
      const rows = Array.from(document.querySelectorAll('.client_pages_content_v2_components_articleItem, .article-item, tr, li'))
        .filter(visible);

      for (const row of rows) {
        const titleAnchor = row.querySelector('a[href*="/builder/preview/s"], a[href*="/s?id="], a[href*="article_id="], a[href*="/builder/rc/edit"]');
        const href = titleAnchor ? String(titleAnchor.href || '') : '';
        const articleId = parseIdFromUrl(href, 'article_id');
        const nid = parseIdFromUrl(href, 'id');
        const rowText = normalize(row.textContent);
        const titleNode = row.querySelector('h1,h2,h3,h4,.title,[class*="title"]');
        const title = normalize((titleAnchor && titleAnchor.textContent) || (titleNode && titleNode.textContent));
        const key = articleId || nid || href;
        if (!key || !title) continue;

        const item = {
          title,
          status: extractStatus(rowText),
          publishedAt: extractDate(rowText),
          articleId,
          nid,
          url: href,
          pageUrl: location.href,
          rowText,
          metricText: extractMetricText(rowText),
        };

        const existing = map.get(key);
        if (!existing || item.title.length > existing.title.length) {
          map.set(key, item);
        }
      }

      return Array.from(map.values());
    })()
  `);
}

async function waitForStableListItems(session: ChromeSession, timeoutMs = 12000): Promise<BaijiahaoArticleItem[]> {
  const started = Date.now();
  let lastArray: BaijiahaoArticleItem[] = [];

  while (Date.now() - started < timeoutMs) {
    const result = await collectListPageItems(session).catch(() => []);
    if (Array.isArray(result)) {
      lastArray = result;
      if (result.length > 0) return result;
    }
    await sleep(500);
  }

  return lastArray;
}

async function collectListPages(session: ChromeSession, options: ManageOptions): Promise<BaijiahaoArticleItem[]> {
  const seen = new Set<string>();
  const collected: BaijiahaoArticleItem[] = [];

  await ensureContentManagePage(session, options.slowMs);

  for (let page = 1; page <= options.maxPages; page += 1) {
    await navigate(session, buildListUrl(options, page), options.slowMs);
    await assertNoRiskChallenge(session);
    let hydrated = await waitForListHydration(session);
    if (!hydrated) {
      await ensureContentManagePage(session, options.slowMs);
      await navigate(session, buildListUrl(options, page), options.slowMs);
      await assertNoRiskChallenge(session);
      hydrated = await waitForListHydration(session);
    }
    if (!hydrated) break;
    const pageItems = await waitForStableListItems(session);
    if (!pageItems.length) break;

    let newCount = 0;
    for (const item of pageItems) {
      const key = item.articleId || item.nid || item.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
      newCount += 1;
    }
    if (newCount === 0) break;
  }

  return collected;
}

async function collectMetricsFromCurrentPage(session: ChromeSession): Promise<ArticleMetrics> {
  const pageText = await evaluate<string>(session, `
    (function() {
      return String(document.body && document.body.innerText || '');
    })()
  `);

  return extractMetricRecordFromText(pageText);
}

async function clickDetailDataInCurrentPage(session: ChromeSession, target: BaijiahaoArticleItem): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      };

      const targetArticleId = ${JSON.stringify(target.articleId)};
      const targetNid = ${JSON.stringify(target.nid)};
      const targetTitle = ${JSON.stringify(target.title)};

      const rows = Array.from(document.querySelectorAll('.client_pages_content_v2_components_articleItem, .article-item, tr, li')).filter(visible);
      const row = rows.find((node) => {
        const anchors = Array.from(node.querySelectorAll('a[href]'));
        const matchedById = anchors.some((anchor) => {
          const href = String(anchor.getAttribute('href') || anchor.href || '');
          return (targetArticleId && href.includes('article_id=' + targetArticleId))
            || (targetNid && href.includes('id=' + targetNid));
        });
        if (matchedById) return true;
        const text = norm(node.textContent);
        return Boolean(targetTitle && text.includes(targetTitle));
      });
      if (!row) return false;

      const exact = row.querySelector('span.article-action-btn[data-urlkey="内容管理-详细数据点击"]');
      if (exact instanceof HTMLElement && visible(exact)) {
        exact.click();
        return true;
      }

      const buttons = Array.from(row.querySelectorAll('button,a,[role="button"],span,div'))
        .filter(visible)
        .filter((node) => /详细数据/.test(norm(node.textContent)))
        .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
      const targetButton = buttons[0];
      if (!targetButton) return false;
      targetButton.click();
      return true;
    })()
  `);
}

async function waitForDetailDrawerMetrics(session: ChromeSession, target: BaijiahaoArticleItem, timeoutMs = 12000): Promise<ArticleMetrics | null> {
  const started = Date.now();
  let lastMetrics: ArticleMetrics | null = null;

  while (Date.now() - started < timeoutMs) {
    const snapshot = await evaluate<{
      open: boolean;
      titleMatched: boolean;
      hasAnalysisTabs: boolean;
      text: string;
    } | null>(session, `
      (function() {
        const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const drawer = document.querySelector('.cheetah-drawer-open .client_pages_content_v2_components_drawerDetail')
          || document.querySelector('.cheetah-drawer-open .client_pages_content_v2_components_drawerDetail_acticleInfo')?.closest('.cheetah-drawer-open')
          || document.querySelector('.cheetah-drawer-open');
        if (!drawer) {
          return {
            open: false,
            titleMatched: false,
            hasAnalysisTabs: false,
            text: '',
          };
        }

        const text = norm(drawer.textContent);
        return {
          open: true,
          titleMatched: text.includes(${JSON.stringify(target.title)}),
          hasAnalysisTabs: text.includes('观看分析') && text.includes('互动分析'),
          text,
        };
      })()
    `);

    if (snapshot?.open) {
      lastMetrics = extractMetricRecordFromText(snapshot.text || '');
      if (snapshot.titleMatched && snapshot.hasAnalysisTabs) {
        return lastMetrics;
      }
    }

    await sleep(500);
  }

  return lastMetrics;
}

async function clickDeleteInCurrentPage(session: ChromeSession, target: BaijiahaoArticleItem): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      };

      const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();
      const targetArticleId = ${JSON.stringify(target.articleId)};
      const targetNid = ${JSON.stringify(target.nid)};
      const targetTitle = ${JSON.stringify(target.title)};

      const rows = Array.from(document.querySelectorAll('.client_pages_content_v2_components_articleItem, .article-item, tr, li')).filter(visible);
      const row = rows.find((node) => {
        const text = textOf(node);
        if (targetTitle && text.includes(targetTitle)) return true;
        const anchors = Array.from(node.querySelectorAll('a[href]'));
        return anchors.some((anchor) => {
          const href = String(anchor.getAttribute('href') || anchor.href || '');
          return (targetArticleId && href.includes('article_id=' + targetArticleId))
            || (targetNid && href.includes('id=' + targetNid));
        });
      });
      if (!row) return false;

      const buttons = Array.from(row.querySelectorAll('button,a,[role="button"],span,div'))
        .filter(visible)
        .filter((node) => textOf(node) === '删除');
      const targetButton = buttons[0];
      if (!targetButton) return false;
      targetButton.click();
      return true;
    })()
  `);
}

async function waitForDeleteConfirmDialog(session: ChromeSession, timeoutMs = 8000): Promise<{ text: string; buttons: string[] } | null> {
  const started = Date.now();
  let lastSnapshot: { text: string; buttons: string[] } | null = null;

  while (Date.now() - started < timeoutMs) {
    const snapshot = await evaluate<{ text: string; buttons: string[] } | null>(session, `
      (function() {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();
        const dialog = Array.from(document.querySelectorAll('[role="dialog"], .cheetah-dialog-box, .cheetah-modal, .ant-modal, .semi-modal, .cheetah-confirm'))
          .filter(visible)[0];
        if (!(dialog instanceof HTMLElement)) return null;
        return {
          text: textOf(dialog),
          buttons: Array.from(dialog.querySelectorAll('button,a,[role="button"],span,div')).map(textOf).filter(Boolean).slice(0, 20),
        };
      })()
    `);

    if (snapshot) {
      lastSnapshot = snapshot;
      if (isDeleteConfirmDialogTextSafe(snapshot.text)) return snapshot;
    }

    await sleep(300);
  }

  return lastSnapshot;
}

async function clickDeleteConfirm(session: ChromeSession): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      };
      const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();

      const dialog = Array.from(document.querySelectorAll('[role="dialog"], .cheetah-dialog-box, .cheetah-modal, .ant-modal, .semi-modal, .cheetah-confirm'))
        .filter(visible)[0];
      if (!(dialog instanceof HTMLElement)) return false;

      const buttons = Array.from(dialog.querySelectorAll('button,a,[role="button"],span,div'))
        .filter(visible);
      const candidate = buttons.find((node) => textOf(node) === '确定')
        || buttons.find((node) => textOf(node) === '确认删除');
      if (!(candidate instanceof HTMLElement)) return false;
      candidate.click();
      return true;
    })()
  `);
}

async function articleStillInCurrentPage(session: ChromeSession, target: BaijiahaoArticleItem): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const articleId = ${JSON.stringify(target.articleId)};
      const nid = ${JSON.stringify(target.nid)};
      const title = ${JSON.stringify(target.title)};
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const foundById = articleId && anchors.some((node) => node.href.includes('article_id=' + articleId));
      const foundByNid = nid && anchors.some((node) => node.href.includes('id=' + nid));
      const foundByTitle = title && anchors.some((node) => String(node.textContent || '').replace(/\\s+/g, ' ').includes(title));
      return Boolean(foundById || foundByNid || foundByTitle);
    })()
  `);
}

async function runList(session: ChromeSession, options: ManageOptions): Promise<void> {
  const items = await collectListPages(session, options);
  const payload = items.map((item) => ({
    title: item.title,
    status: item.status,
    publishedAt: item.publishedAt,
    articleId: item.articleId,
    nid: item.nid,
    url: item.url,
    metrics: collectMetricRecord(item.metricText),
  }));

  console.log(JSON.stringify({
    ok: true,
    command: 'list',
    total: payload.length,
    items: payload,
  }, null, 2));
}

async function runGet(session: ChromeSession, options: ManageOptions): Promise<void> {
  const items = await collectListPages(session, options);
  const target = pickArticle(items, options);
  if (!target) {
    throw new Error('Target article not found in scanned list pages.');
  }

  let metrics = collectMetricRecord(target.metricText);
  await navigate(session, target.pageUrl || buildListUrl(options, 1), options.slowMs);
  await assertNoRiskChallenge(session);

  let hydrated = await waitForListHydration(session);
  if (!hydrated) {
    await ensureContentManagePage(session, options.slowMs);
    await navigate(session, target.pageUrl || buildListUrl(options, 1), options.slowMs);
    await assertNoRiskChallenge(session);
    hydrated = await waitForListHydration(session);
  }

  if (hydrated) {
    const clickedDetail = await clickDetailDataInCurrentPage(session, target);
    if (clickedDetail) {
      await slowDown(options.slowMs);
      const detailMetrics = await waitForDetailDrawerMetrics(session, target);
      if (detailMetrics) {
        metrics = mergeMetrics(metrics, detailMetrics);
      }
    }
  }

  if (isMetricsEmpty(metrics) && target.url) {
    await navigate(session, target.url, options.slowMs);
    await assertNoRiskChallenge(session);
    metrics = mergeMetrics(metrics, await collectMetricsFromCurrentPage(session));
  }

  console.log(JSON.stringify({
    ok: true,
    command: 'get',
    article: {
      title: target.title,
      status: target.status,
      publishedAt: target.publishedAt,
      articleId: target.articleId,
      nid: target.nid,
      url: target.url,
    },
    metrics,
  }, null, 2));
}

async function runDelete(session: ChromeSession, options: ManageOptions): Promise<void> {
  assertDeleteSafety(options);

  const items = await collectListPages(session, options);
  const target = pickArticle(items, options);
  if (!target) {
    throw new Error('Target article not found for delete.');
  }

  await navigate(session, target.pageUrl || buildListUrl(options, 1), options.slowMs);
  await assertNoRiskChallenge(session);

  const clickedDelete = await clickDeleteInCurrentPage(session, target);
  if (!clickedDelete) {
    throw new Error('Delete button not found for target article.');
  }

  await slowDown(options.slowMs);
  const dialog = await waitForDeleteConfirmDialog(session);
  if (!dialog || !isDeleteConfirmDialogTextSafe(dialog.text)) {
    throw new Error(`Unsafe delete dialog state detected; aborting without confirm. Dialog text: ${dialog?.text || '(missing)'}`);
  }
  const clickedConfirm = await clickDeleteConfirm(session);
  if (!clickedConfirm) {
    throw new Error('Delete confirmation button not found.');
  }

  await slowDown(options.slowMs);
  const stillExists = await articleStillInCurrentPage(session, target);
  if (stillExists) {
    throw new Error('Delete verification failed: target article still appears in current page.');
  }

  console.log(JSON.stringify({
    ok: true,
    command: 'delete',
    deleted: {
      title: target.title,
      articleId: target.articleId,
      nid: target.nid,
    },
  }, null, 2));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const options = resolveOptions(argv);
  const runtime = await openRuntime(options);
  let runError: unknown = null;

  try {
    const initialState = await getBaijiahaoPageState(runtime.session);
    if (!isBaijiahaoSessionLoggedIn(initialState)) {
      console.error('[baijiahao-manage] Not logged in. Please complete login in Chrome.');
      await waitForLogin(runtime.session);
    }
    await assertNoRiskChallenge(runtime.session);

    if (options.command === 'list') {
      await runList(runtime.session, options);
      return;
    }
    if (options.command === 'get') {
      await runGet(runtime.session, options);
      return;
    }
    await runDelete(runtime.session, options);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    runtime.cdp.close();
    if (runtime.chrome && !runError) {
      runtime.chrome.kill();
    }
  }
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
