import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  attachSessionToTarget,
  evaluate,
  findExistingChromeDebugPort,
  getDefaultProfileDir,
  getPageSession,
  launchChrome,
  sleep,
  tryConnectExisting,
  type ChromeSession,
  type CdpConnection,
} from './cdp.ts';
import { getToutiaoPageState, isToutiaoSessionLoggedIn } from './toutiao-auth.ts';
import { extractMetricsFromText, parseManageArgs, validateDeleteArgs } from './toutiao-manage-parse.ts';
import type { ListArticleItem, ListPageSnapshot, ManageOptions } from './toutiao-manage-types.ts';

const TOUTIAO_HOME = 'https://mp.toutiao.com/';
const DEFAULT_LIST_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';

interface ExtendConfig {
  chrome_profile_path?: string;
  content_manage_url?: string;
  default_slow_ms?: string;
}

function loadExtendFile(filePath: string): ExtendConfig {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    parsed[key] = value;
  }

  return {
    chrome_profile_path: parsed.chrome_profile_path,
    content_manage_url: parsed.content_manage_url,
    default_slow_ms: parsed.default_slow_ms,
  };
}

function loadExtendConfig(): ExtendConfig {
  const project = path.join(process.cwd(), '.thy1cc-skills', 'thy1cc-post-to-toutiaohao', 'EXTEND.md');
  const user = path.join(os.homedir(), '.thy1cc-skills', 'thy1cc-post-to-toutiaohao', 'EXTEND.md');
  return {
    ...loadExtendFile(user),
    ...loadExtendFile(project),
  };
}

function applyConfigDefaults(options: ManageOptions, config: ExtendConfig): ManageOptions {
  const fromConfigSlow = config.default_slow_ms ? Number.parseInt(config.default_slow_ms, 10) : undefined;
  const slowMs = Number.isFinite(fromConfigSlow) && (fromConfigSlow || 0) > 0
    ? (fromConfigSlow as number)
    : options.slowMs;

  return {
    ...options,
    profileDir: options.profileDir || config.chrome_profile_path,
    listUrl: options.listUrl || config.content_manage_url || DEFAULT_LIST_URL,
    slowMs,
  };
}

function printHelp(): void {
  console.log(`Toutiao Hao Browser Manager

Usage:
  node --experimental-strip-types toutiao-manage.ts <command> [options]

Commands:
  list      List content from content-management pages
  get       Read metrics for one article
  delete    Delete one article from content-management page

Common options:
  --id <value>          Target article id
  --title <value>       Target article title (fallback when id unavailable)
  --max-pages <n>       Max pages to scan in list mode (default: 1, hard limit: 10)
  --page-size-hint <n>  Heuristic row cap per page (default: 20)
  --list-url <url>      Override content-management URL
  --cdp-port <port>     Reuse existing Chrome debug port
  --profile-dir <dir>   Chrome user-data-dir for launched browser
  --slow-ms <ms>        Delay between browser actions (default: 2200)
  --json                Output JSON (default)
  --text                Output text summary
  --help                Show this help

Delete safety:
  delete requires --confirm and --id or --title.
  example:
    node --experimental-strip-types toutiao-manage.ts delete --id 12345 --confirm
`);
}

async function waitForLogin(session: ChromeSession, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getToutiaoPageState(session);
    if (isToutiaoSessionLoggedIn(state)) return;
    await sleep(2_000);
  }
  throw new Error('Login timeout. Please open the creator dashboard and log in first.');
}

async function ensureToutiaoSession(cdp: CdpConnection): Promise<ChromeSession> {
  try {
    return await getPageSession(cdp, 'mp.toutiao.com');
  } catch {
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: TOUTIAO_HOME });
    await sleep(4_000);
    return await attachSessionToTarget(cdp, created.targetId);
  }
}

async function navigateTo(session: ChromeSession, url: string, slowMs: number): Promise<void> {
  await evaluate(session, `window.location.href = ${JSON.stringify(url)}; true`);
  await sleep(Math.max(1500, slowMs));
}

function parsePublishedAt(text: string): string {
  const matched = text.match(/\d{4}[./-]\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
  return matched ? matched[0] : '';
}

function parseStatus(text: string): string {
  const markers = ['已发布', '审核中', '未通过', '草稿', '待发布', '已删除', '已下架'];
  for (const marker of markers) {
    if (text.includes(marker)) return marker;
  }
  return '';
}

function dedupeItems(items: ListArticleItem[]): ListArticleItem[] {
  const seen = new Set<string>();
  const result: ListArticleItem[] = [];
  for (const item of items) {
    const key = `${item.id}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function scanCurrentListPage(session: ChromeSession, page: number, pageSizeHint: number): Promise<ListPageSnapshot> {
  const raw = await evaluate<any>(session, `
    (() => {
      const selectorGroups = [
        'table tbody tr',
        '[class*="article-list"] [class*="item"]',
        '[class*="content-list"] [class*="item"]',
        '.list-item',
        '[data-row-key]',
      ];

      const candidates = [];
      const seen = new Set();
      for (const selector of selectorGroups) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (!(node instanceof HTMLElement)) continue;
          const text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (!text || text.length < 4) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 20) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          candidates.push(node);
        }
      }

      const rows = candidates.slice(0, ${Math.max(5, pageSizeHint * 3)}).map((node) => {
        const rowText = (node.innerText || '').replace(/\\s+/g, ' ').trim();
        const links = Array.from(node.querySelectorAll('a'))
          .map((a) => ({
            text: (a.textContent || '').trim(),
            href: a.href || '',
          }))
          .filter((entry) => entry.href || entry.text);

        const primaryTitle = links
          .map((entry) => entry.text)
          .filter((text) => text.length >= 2)
          .sort((a, b) => b.length - a.length)[0] || rowText.slice(0, 60);

        const preferredLink = links.find((entry) => /article|item|group|content|detail|edit/i.test(entry.href))
          || links[0]
          || { href: '', text: '' };

        const fromHref = preferredLink.href.match(/(?:item_id|group_id|article_id|id)=([0-9A-Za-z_-]+)/);
        const fromText = rowText.match(/\\b([0-9]{8,})\\b/);

        return {
          id: fromHref ? fromHref[1] : (fromText ? fromText[1] : ''),
          title: primaryTitle,
          rowText,
          url: preferredLink.href || '',
        };
      });

      return {
        pageUrl: window.location.href,
        pageTitle: document.title || '',
        rows,
      };
    })()
  `);

  const items: ListArticleItem[] = (Array.isArray(raw?.rows) ? raw.rows : []).map((entry: any) => {
    const rowText = String(entry?.rowText || '');
    return {
      id: String(entry?.id || ''),
      title: String(entry?.title || ''),
      status: parseStatus(rowText),
      publishedAt: parsePublishedAt(rowText),
      url: String(entry?.url || ''),
      rowText,
    };
  }).filter((entry) => entry.title);

  return {
    page,
    pageUrl: String(raw?.pageUrl || ''),
    pageTitle: String(raw?.pageTitle || ''),
    items: dedupeItems(items),
  };
}

async function tryGoNextPage(session: ChromeSession): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (() => {
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], li'))
        .filter((node) => node instanceof HTMLElement);

      const findByText = (texts) => {
        for (const node of buttons) {
          const text = (node.innerText || node.textContent || '').replace(/\\s+/g, '');
          if (!text) continue;
          if (!texts.some((keyword) => text.includes(keyword))) continue;
          const ariaDisabled = node.getAttribute('aria-disabled');
          if (ariaDisabled === 'true') continue;
          if (node.className && /disabled|is-disabled/.test(String(node.className))) continue;
          node.scrollIntoView({ block: 'center' });
          node.click();
          return true;
        }
        return false;
      };

      if (findByText(['下一页', '下页'])) return true;
      return findByText(['>', '›']);
    })()
  `);
}

async function listArticles(session: ChromeSession, options: ManageOptions): Promise<ListPageSnapshot[]> {
  const listUrl = options.listUrl || DEFAULT_LIST_URL;
  await navigateTo(session, listUrl, options.slowMs);

  const pages: ListPageSnapshot[] = [];
  for (let page = 1; page <= options.maxPages; page += 1) {
    const snapshot = await scanCurrentListPage(session, page, options.pageSizeHint);
    pages.push(snapshot);
    if (page >= options.maxPages) break;

    const moved = await tryGoNextPage(session);
    if (!moved) break;
    await sleep(options.slowMs);
  }
  return pages;
}

function findTargetItem(items: ListArticleItem[], options: ManageOptions): ListArticleItem | null {
  if (options.id) {
    const exact = items.find((item) => item.id === options.id);
    if (exact) return exact;
  }
  if (options.title) {
    const matched = items.find((item) => item.title.includes(options.title || ''));
    if (matched) return matched;
  }
  return null;
}

async function getMetricsForItem(cdp: CdpConnection, item: ListArticleItem, options: ManageOptions): Promise<any> {
  if (!item.url) {
    const metrics = extractMetricsFromText(item.rowText || '');
    return {
      article: item,
      metrics,
      source: 'list-row',
    };
  }

  const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: item.url });
  const detailSession = await attachSessionToTarget(cdp, created.targetId);
  try {
    await sleep(Math.max(1800, options.slowMs));
    const detail = await evaluate<{ url: string; title: string; bodyText: string }>(detailSession, `
      (() => ({
        url: window.location.href,
        title: document.title || '',
        bodyText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim(),
      }))()
    `);

    return {
      article: item,
      detailUrl: detail.url,
      detailTitle: detail.title,
      metrics: extractMetricsFromText(detail.bodyText || ''),
      source: 'detail-page',
    };
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  }
}

async function deleteItemFromCurrentList(session: ChromeSession, target: ListArticleItem): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (() => {
      const targetId = ${JSON.stringify(target.id)};
      const targetTitle = ${JSON.stringify(target.title)};

      const rowSelectors = ['table tbody tr', '[class*="article-list"] [class*="item"]', '.list-item', '[data-row-key]'];
      const rows = [];
      for (const selector of rowSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (node instanceof HTMLElement) rows.push(node);
        }
      }

      const targetRow = rows.find((row) => {
        const text = (row.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!text) return false;
        if (targetId && text.includes(targetId)) return true;
        if (targetTitle && text.includes(targetTitle)) return true;
        return false;
      });
      if (!targetRow) return false;

      const actionNodes = Array.from(targetRow.querySelectorAll('button, a, [role="button"], span'))
        .filter((node) => node instanceof HTMLElement);
      const deleteNode = actionNodes.find((node) => {
        const text = (node.innerText || node.textContent || '').replace(/\\s+/g, '');
        if (!text) return false;
        if (!text.includes('删除')) return false;
        if (text.includes('批量')) return false;
        return true;
      });
      if (!(deleteNode instanceof HTMLElement)) return false;

      deleteNode.click();

      const confirmTexts = ['确认删除', '确定', '删除'];
      const modalNodes = Array.from(document.querySelectorAll('button, a, [role="button"], span'))
        .filter((node) => node instanceof HTMLElement);
      const confirm = modalNodes.find((node) => {
        const text = (node.innerText || node.textContent || '').replace(/\\s+/g, '');
        return confirmTexts.some((keyword) => text === keyword || text.includes(keyword));
      });
      if (!(confirm instanceof HTMLElement)) return false;
      confirm.click();
      return true;
    })()
  `);
}

function formatTextSummary(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.command === 'list') {
    const total = Array.isArray(payload.items) ? payload.items.length : 0;
    return `list done: ${total} items`;
  }
  if (payload.command === 'get') {
    return `get done: ${payload.article?.title || payload.article?.id || ''}`;
  }
  if (payload.command === 'delete') {
    return `delete done: ${payload.deleted ? 'success' : 'failed'}`;
  }
  return '';
}

async function main(): Promise<void> {
  const parsed = parseManageArgs(process.argv.slice(2));
  const options = applyConfigDefaults(parsed, loadExtendConfig());
  if (options.help) {
    printHelp();
    return;
  }
  validateDeleteArgs(options);

  const portToTry = options.cdpPort ?? await findExistingChromeDebugPort();

  let cdp: CdpConnection;
  let chrome: ReturnType<typeof import('node:child_process').spawn> | null = null;
  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) cdp = existing;
    else {
      const launched = await launchChrome(TOUTIAO_HOME, options.profileDir || getDefaultProfileDir());
      cdp = launched.cdp;
      chrome = launched.chrome;
    }
  } else {
    const launched = await launchChrome(TOUTIAO_HOME, options.profileDir || getDefaultProfileDir());
    cdp = launched.cdp;
    chrome = launched.chrome;
  }

  try {
    let session = await ensureToutiaoSession(cdp);
    const state = await getToutiaoPageState(session);
    if (!isToutiaoSessionLoggedIn(state)) {
      console.error('[toutiao] Login required. Please log in through the open browser window.');
      await waitForLogin(session);
      session = await ensureToutiaoSession(cdp);
    }

    if (options.command === 'list') {
      const pages = await listArticles(session, options);
      const items = dedupeItems(pages.flatMap((page) => page.items));
      const payload = {
        command: 'list',
        listUrl: options.listUrl || DEFAULT_LIST_URL,
        scannedPages: pages.length,
        items,
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else console.log(formatTextSummary(payload));
      return;
    }

    const pages = await listArticles(session, { ...options, maxPages: Math.max(1, options.maxPages) });
    const items = dedupeItems(pages.flatMap((page) => page.items));
    const target = findTargetItem(items, options);
    if (!target) {
      throw new Error('Target article not found in scanned list pages. Increase --max-pages or refine --id/--title.');
    }

    if (options.command === 'get') {
      const details = await getMetricsForItem(cdp, target, options);
      const payload = {
        command: 'get',
        ...details,
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else console.log(formatTextSummary(payload));
      return;
    }

    const clicked = await deleteItemFromCurrentList(session, target);
    if (!clicked) {
      throw new Error('Could not click delete and confirm actions from the current page.');
    }

    await sleep(Math.max(1500, options.slowMs));
    const verifyPage = await scanCurrentListPage(session, 1, options.pageSizeHint);
    const stillThere = findTargetItem(verifyPage.items, options);
    const payload = {
      command: 'delete',
      article: target,
      deleted: !stillThere,
      verifyPageUrl: verifyPage.pageUrl,
    };
    if (!payload.deleted) {
      throw new Error('Delete verification failed: target still visible on the refreshed list page.');
    }

    if (options.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(formatTextSummary(payload));
  } finally {
    cdp.close();
    if (chrome) chrome.kill();
  }
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
