import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { evaluate, findExistingChromeDebugPort, getDefaultProfileDir, getPageSession, launchChrome, sleep, tryConnectExisting, type CdpConnection, type ChromeSession } from './cdp.ts';
import { getNeteasehaoPageState, isNeteasehaoSessionLoggedIn } from './neteasehao-auth.ts';
import { extractMetricsFromText, parseManageCommand } from './neteasehao-manage-parse.ts';
import type { ManageCommandOptions, NeteasehaoArticleSummary } from './neteasehao-manage-types.ts';

const NETEASEHAO_HOME = 'https://mp.163.com/';
const DEFAULT_CONTENT_MANAGE_URL = 'https://mp.163.com/article/manage';

interface ExtendConfig {
  chrome_profile_path?: string;
  content_manage_url?: string;
  default_max_pages?: string;
  slow_mode_ms?: string;
}

interface RuntimeOptions {
  command: ManageCommandOptions;
  profileDir: string;
  contentManageUrl: string;
  maxPages: number;
  slowMs: number;
}

function printHelp(): void {
  console.log(`Usage:
  node --experimental-strip-types neteasehao-manage.ts list [--max-pages 3] [--slow-ms 1200]
  node --experimental-strip-types neteasehao-manage.ts get --article-id <id> [--slow-ms 1200]
  node --experimental-strip-types neteasehao-manage.ts delete --article-id <id> --confirm

Commands:
  list                List article summaries from content-management pages
  get                 Read engagement metrics (read/like/favorite/share/comment)
  delete              Delete one article with explicit --confirm

Common options:
  --cdp-port <port>   Reuse an existing Chrome debug port
  --profile-dir <dir> Override Chrome profile directory
  --max-pages <n>     Max pages to scan for list/get/delete
  --slow-ms <ms>      Delay between actions in milliseconds

get options:
  --article-id <id>   Target article id
  --title <text>      Target title keyword
  --url <url>         Direct article data/detail url

delete options:
  --article-id <id>   Target article id
  --title <text>      Target title keyword
  --confirm           Required for deletion
`);
}

function parseExtendFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const parsed: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    parsed[trimmed.slice(0, idx).trim().toLowerCase()] = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return parsed;
}

function loadExtendConfig(): ExtendConfig {
  const projectPath = path.join(process.cwd(), '.thy1cc-skills', 'thy1cc-post-to-neteasehao', 'EXTEND.md');
  const userPath = path.join(os.homedir(), '.thy1cc-skills', 'thy1cc-post-to-neteasehao', 'EXTEND.md');
  return {
    ...parseExtendFile(userPath),
    ...parseExtendFile(projectPath),
  };
}

function resolveRuntimeOptions(argv: string[]): RuntimeOptions {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const command = parseManageCommand(argv);
  const config = loadExtendConfig();

  const cfgMaxPages = Number.parseInt(config.default_max_pages || '', 10);
  const cfgSlowMs = Number.parseInt(config.slow_mode_ms || '', 10);

  return {
    command: {
      ...command,
      maxPages: Number.isFinite(cfgMaxPages) ? Math.max(command.maxPages, cfgMaxPages) : command.maxPages,
      slowMs: Number.isFinite(cfgSlowMs) ? Math.max(command.slowMs, cfgSlowMs) : command.slowMs,
    } as ManageCommandOptions,
    profileDir: command.profileDir || config.chrome_profile_path || getDefaultProfileDir(),
    contentManageUrl: config.content_manage_url || DEFAULT_CONTENT_MANAGE_URL,
    maxPages: command.maxPages,
    slowMs: command.slowMs,
  };
}

async function attachSessionToTarget(cdp: CdpConnection, targetId: string): Promise<ChromeSession> {
  const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, { sessionId: attached.sessionId });
  await cdp.send('Runtime.enable', {}, { sessionId: attached.sessionId });
  await cdp.send('DOM.enable', {}, { sessionId: attached.sessionId });
  return { cdp, sessionId: attached.sessionId, targetId };
}

async function ensureNoRiskPrompt(session: ChromeSession): Promise<void> {
  const flagged = await evaluate<boolean>(session, `
    (function() {
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      return /验证码|安全验证|账号异常|风险提示|频繁操作/.test(text);
    })()
  `);
  if (flagged) throw new Error('Risk-control prompt detected. Stop automation and check in browser manually.');
}

async function navigateTo(session: ChromeSession, url: string, slowMs: number): Promise<void> {
  await evaluate(session, `window.location.href = ${JSON.stringify(url)};`);
  await sleep(Math.max(1200, slowMs));
}

async function waitForLogin(session: ChromeSession, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await getNeteasehaoPageState(session);
    if (isNeteasehaoSessionLoggedIn(state)) return;
    await sleep(2000);
  }
  throw new Error('Login timeout: please login to Netease Hao in the opened Chrome profile.');
}

async function extractCurrentPageRows(session: ChromeSession): Promise<NeteasehaoArticleSummary[]> {
  return await evaluate<NeteasehaoArticleSummary[]>(session, `
    (function() {
      const toText = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const datePattern = /(20\\d{2}[-\\/.]\\d{1,2}[-\\/.]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2})?)/;

      const rows = Array.from(document.querySelectorAll('table tbody tr, .article-item, .content-item, .manage-list-item, [data-article-id], [data-id]'));
      const result = [];

      for (const row of rows) {
        const rowText = toText(row.innerText || '');
        if (!rowText || rowText.length < 4) continue;

        const anchors = Array.from(row.querySelectorAll('a[href]'));
        const titleNode = row.querySelector('h3, h4, .title, .article-title, [title]') || anchors[0] || row;
        const title = toText(titleNode.getAttribute?.('title') || titleNode.textContent || '');

        const link = anchors
          .map((a) => a.href)
          .find((href) => href && /^https?:/i.test(href))
          || '';

        const idCandidates = [
          row.getAttribute('data-article-id'),
          row.getAttribute('data-id'),
          row.getAttribute('article-id'),
          row.getAttribute('data-docid'),
        ].filter(Boolean);

        let articleId = toText(idCandidates[0] || '');
        if (!articleId && link) {
          try {
            const u = new URL(link);
            articleId = toText(
              u.searchParams.get('id')
              || u.searchParams.get('articleId')
              || u.searchParams.get('docid')
              || ''
            );
          } catch {}
        }

        const statusNode = row.querySelector('.status, .state, .tag, .label-status');
        const status = toText(statusNode?.textContent || '');
        const updatedAt = (rowText.match(datePattern) || [])[0] || '';

        result.push({
          articleId,
          title,
          status,
          updatedAt,
          url: link,
          rawText: rowText,
        });
      }

      return result;
    })()
  `);
}

async function clickNextPage(session: ChromeSession): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const candidate = controls.find((el) => /下一页|下页/.test((el.textContent || '').trim()));
      if (!candidate) return false;
      const disabled = candidate.getAttribute('disabled') !== null
        || candidate.getAttribute('aria-disabled') === 'true'
        || /disabled/.test(candidate.className || '');
      if (disabled) return false;
      candidate.scrollIntoView({ block: 'center' });
      candidate.click();
      return true;
    })()
  `);
}

function dedupeRows(rows: NeteasehaoArticleSummary[]): NeteasehaoArticleSummary[] {
  const seen = new Set<string>();
  const deduped: NeteasehaoArticleSummary[] = [];
  for (const row of rows) {
    const key = `${row.articleId}|${row.title}|${row.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function matchRow(row: NeteasehaoArticleSummary, command: { articleId?: string; title?: string }): boolean {
  if (command.articleId && row.articleId) {
    if (row.articleId === command.articleId) return true;
  }
  if (command.title && row.title) {
    if (row.title.includes(command.title)) return true;
  }
  if (command.articleId && row.rawText.includes(command.articleId)) return true;
  return false;
}

async function collectRows(session: ChromeSession, maxPages: number, slowMs: number): Promise<NeteasehaoArticleSummary[]> {
  const collected: NeteasehaoArticleSummary[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    await ensureNoRiskPrompt(session);
    await sleep(slowMs);
    const pageRows = await extractCurrentPageRows(session);
    collected.push(...pageRows);
    if (page === maxPages - 1) break;
    const moved = await clickNextPage(session);
    if (!moved) break;
    await sleep(slowMs);
  }
  return dedupeRows(collected);
}

async function findTargetRow(session: ChromeSession, command: { articleId?: string; title?: string }, maxPages: number, slowMs: number): Promise<NeteasehaoArticleSummary | null> {
  const rows = await collectRows(session, maxPages, slowMs);
  return rows.find((row) => matchRow(row, command)) || null;
}

async function collectGetSnapshot(session: ChromeSession): Promise<{ url: string; title: string; bodyText: string; statText: string }> {
  return await evaluate(session, `
    (function() {
      const statNodes = Array.from(document.querySelectorAll('.data, .stat, .metric, .overview-card, .chart-card, .info-item, .panel, .summary-item'));
      const statText = statNodes.map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' ');
      return {
        url: location.href,
        title: document.title || '',
        bodyText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim(),
        statText,
      };
    })()
  `);
}

async function clickDeleteAction(session: ChromeSession, target: { articleId?: string; title?: string }): Promise<boolean> {
  const payload = JSON.stringify(target);
  return await evaluate<boolean>(session, `
    (function() {
      const target = ${payload};
      const rows = Array.from(document.querySelectorAll('table tbody tr, .article-item, .content-item, .manage-list-item, [data-article-id], [data-id]'));
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();

      for (const row of rows) {
        const rowText = normalize(row.innerText || '');
        const articleId = normalize(
          row.getAttribute('data-article-id')
          || row.getAttribute('data-id')
          || row.getAttribute('article-id')
          || ''
        );
        const titleNode = row.querySelector('h3, h4, .title, .article-title, [title]');
        const title = normalize(titleNode?.getAttribute?.('title') || titleNode?.textContent || '');

        const matched = (target.articleId && (articleId === target.articleId || rowText.includes(target.articleId)))
          || (target.title && title.includes(target.title));
        if (!matched) continue;

        const deleteBtn = Array.from(row.querySelectorAll('button, a, [role="button"]'))
          .find((el) => /删除|移入回收站|下线/.test(normalize(el.textContent || '')));
        if (!deleteBtn) return false;

        deleteBtn.scrollIntoView({ block: 'center' });
        deleteBtn.click();
        return true;
      }

      return false;
    })()
  `);
}

async function clickDeleteConfirm(session: ChromeSession): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const confirmBtn = controls.find((el) => /确认删除|确定删除|确认|删除/.test((el.textContent || '').replace(/\\s+/g, ' ').trim()));
      if (!confirmBtn) return false;
      const disabled = confirmBtn.getAttribute('disabled') !== null || confirmBtn.getAttribute('aria-disabled') === 'true';
      if (disabled) return false;
      confirmBtn.scrollIntoView({ block: 'center' });
      confirmBtn.click();
      return true;
    })()
  `);
}

async function verifyDeleted(session: ChromeSession, target: { articleId?: string; title?: string }): Promise<boolean> {
  const payload = JSON.stringify(target);
  return await evaluate<boolean>(session, `
    (function() {
      const target = ${payload};
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      const hasId = target.articleId ? text.includes(target.articleId) : false;
      const hasTitle = target.title ? text.includes(target.title) : false;
      return !(hasId || hasTitle);
    })()
  `);
}

async function runList(session: ChromeSession, opts: RuntimeOptions): Promise<void> {
  await navigateTo(session, opts.contentManageUrl, opts.slowMs);
  const rows = await collectRows(session, opts.maxPages, opts.slowMs);
  console.log(JSON.stringify({
    mode: 'list',
    total: rows.length,
    articles: rows,
  }, null, 2));
}

async function runGet(session: ChromeSession, opts: RuntimeOptions): Promise<void> {
  const cmd = opts.command;
  if (cmd.mode !== 'get') throw new Error('Invalid mode for get');

  await navigateTo(session, opts.contentManageUrl, opts.slowMs);

  let targetRow: NeteasehaoArticleSummary | null = null;
  if (cmd.url) {
    await navigateTo(session, cmd.url, opts.slowMs);
  } else {
    targetRow = await findTargetRow(session, cmd, opts.maxPages, opts.slowMs);
    if (!targetRow) throw new Error('Target article not found on scanned management pages.');
    if (targetRow.url) {
      await navigateTo(session, targetRow.url, opts.slowMs);
    }
  }

  await ensureNoRiskPrompt(session);
  await sleep(opts.slowMs);

  const snapshot = await collectGetSnapshot(session);
  const metrics = extractMetricsFromText(`${snapshot.statText} ${snapshot.bodyText}`);

  console.log(JSON.stringify({
    mode: 'get',
    target: targetRow || { articleId: cmd.articleId || '', title: cmd.title || '', url: cmd.url || '' },
    page: { title: snapshot.title, url: snapshot.url },
    metrics,
  }, null, 2));
}

async function runDelete(session: ChromeSession, opts: RuntimeOptions): Promise<void> {
  const cmd = opts.command;
  if (cmd.mode !== 'delete') throw new Error('Invalid mode for delete');

  await navigateTo(session, opts.contentManageUrl, opts.slowMs);
  await ensureNoRiskPrompt(session);

  const targetRow = await findTargetRow(session, cmd, opts.maxPages, opts.slowMs);
  if (!targetRow) throw new Error('Target article not found on scanned management pages.');

  const clickedDelete = await clickDeleteAction(session, cmd);
  if (!clickedDelete) throw new Error('Delete action not found for target row.');
  await sleep(opts.slowMs);

  const confirmed = await clickDeleteConfirm(session);
  if (!confirmed) throw new Error('Delete confirmation dialog not found.');
  await sleep(opts.slowMs);

  const deleted = await verifyDeleted(session, cmd);
  console.log(JSON.stringify({
    mode: 'delete',
    target: {
      articleId: targetRow.articleId,
      title: targetRow.title,
      url: targetRow.url,
    },
    deleted,
  }, null, 2));

  if (!deleted) {
    throw new Error('Post-delete verification failed: target still appears on the page.');
  }
}

async function main(): Promise<void> {
  const opts = resolveRuntimeOptions(process.argv.slice(2));
  const portToTry = opts.command.cdpPort ?? await findExistingChromeDebugPort();

  let cdp: CdpConnection;
  let chrome: ReturnType<typeof import('node:child_process').spawn> | null = null;

  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) cdp = existing;
    else {
      const launched = await launchChrome(NETEASEHAO_HOME, opts.profileDir);
      cdp = launched.cdp;
      chrome = launched.chrome;
    }
  } else {
    const launched = await launchChrome(NETEASEHAO_HOME, opts.profileDir);
    cdp = launched.cdp;
    chrome = launched.chrome;
  }

  try {
    await sleep(Math.max(1200, opts.slowMs));

    let session: ChromeSession;
    if (!chrome) {
      const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
      const existingTab = targets.targetInfos.find((target) => target.type === 'page' && target.url.includes('mp.163.com'));
      if (existingTab) session = await attachSessionToTarget(cdp, existingTab.targetId);
      else {
        await cdp.send('Target.createTarget', { url: NETEASEHAO_HOME });
        await sleep(opts.slowMs);
        session = await getPageSession(cdp, 'mp.163.com');
      }
    } else {
      session = await getPageSession(cdp, 'mp.163.com');
    }

    const initialState = await getNeteasehaoPageState(session);
    if (!isNeteasehaoSessionLoggedIn(initialState)) {
      console.log('[neteasehao] Not logged in. Please login in Chrome window.');
      await waitForLogin(session, 120_000);
    }

    if (opts.command.mode === 'list') await runList(session, opts);
    if (opts.command.mode === 'get') await runGet(session, opts);
    if (opts.command.mode === 'delete') await runDelete(session, opts);
  } finally {
    cdp.close();
    if (chrome) chrome.kill();
  }
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
