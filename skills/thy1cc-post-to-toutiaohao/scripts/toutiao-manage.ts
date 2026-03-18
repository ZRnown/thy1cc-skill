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
import { extractMetricsFromText, isDeleteConfirmDialogTextSafe, parseManageArgs, validateDeleteArgs } from './toutiao-manage-parse.ts';
import type { ListArticleItem, ListPageSnapshot, ManageOptions } from './toutiao-manage-types.ts';

const TOUTIAO_HOME = 'https://mp.toutiao.com/';
const DEFAULT_LIST_URL = 'https://mp.toutiao.com/profile_v4/manage/content/all';

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
  --dry-run-delete      Probe delete modal and safety check only, never click final confirm
  --help                Show this help

Delete safety:
  delete requires exactly one of --confirm or --dry-run-delete, plus --id or --title.
  example:
    node --experimental-strip-types toutiao-manage.ts delete --id 12345 --confirm
    node --experimental-strip-types toutiao-manage.ts delete --id 12345 --dry-run-delete
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
        '.genre-item.genre-item-in-all-tab',
        '.article-card',
        '.xigua-m-article-card-item',
        '.post-item',
        'table tbody tr',
        '.list-item',
        '[data-row-key]',
      ];

      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const splitLines = (value) => String(value || '')
        .split(/\\n+/)
        .map((line) => normalize(line))
        .filter(Boolean);
      const ignoredLinePatterns = [
        /^\\d{4}[./-]\\d{1,2}[./-]\\d{1,2}/,
        /^查看数据$/,
        /^查看评论$/,
        /^修改$/,
        /^更多$/,
        /^展现\\s*\\d+/,
        /^阅读\\s*\\d+/,
        /^播放\\s*\\d+/,
        /^点赞\\s*\\d+/,
        /^评论\\s*\\d+/,
        /^已发布$/,
        /^审核中$/,
        /^未通过$/,
        /^待发布$/,
        /^已删除$/,
        /^已下架$/,
        /^由文章生成$/,
        /^首发$/,
        /^已推送$/,
        /^[+＋]\\d+$/,
      ];
      const pickTitleFromLines = (lines) => {
        for (const line of lines) {
          if (line.length < 2) continue;
          if (ignoredLinePatterns.some((pattern) => pattern.test(line))) continue;
          return line;
        }
        return '';
      };
      const parseIdFromHref = (href) => {
        const queryMatch = String(href || '').match(/(?:item_id|group_id|article_id|id)=([0-9A-Za-z_-]+)/);
        if (queryMatch) return queryMatch[1] || '';
        const pathMatch = String(href || '').match(/\\/(?:item|video|i)\\/?([0-9A-Za-z_-]{8,})\\/?/i);
        if (pathMatch) return pathMatch[1] || '';
        return '';
      };

      const candidates = [];
      const seen = new Set();
      for (const selector of selectorGroups) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (!(node instanceof HTMLElement)) continue;
          const text = normalize(node.innerText || '');
          if (!text || text.length < 4) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 20) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          candidates.push(node);
        }
      }

      const rows = candidates.slice(0, ${Math.max(5, pageSizeHint * 3)}).map((node) => {
        const rowText = normalize(node.innerText || '');
        const rowLines = splitLines(node.innerText || '');
        const links = Array.from(node.querySelectorAll('a'))
          .map((a) => ({
            text: normalize(a.textContent || ''),
            href: a.href || '',
          }))
          .filter((entry) => entry.href || entry.text);

        const exactTitleCandidates = Array.from(node.querySelectorAll('a.title, .title'))
          .map((entry) => normalize(entry.textContent || ''))
          .filter((text) => text.length >= 2);
        const broadTitleCandidates = Array.from(node.querySelectorAll('[class*="title"], h1, h2, h3, h4'))
          .map((entry) => normalize(entry.textContent || ''))
          .filter((text) => text.length >= 2)
          .sort((a, b) => b.length - a.length);
        const linkTitles = links
          .map((entry) => entry.text)
          .filter((text) => text.length >= 2)
          .sort((a, b) => b.length - a.length);
        const primaryTitle = exactTitleCandidates[0]
          || linkTitles[0]
          || broadTitleCandidates[0]
          || pickTitleFromLines(rowLines)
          || rowText.slice(0, 60);

        const preferredLink = links.find((entry) => /toutiao\\.com\\/(?:item|video)\\//i.test(entry.href))
          || links[0]
          || { href: '', text: '' };

        const fromHref = parseIdFromHref(preferredLink.href);
        const fromText = rowText.match(/\\b([0-9]{8,})\\b/);

        return {
          id: fromHref || (fromText ? fromText[1] : ''),
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

async function waitForListHydration(session: ChromeSession, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await evaluate<{
      url: string;
      itemCount: number;
      totalCount: number | null;
      hasEmptyLabel: boolean;
      hasManageLabel: boolean;
    }>(session, `
      (() => {
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const totalCountMatch = text.match(/共\\s*(\\d+)\\s*条内容/);
        return {
          url: window.location.href,
          itemCount: document.querySelectorAll('.genre-item.genre-item-in-all-tab').length,
          totalCount: totalCountMatch ? Number.parseInt(totalCountMatch[1] || '', 10) : null,
          hasEmptyLabel: text.includes('暂无数据'),
          hasManageLabel: text.includes('作品管理') && text.includes('草稿箱'),
        };
      })()
    `);

    if (
      snapshot.url.includes('/profile_v4/manage/content/')
      && snapshot.hasManageLabel
      && (
        snapshot.hasEmptyLabel
        || snapshot.totalCount === 0
        || (typeof snapshot.totalCount === 'number' && snapshot.totalCount > 0 && snapshot.itemCount >= snapshot.totalCount)
      )
    ) {
      return;
    }

    await sleep(500);
  }
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
  await waitForListHydration(session, Math.max(12000, options.slowMs * 4));

  const pages: ListPageSnapshot[] = [];
  for (let page = 1; page <= options.maxPages; page += 1) {
    const snapshot = await scanCurrentListPage(session, page, options.pageSizeHint);
    pages.push(snapshot);
    if (page >= options.maxPages) break;

    const moved = await tryGoNextPage(session);
    if (!moved) break;
    await sleep(options.slowMs);
    await waitForListHydration(session, Math.max(12000, options.slowMs * 4));
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
  const rowMetrics = extractMetricsFromText(item.rowText || '');
  if (!item.url) {
    return {
      article: item,
      metrics: rowMetrics,
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
    const detailMetrics = extractMetricsFromText(detail.bodyText || '');

    return {
      article: item,
      detailUrl: detail.url,
      detailTitle: detail.title,
      metrics: {
        reads: rowMetrics.reads ?? detailMetrics.reads ?? 0,
        likes: rowMetrics.likes ?? detailMetrics.likes ?? 0,
        collects: rowMetrics.collects ?? detailMetrics.collects ?? 0,
        shares: rowMetrics.shares ?? detailMetrics.shares ?? 0,
        comments: rowMetrics.comments ?? detailMetrics.comments ?? 0,
      },
      source: 'list-row+detail-page',
    };
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  }
}

async function dismissGuidePopovers(session: ChromeSession): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dismissed = await evaluate<boolean>(session, `
      (() => {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();
        const target = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'))
          .filter(visible)
          .find((node) => textOf(node) === '我知道了');
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()
    `);
    if (!dismissed) break;
    await sleep(400);
  }
}

async function clickDeleteItemFromCurrentList(session: ChromeSession, target: ListArticleItem): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (() => {
      const targetId = ${JSON.stringify(target.id)};
      const targetTitle = ${JSON.stringify(target.title)};
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();

      const rowSelectors = ['.genre-item.genre-item-in-all-tab', '.article-card', '.xigua-m-article-card-item', '.post-item', 'table tbody tr', '.list-item', '[data-row-key]'];
      const rows = [];
      for (const selector of rowSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (visible(node)) rows.push(node);
        }
      }

      const targetRow = rows.find((row) => {
        const text = textOf(row);
        if (!text) return false;
        if (targetId && text.includes(targetId)) return true;
        if (targetTitle && text.includes(targetTitle)) return true;
        return false;
      });
      if (!targetRow) return false;

      const moreNode = Array.from(targetRow.querySelectorAll('button, a, [role="button"], span, div'))
        .filter(visible)
        .find((node) => textOf(node) === '更多');
      if (!(moreNode instanceof HTMLElement)) return false;

      moreNode.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      moreNode.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      moreNode.click();
      return true;
    })()
  `);
}

async function clickDeleteItemInVisibleMenu(session: ChromeSession): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (() => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();
      const target = Array.from(document.querySelectorAll('li, button, a, [role="button"], span, div'))
        .filter(visible)
        .find((node) => textOf(node) === '删除作品' || textOf(node) === '删除');
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()
  `);
}

async function waitForDeleteConfirmDialog(session: ChromeSession, timeoutMs = 8000): Promise<{ text: string; buttons: string[] } | null> {
  const started = Date.now();
  let lastSnapshot: { text: string; buttons: string[] } | null = null;

  while (Date.now() - started < timeoutMs) {
    const snapshot = await evaluate<{ text: string; buttons: string[] } | null>(session, `
      (() => {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();
        const dialog = Array.from(document.querySelectorAll('[role="dialog"], .semi-modal, .semi-portal .semi-modal, .byte-modal'))
          .filter(visible)[0];
        if (!(dialog instanceof HTMLElement)) return null;
        return {
          text: textOf(dialog),
          buttons: Array.from(dialog.querySelectorAll('button, a, [role="button"], span, div')).map(textOf).filter(Boolean).slice(0, 20),
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
    (() => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textOf = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim();
      const dialog = Array.from(document.querySelectorAll('[role="dialog"], .semi-modal, .semi-portal .semi-modal, .byte-modal'))
        .filter(visible)[0];
      if (!(dialog instanceof HTMLElement)) return false;
      const candidate = Array.from(dialog.querySelectorAll('button, a, [role="button"], span, div'))
        .filter(visible)
        .find((node) => textOf(node) === '确定');
      if (!(candidate instanceof HTMLElement)) return false;
      candidate.click();
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
    if (payload.mode === 'dry-run-delete') return `delete dry-run done: ${payload.article?.title || payload.article?.id || ''}`;
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

    await dismissGuidePopovers(session);
    const clickedEntry = await clickDeleteItemFromCurrentList(session, target);
    if (!clickedEntry) {
      throw new Error('Could not open the row actions for delete from the current page.');
    }
    await sleep(Math.max(800, Math.floor(options.slowMs * 0.6)));

    const clickedDelete = await clickDeleteItemInVisibleMenu(session);
    if (!clickedDelete) {
      throw new Error('Delete menu item did not appear after clicking 更多; aborting without confirm.');
    }
    await sleep(Math.max(800, Math.floor(options.slowMs * 0.6)));

    const dialog = await waitForDeleteConfirmDialog(session);
    if (!dialog || !isDeleteConfirmDialogTextSafe(dialog.text)) {
      throw new Error(`Unsafe delete dialog state detected; aborting without confirm. Dialog text: ${dialog?.text || '(missing)'}`);
    }

    if (options.dryRunDelete) {
      const payload = {
        command: 'delete',
        mode: 'dry-run-delete',
        article: target,
        safetyCheck: {
          passed: true,
          dialogText: dialog.text,
          dialogButtons: dialog.buttons,
        },
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else console.log(formatTextSummary(payload));
      return;
    }

    const clickedConfirm = await clickDeleteConfirm(session);
    if (!clickedConfirm) {
      throw new Error('Delete confirmation button not found inside the visible dialog.');
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
