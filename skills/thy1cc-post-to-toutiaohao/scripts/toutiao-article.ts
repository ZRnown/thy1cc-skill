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

const TOUTIAO_HOME = 'https://mp.toutiao.com/';
const DEFAULT_EDITOR_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';
const MAX_TITLE_CHARS = 30;

interface PublishOptions {
  htmlFile?: string;
  markdownFile?: string;
  content?: string;
  title?: string;
  profileDir?: string;
  cdpPort?: number;
  editorUrl?: string;
  closeOnFailure: boolean;
}

interface ExtendConfig {
  chrome_profile_path?: string;
  editor_url?: string;
}

interface ContentBlock {
  type: 'paragraph' | 'image';
  text?: string;
  src?: string;
}

interface PreparedArticle {
  title: string;
  titleOriginal: string;
  blocks: ContentBlock[];
  paragraphCount: number;
  imageCount: number;
}

interface DownloadedImageAsset {
  source: string;
  localPath: string;
}

interface VerificationSummary {
  titleMatched: boolean;
  textLength: number;
  imageBlockCount: number;
  bodyTextExcerpt: string;
}

function printHelp(): void {
  console.log(`Toutiao Hao Draft Uploader

Usage:
  node --experimental-strip-types toutiao-article.ts --html article-publish.html --title "标题"
  node --experimental-strip-types toutiao-article.ts --markdown article-publish.md --title "标题"
  node --experimental-strip-types toutiao-article.ts --content "正文" --title "标题"

Flags:
  --html <file>         HTML file to upload
  --markdown <file>     Markdown file; a companion HTML file is preferred
  --content <text>      Plain text fallback
  --title <text>        Override article title
  --profile-dir <dir>   Override Chrome user-data-dir
  --cdp-port <port>     Reuse an existing Chrome debug port
  --editor-url <url>    Override compose page URL
  --close-on-failure    Close launched Chrome if the run fails
  --help                Show this help
`);
}

function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = {
    closeOnFailure: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--html':
        options.htmlFile = argv[++i];
        break;
      case '--markdown':
        options.markdownFile = argv[++i];
        break;
      case '--content':
        options.content = argv[++i];
        break;
      case '--title':
        options.title = argv[++i];
        break;
      case '--profile-dir':
        options.profileDir = argv[++i];
        break;
      case '--cdp-port':
        options.cdpPort = Number.parseInt(argv[++i] || '', 10);
        break;
      case '--editor-url':
        options.editorUrl = argv[++i];
        break;
      case '--close-on-failure':
        options.closeOnFailure = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
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
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  return {
    chrome_profile_path: parsed.chrome_profile_path,
    editor_url: parsed.editor_url,
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

function resolveDefaults(options: PublishOptions, config: ExtendConfig): PublishOptions {
  return {
    ...options,
    profileDir: options.profileDir || config.chrome_profile_path || getDefaultProfileDir(),
    editorUrl: options.editorUrl || config.editor_url || DEFAULT_EDITOR_URL,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractElementInnerHtmlById(documentHtml: string, id: string): string | null {
  const openTagPattern = new RegExp(`<([a-zA-Z0-9:-]+)\\b[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`, 'i');
  const openMatch = openTagPattern.exec(documentHtml);
  if (!openMatch) return null;

  const tagName = openMatch[1]!.toLowerCase();
  const contentStart = openMatch.index + openMatch[0].length;

  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'ig');
  const closePattern = new RegExp(`</${tagName}>`, 'ig');
  openPattern.lastIndex = contentStart;
  closePattern.lastIndex = contentStart;

  let depth = 1;
  let cursor = contentStart;
  while (depth > 0) {
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const nextOpen = openPattern.exec(documentHtml);
    const nextClose = closePattern.exec(documentHtml);
    if (!nextClose) return null;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return documentHtml.slice(contentStart, nextClose.index).trim();
    }
    cursor = nextClose.index + nextClose[0].length;
  }

  return null;
}

function extractPublishHtmlFromDocument(documentHtml: string): string {
  const outputHtml = extractElementInnerHtmlById(documentHtml, 'output');
  if (outputHtml) return outputHtml;
  const bodyMatch = documentHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1]!.trim();
  return documentHtml.trim();
}

function parseHtmlMeta(documentHtml: string): { title: string } {
  const titleMatch = documentHtml.match(/<title>([^<]+)<\/title>/i);
  return {
    title: titleMatch ? titleMatch[1]!.trim() : '',
  };
}

function markdownToHtmlFallback(markdownPath: string): string | null {
  const candidates = [
    markdownPath.replace(/\.md$/i, '.html'),
    path.join(path.dirname(markdownPath), 'article-publish.html'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildHtmlFromPlainText(content: string): string {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function countUnicodeCodepoints(value: string): number {
  return Array.from(value).length;
}

function shortenToutiaoTitle(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (countUnicodeCodepoints(cleaned) <= MAX_TITLE_CHARS) return cleaned;

  const questionIndex = cleaned.indexOf('？');
  if (questionIndex > 0) {
    const prefix = cleaned.slice(0, questionIndex + 1).trim();
    if (countUnicodeCodepoints(prefix) <= MAX_TITLE_CHARS) return prefix;
  }

  const commaIndex = cleaned.indexOf('，');
  if (commaIndex > 0) {
    const prefix = cleaned.slice(0, commaIndex).trim();
    if (countUnicodeCodepoints(prefix) >= 8 && countUnicodeCodepoints(prefix) <= MAX_TITLE_CHARS) return prefix;
  }

  const clipped = Array.from(cleaned).slice(0, MAX_TITLE_CHARS - 1).join('').trim();
  return `${clipped}…`;
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

async function openFreshComposeSession(cdp: CdpConnection, editorUrl: string): Promise<ChromeSession> {
  const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: editorUrl });
  await sleep(4_000);
  return await attachSessionToTarget(cdp, created.targetId);
}

async function waitForTitleField(session: ChromeSession, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await evaluate<boolean>(session, `
      (() => !!document.querySelector('textarea[placeholder*="标题"]'))()
    `);
    if (ready) return;
    await sleep(500);
  }
  throw new Error('Toutiao title field did not appear in time.');
}

async function dismissKnownHints(session: ChromeSession): Promise<void> {
  await evaluate(session, `
    (() => {
      const labels = ['我知道了', '知道了', '关闭'];
      const candidates = Array.from(document.querySelectorAll('button, a, span, div'));
      for (const label of labels) {
        const target = candidates.find((node) => {
          const el = node;
          const text = (el.textContent || '').trim();
          return text === label && el instanceof HTMLElement && !!el.offsetParent;
        });
        if (target) {
          target.click();
          return true;
        }
      }
      return false;
    })()
  `);
}

async function setControlledTextareaValue(session: ChromeSession, selector: string, value: string): Promise<void> {
  await evaluate(session, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLTextAreaElement)) {
        throw new Error('Textarea not found for selector: ' + ${JSON.stringify(selector)});
      }
      const descriptor =
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value') ||
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (!descriptor || typeof descriptor.set !== 'function') {
        throw new Error('Textarea native setter not found.');
      }
      descriptor.set.call(el, ${JSON.stringify(value)});
      for (const type of ['input', 'change', 'blur', 'keyup', 'keydown', 'compositionend']) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
      }
      return el.value;
    })()
  `);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function replaceEditorParagraphs(session: ChromeSession, paragraphs: string[]): Promise<void> {
  const html = [
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`),
    '<p><br></p>',
  ].join('');

  await evaluate(session, `
    (() => {
      const editor = document.querySelector('.ProseMirror');
      if (!(editor instanceof HTMLElement)) {
        throw new Error('Toutiao editor .ProseMirror not found.');
      }
      editor.focus();
      editor.innerHTML = ${JSON.stringify(html)};
      const types = ['input', 'change', 'keyup', 'keydown', 'blur'];
      for (const type of types) {
        editor.dispatchEvent(new Event(type, { bubbles: true }));
      }
      return editor.innerText || '';
    })()
  `);
}

async function parseBlocksFromHtml(session: ChromeSession, html: string): Promise<ContentBlock[]> {
  return await evaluate<ContentBlock[]>(session, `
    (() => {
      const rawHtml = ${JSON.stringify(html)};
      const wrapped = rawHtml.includes('<html') ? rawHtml : '<!doctype html><html><body>' + rawHtml + '</body></html>';
      const doc = new DOMParser().parseFromString(wrapped, 'text/html');
      const root = doc.querySelector('#output') || doc.body;
      const blocks = [];
      const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME']);
      const paragraphTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION']);

      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const pushParagraph = (value) => {
        const text = cleanText(value);
        if (!text) return;
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'paragraph' && last.text === text) return;
        blocks.push({ type: 'paragraph', text });
      };
      const pushImage = (value) => {
        const src = cleanText(value);
        if (!src) return;
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'image' && last.src === src) return;
        blocks.push({ type: 'image', src });
      };

      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement;
          const parentTag = parent ? parent.tagName : '';
          if (!parentTag || parentTag === 'BODY' || parentTag === 'DIV') {
            pushParagraph(node.textContent || '');
          }
          return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node;
        if (skipTags.has(el.tagName)) return;
        if (el.tagName === 'IMG') {
          pushImage(el.getAttribute('src') || '');
          return;
        }
        if (paragraphTags.has(el.tagName)) {
          const hasNestedImages = !!el.querySelector('img');
          if (!hasNestedImages) {
            pushParagraph(el.textContent || '');
            return;
          }
        }

        for (const child of Array.from(el.childNodes)) {
          walk(child);
        }
      };

      for (const child of Array.from(root.childNodes)) {
        walk(child);
      }

      return blocks.filter((entry) => {
        if (entry.type === 'paragraph') return !!cleanText(entry.text || '');
        return !!cleanText(entry.src || '');
      });
    })()
  `);
}

function resolveImageSource(src: string, baseDir: string): string {
  const clean = src.trim();
  if (/^https?:\/\//i.test(clean)) return clean;
  if (clean.startsWith('file://')) return decodeURIComponent(new URL(clean).pathname);
  if (path.isAbsolute(clean)) return clean;
  return path.resolve(baseDir, clean);
}

function inferExtensionFromSource(source: string, mime: string): string {
  const lower = source.toLowerCase();
  if (/\.(jpg|jpeg)(?:$|\?)/.test(lower)) return '.jpg';
  if (/\.(png)(?:$|\?)/.test(lower)) return '.png';
  if (/\.(webp)(?:$|\?)/.test(lower)) return '.webp';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

async function downloadImageAsset(source: string, tempDir: string, index: number): Promise<DownloadedImageAsset> {
  if (source.startsWith('/') || /^[A-Za-z]:\\/.test(source)) {
    if (!fs.existsSync(source)) {
      throw new Error(`Local image not found for Toutiao upload: ${source}`);
    }
    return { source, localPath: source };
  }

  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(source, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        throw new Error(`Downloaded empty image for Toutiao upload: ${source}`);
      }
      const mime = (response.headers.get('content-type') || '').split(';')[0]!.trim();
      const extension = inferExtensionFromSource(source, mime);
      const filePath = path.join(tempDir, `toutiao-image-${index + 1}${extension}`);
      fs.writeFileSync(filePath, buffer);
      return { source, localPath: filePath };
    }

    lastStatus = response.status;
    const shouldRetry = response.status === 408 || response.status === 429 || response.status >= 500;
    if (!shouldRetry || attempt === 3) {
      throw new Error(`Failed to download image for Toutiao upload: ${source} (${response.status})`);
    }
    await sleep(1_500 * (attempt + 1));
  }

  throw new Error(`Failed to download image for Toutiao upload: ${source} (${lastStatus || 'unknown'})`);
}

async function setSelectionByParagraphCount(session: ChromeSession, paragraphsBeforeImage: number): Promise<void> {
  await evaluate(session, `
    (() => {
      const editor = document.querySelector('.ProseMirror');
      if (!(editor instanceof HTMLElement)) {
        throw new Error('Toutiao editor not found when placing cursor.');
      }
      const textParagraphs = Array.from(editor.querySelectorAll('p'))
        .filter((node) => String(node.innerText || '').replace(/\\s+/g, '').length > 0);
      const selection = window.getSelection();
      if (!selection) {
        throw new Error('Selection API unavailable.');
      }
      const range = document.createRange();
      if (${paragraphsBeforeImage} <= 0 || textParagraphs.length === 0) {
        range.selectNodeContents(editor);
        range.collapse(true);
      } else {
        const index = Math.min(${paragraphsBeforeImage} - 1, textParagraphs.length - 1);
        const target = textParagraphs[index];
        range.selectNodeContents(target);
        range.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(range);
      editor.focus();
      return true;
    })()
  `);
}

async function openImageDrawer(session: ChromeSession): Promise<void> {
  await evaluate(session, `
    (() => {
      const button = document.querySelector('.syl-toolbar-tool.image .syl-toolbar-button');
      if (!(button instanceof HTMLElement)) {
        throw new Error('Toutiao image toolbar button not found.');
      }
      button.click();
      return true;
    })()
  `);
  await waitForCondition(
    session,
    `(() => !!document.querySelector('.mp-ic-img-drawer input[type="file"][accept*="image"]'))()`,
    15_000,
    300,
    'Toutiao image drawer did not open in time.',
  );
}

async function uploadImageThroughDrawer(session: ChromeSession, localPath: string, expectedImageBlocks: number): Promise<void> {
  await session.cdp.send('DOM.enable', {}, { sessionId: session.sessionId });
  const { root } = await session.cdp.send<{ root: { nodeId: number } }>(
    'DOM.getDocument',
    { depth: -1, pierce: true },
    { sessionId: session.sessionId },
  );
  const query = await session.cdp.send<{ nodeId: number }>(
    'DOM.querySelector',
    { nodeId: root.nodeId, selector: '.mp-ic-img-drawer input[type="file"][accept*="image"]' },
    { sessionId: session.sessionId },
  );
  if (!query.nodeId) {
    throw new Error('Toutiao image drawer file input was not found.');
  }

  await session.cdp.send(
    'DOM.setFileInputFiles',
    { nodeId: query.nodeId, files: [localPath] },
    { sessionId: session.sessionId, timeoutMs: 30_000 },
  );

  await waitForCondition(
    session,
    `(() => {
      const drawer = document.querySelector('.mp-ic-img-drawer');
      const text = String(drawer?.innerText || '');
      return text.includes('已上传 1 张图片') || text.includes('已上传1张图片');
    })()`,
    30_000,
    500,
    'Toutiao image upload did not finish in time.',
  );

  await evaluate(session, `
    (() => {
      const confirmButton = Array.from(document.querySelectorAll('.mp-ic-img-drawer button'))
        .find((node) => (node.textContent || '').trim() === '确定');
      if (!(confirmButton instanceof HTMLElement)) {
        throw new Error('Toutiao image drawer confirm button not found.');
      }
      confirmButton.click();
      return true;
    })()
  `);

  await waitForCondition(
    session,
    `(() => {
      const editor = document.querySelector('.ProseMirror');
      if (!(editor instanceof HTMLElement)) return false;
      const blocks = Array.from(editor.children).filter((node) => node instanceof HTMLElement && node.hasAttribute('__syl_tag'));
      return blocks.length >= ${expectedImageBlocks};
    })()`,
    30_000,
    500,
    'Toutiao image block did not appear in the editor after confirming upload.',
  );
}

async function waitForCondition(
  session: ChromeSession,
  expression: string,
  timeoutMs: number,
  intervalMs: number,
  errorMessage: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evaluate<boolean>(session, expression);
    if (ok) return;
    await sleep(intervalMs);
  }
  throw new Error(errorMessage);
}

async function waitForDraftSaved(session: ChromeSession, timeoutMs = 45_000): Promise<void> {
  await waitForCondition(
    session,
    `(() => {
      const text = String(document.body?.innerText || '');
      return text.includes('草稿已保存');
    })()`,
    timeoutMs,
    1_000,
    'Toutiao draft did not reach "草稿已保存" in time.',
  );
}

async function fetchDraftByTitle(session: ChromeSession, title: string): Promise<Record<string, unknown> | null> {
  const result = await evaluate<any>(session, `
    (async () => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const wanted = normalize(${JSON.stringify(title)});
      const response = await fetch('/mp/agw/creator_center/draft_list?type=0&count=20&offset=0', {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      const payload = await response.json();
      const list = payload?.data?.list || payload?.data || payload?.list || [];
      const matched = list.find((item) => item && normalize(item.title || '') === wanted);
      return matched || null;
    })()
  `);
  return result && typeof result === 'object' ? result : null;
}

async function reopenAndVerifyDraft(cdp: CdpConnection, editorUrl: string, title: string, minimumTextLength: number): Promise<VerificationSummary> {
  const session = await openFreshComposeSession(cdp, editorUrl);
  await waitForTitleField(session);
  await dismissKnownHints(session);

  const banner = await evaluate<{ bodyText: string; hasContinueEdit: boolean }>(session, `
    (() => ({
      bodyText: String(document.body?.innerText || ''),
      hasContinueEdit: Array.from(document.querySelectorAll('button, a, span, div')).some((node) => {
        const text = (node.textContent || '').trim();
        return text === '继续编辑' && node instanceof HTMLElement && !!node.offsetParent;
      }),
    }))()
  `);

  if (banner.hasContinueEdit) {
    await evaluate(session, `
      (() => {
        const target = Array.from(document.querySelectorAll('button, a, span, div')).find((node) => {
          const text = (node.textContent || '').trim();
          return text === '继续编辑' && node instanceof HTMLElement && !!node.offsetParent;
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      })()
    `);
    await sleep(5_000);
  }

  await dismissKnownHints(session);
  await waitForTitleField(session);
  await waitForCondition(
    session,
    `(() => !!document.querySelector('.ProseMirror'))()`,
    20_000,
    500,
    'Toutiao editor did not re-open for verification.',
  );

  return await evaluate<VerificationSummary>(session, `
    (() => {
      const editor = document.querySelector('.ProseMirror');
      const imageBlocks = editor
        ? Array.from(editor.children).filter((node) => node instanceof HTMLElement && node.hasAttribute('__syl_tag')).length
        : 0;
      const titleValue = document.querySelector('textarea[placeholder*="标题"]')?.value || '';
      const text = String(editor?.innerText || '');
      return {
        titleMatched: titleValue.trim() === ${JSON.stringify(title)},
        textLength: text.replace(/\\s+/g, ' ').trim().length,
        imageBlockCount: imageBlocks,
        bodyTextExcerpt: String(document.body?.innerText || '').slice(0, 2000),
      };
    })()
  `);
}

async function prepareArticle(session: ChromeSession, options: PublishOptions): Promise<PreparedArticle> {
  let documentHtml = '';
  let baseDir = process.cwd();
  let inferredTitle = '';

  if (options.htmlFile) {
    documentHtml = fs.readFileSync(options.htmlFile, 'utf8');
    baseDir = path.dirname(path.resolve(options.htmlFile));
    inferredTitle = parseHtmlMeta(documentHtml).title;
  } else if (options.markdownFile) {
    const fallbackHtml = markdownToHtmlFallback(options.markdownFile);
    if (!fallbackHtml) {
      throw new Error(`No companion HTML file found for markdown input: ${options.markdownFile}`);
    }
    documentHtml = fs.readFileSync(fallbackHtml, 'utf8');
    baseDir = path.dirname(path.resolve(fallbackHtml));
    inferredTitle = parseHtmlMeta(documentHtml).title;
  } else if (options.content) {
    documentHtml = buildHtmlFromPlainText(options.content);
  } else {
    throw new Error('One of --html, --markdown, or --content is required.');
  }

  const extractedHtml = extractPublishHtmlFromDocument(documentHtml);
  const blocks = await parseBlocksFromHtml(session, extractedHtml);
  if (!blocks.length) {
    throw new Error('No usable content blocks were extracted for Toutiao upload.');
  }

  const titleOriginal = (options.title || inferredTitle || '').trim();
  if (!titleOriginal) {
    throw new Error('Toutiao upload needs a title. Provide --title or include <title> in the HTML file.');
  }

  const title = shortenToutiaoTitle(titleOriginal);
  const resolvedBlocks = blocks.map((block) => {
    if (block.type !== 'image') return block;
    return {
      type: 'image' as const,
      src: resolveImageSource(block.src || '', baseDir),
    };
  });

  return {
    title,
    titleOriginal,
    blocks: resolvedBlocks,
    paragraphCount: resolvedBlocks.filter((item) => item.type === 'paragraph').length,
    imageCount: resolvedBlocks.filter((item) => item.type === 'image').length,
  };
}

async function main(): Promise<void> {
  const cliOptions = parseArgs(process.argv.slice(2));
  const config = loadExtendConfig();
  const options = resolveDefaults(cliOptions, config);

  let launchedChrome: ReturnType<typeof launchChrome> | null = null;
  let cdp: CdpConnection | null = null;
  let tempDir: string | null = null;

  try {
    if (options.cdpPort) {
      cdp = await tryConnectExisting(options.cdpPort);
      if (!cdp) throw new Error(`Failed to connect to existing Chrome debug port: ${options.cdpPort}`);
    } else {
      const existingPort = await findExistingChromeDebugPort();
      if (existingPort) {
        cdp = await tryConnectExisting(existingPort);
      }
      if (!cdp) {
        launchedChrome = await launchChrome(TOUTIAO_HOME, options.profileDir);
        cdp = launchedChrome.cdp;
      }
    }

    const session = await ensureToutiaoSession(cdp);
    await waitForLogin(session);
    const article = await prepareArticle(session, options);

    console.error(`[toutiao] title: ${article.title}`);
    if (article.title !== article.titleOriginal) {
      console.error(`[toutiao] title shortened from "${article.titleOriginal}" to "${article.title}"`);
    }
    console.error(`[toutiao] blocks: paragraphs=${article.paragraphCount} images=${article.imageCount}`);

    const editorSession = await openFreshComposeSession(cdp, options.editorUrl || DEFAULT_EDITOR_URL);
    await waitForTitleField(editorSession);
    await dismissKnownHints(editorSession);
    await setControlledTextareaValue(editorSession, 'textarea[placeholder*="标题"]', article.title);

    const paragraphs = article.blocks
      .filter((block) => block.type === 'paragraph')
      .map((block) => block.text || '')
      .filter(Boolean);
    await replaceEditorParagraphs(editorSession, paragraphs);
    await sleep(2_000);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toutiao-draft-'));
    let paragraphsSeen = 0;
    let uploadedImages = 0;
    for (let index = 0; index < article.blocks.length; index += 1) {
      const block = article.blocks[index]!;
      if (block.type === 'paragraph') {
        paragraphsSeen += 1;
        continue;
      }

      const asset = await downloadImageAsset(block.src || '', tempDir, uploadedImages);
      await setSelectionByParagraphCount(editorSession, paragraphsSeen);
      await openImageDrawer(editorSession);
      await uploadImageThroughDrawer(editorSession, asset.localPath, uploadedImages + 1);
      uploadedImages += 1;
      await sleep(1_500);
    }

    await waitForDraftSaved(editorSession);
    let draft: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      draft = await fetchDraftByTitle(editorSession, article.title);
      if (draft) break;
      await sleep(1_000);
    }
    if (!draft) {
      console.error(`[toutiao] draft_list did not return the saved title, continuing with reopen verification only: ${article.title}`);
    }

    const minimumTextLength = Math.max(80, paragraphs.join(' ').length * 0.45);
    const verification = await reopenAndVerifyDraft(cdp, options.editorUrl || DEFAULT_EDITOR_URL, article.title, minimumTextLength);
    if (!verification.titleMatched) {
      throw new Error(`Toutiao reopened draft title mismatch for "${article.title}".`);
    }
    if (verification.textLength < minimumTextLength) {
      throw new Error(`Toutiao reopened draft text too short: ${verification.textLength} < ${minimumTextLength}`);
    }
    if (verification.imageBlockCount < article.imageCount) {
      throw new Error(`Toutiao reopened draft image count mismatch: ${verification.imageBlockCount} < ${article.imageCount}`);
    }

    const summary = {
      ok: true,
      title: article.title,
      titleOriginal: article.titleOriginal,
      paragraphCount: article.paragraphCount,
      expectedImageCount: article.imageCount,
      reopenedImageBlockCount: verification.imageBlockCount,
      reopenedTextLength: verification.textLength,
      draft,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (launchedChrome && cliOptions.closeOnFailure) {
      try {
        launchedChrome.chrome.kill();
      } catch {}
    }
    cdp?.close();
  }
}

await main();
