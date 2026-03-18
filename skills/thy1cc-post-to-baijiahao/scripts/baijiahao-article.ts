import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { getDefaultProfileDir, type ChromeSession, type CdpConnection, findExistingChromeDebugPort, getPageSession, launchChrome, sleep, tryConnectExisting, evaluate, typeText, waitForNewTab } from './cdp.ts';
import { getBaijiahaoPageState, isBaijiahaoSessionLoggedIn } from './baijiahao-auth.ts';
import { AUTHOR_FIELD_SELECTORS, SUMMARY_FIELD_SELECTORS, TITLE_FIELD_SELECTORS } from './baijiahao-editor-locators.ts';
import { BODY_EDITOR_SELECTORS } from './editor-candidates.ts';
import { pickActionCandidate, type ActionCandidate } from './action-targets.ts';
import { analyzePublishHtml } from './publish-html.ts';
import { extractPublishHtmlFromDocument } from './publish-source.ts';
import { analyzePreviewHtml, collectPublishExpectations, parseSaveApiResponse, type PublishExpectations } from './publish-verification.ts';

const BAIJIAHAO_HOME = 'https://baijiahao.baidu.com/';
const ACTION_TEXT_SELECTORS = 'button, a, [role="button"], div, span';

interface PublishOptions {
  htmlFile?: string;
  markdownFile?: string;
  title?: string;
  summary?: string;
  author?: string;
  content?: string;
  submit: boolean;
  profileDir?: string;
  cdpPort?: number;
  editorUrl?: string;
  createButtonTexts: string[];
  closeOnFailure: boolean;
}

interface ExtendConfig {
  default_author?: string;
  chrome_profile_path?: string;
  editor_url?: string;
  create_button_texts?: string;
  default_action?: string;
}

interface CapturedSaveResponse {
  url: string;
  status: number;
  body: string;
  transport: string;
  ts: number;
}

interface ListVerificationResult {
  statusParam: string;
  found: boolean;
  excerpt: string;
}

interface PreviewVerificationSummary {
  ok: boolean;
  titleMatched: boolean;
  textLength: number;
  imageCount: number;
  url: string;
}

interface RemoteImageAsset {
  originalSrc: string;
  base64: string;
  mime: string;
  filename: string;
}

interface UploadedImageAsset {
  originalSrc: string;
  uploadedUrl: string;
}

interface EditorVerificationSummary {
  ok: boolean;
  imageCount: number;
  url: string;
}

function printHelp(): void {
  console.log(`Usage:
  npx -y bun baijiahao-article.ts --html article-publish.html --title "标题" --summary "摘要"
  npx -y bun baijiahao-article.ts --markdown article-publish.md --title "标题"
  npx -y bun baijiahao-article.ts --content "正文" --title "标题"

Flags:
  --html <file>         HTML file to publish
  --markdown <file>     Markdown file; a companion HTML file is preferred
  --content <text>      Plain text fallback
  --title <text>        Article title
  --summary <text>      Article summary
  --author <text>       Author name
  --submit              Attempt final publish instead of saving draft
  --close-on-failure    Close launched Chrome even when the run fails
  --profile-dir <dir>   Override Chrome profile directory
  --cdp-port <port>     Reuse an existing Chrome debug port
  --editor-url <url>    Direct editor URL if known
  --help                Show this help
`);
}

function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = {
    submit: false,
    createButtonTexts: [],
    closeOnFailure: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--html':
        options.htmlFile = argv[++i];
        break;
      case '--markdown':
        options.markdownFile = argv[++i];
        break;
      case '--title':
        options.title = argv[++i];
        break;
      case '--summary':
        options.summary = argv[++i];
        break;
      case '--author':
        options.author = argv[++i];
        break;
      case '--content':
        options.content = argv[++i];
        break;
      case '--submit':
        options.submit = true;
        break;
      case '--close-on-failure':
        options.closeOnFailure = true;
        break;
      case '--profile-dir':
        options.profileDir = argv[++i];
        break;
      case '--cdp-port':
        options.cdpPort = parseInt(argv[++i], 10);
        break;
      case '--editor-url':
        options.editorUrl = argv[++i];
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

function loadExtendFile(envPath: string): Record<string, string> {
  const data: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return data;
  const content = fs.readFileSync(envPath, 'utf-8');
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

function loadExtendConfig(): ExtendConfig {
  const projectPath = path.join(process.cwd(), '.thy1cc-skills', 'thy1cc-post-to-baijiahao', 'EXTEND.md');
  const userPath = path.join(os.homedir(), '.thy1cc-skills', 'thy1cc-post-to-baijiahao', 'EXTEND.md');
  return {
    ...loadExtendFile(userPath),
    ...loadExtendFile(projectPath),
  };
}

function resolveDefaults(cliOptions: PublishOptions, config: ExtendConfig): PublishOptions {
  const defaultAction = (config.default_action || '').toLowerCase();
  const createButtonTexts = (config.create_button_texts || '发布内容,发文,写文章,发布,图文,文章')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    ...cliOptions,
    author: cliOptions.author || config.default_author || '',
    profileDir: cliOptions.profileDir || config.chrome_profile_path || getDefaultProfileDir(),
    editorUrl: cliOptions.editorUrl || config.editor_url || '',
    submit: cliOptions.submit || defaultAction === 'submit',
    createButtonTexts,
  };
}

function parseHtmlMeta(htmlPath: string): { title: string; author: string; summary: string } {
  const content = fs.readFileSync(htmlPath, 'utf-8');
  let title = '';
  let author = '';
  let summary = '';

  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) title = titleMatch[1]!.trim();

  const authorMatch = content.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i)
    || content.match(/<meta\s+content=["']([^"']+)["']\s+name=["']author["']/i);
  if (authorMatch) author = authorMatch[1]!.trim();

  const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
    || content.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
  if (descMatch) summary = descMatch[1]!.trim();

  return { title, author, summary };
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferImageMimeType(imageUrl: string): string {
  const lower = imageUrl.toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function inferExtensionFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.jpg';
  }
}

function guessImageFilename(imageUrl: string, index: number, mime: string): string {
  try {
    const parsed = new URL(imageUrl);
    const pathname = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const cleanName = pathname.replace(/[^a-zA-Z0-9._-]/g, '');
    if (cleanName && /\.[a-z0-9]+$/i.test(cleanName)) return cleanName;
    if (cleanName) return `${cleanName}${inferExtensionFromMime(mime)}`;
  } catch {}
  if (path.isAbsolute(imageUrl)) {
    const cleanName = path.basename(imageUrl).replace(/[^a-zA-Z0-9._-]/g, '');
    if (cleanName && /\.[a-z0-9]+$/i.test(cleanName)) return cleanName;
    if (cleanName) return `${cleanName}${inferExtensionFromMime(mime)}`;
  }
  return `baijiahao-image-${index + 1}${inferExtensionFromMime(mime)}`;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, Math.round(seconds * 1000));
  }

  const until = Date.parse(value);
  if (Number.isFinite(until)) {
    return Math.max(1000, until - Date.now());
  }

  return null;
}

function readLocalImageAsset(imagePath: string, index: number): RemoteImageAsset {
  const localPath = imagePath.startsWith('file://')
    ? decodeURIComponent(new URL(imagePath).pathname)
    : imagePath;
  const buffer = fs.readFileSync(localPath);
  if (!buffer.length) {
    throw new Error(`Downloaded empty image for Baijiahao upload: ${imagePath}`);
  }
  const mime = inferImageMimeType(localPath);
  return {
    originalSrc: imagePath,
    base64: buffer.toString('base64'),
    mime,
    filename: guessImageFilename(localPath, index, mime),
  };
}

async function downloadRemoteImageAsset(imageUrl: string, index: number): Promise<RemoteImageAsset> {
  if (imageUrl.startsWith('file://') || path.isAbsolute(imageUrl)) {
    return readLocalImageAsset(imageUrl, index);
  }

  let lastStatus = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        throw new Error(`Downloaded empty image for Baijiahao upload: ${imageUrl}`);
      }

      const headerMime = (response.headers.get('content-type') || '').split(';')[0]!.trim();
      const mime = headerMime.startsWith('image/') ? headerMime : inferImageMimeType(imageUrl);

      return {
        originalSrc: imageUrl,
        base64: buffer.toString('base64'),
        mime,
        filename: guessImageFilename(imageUrl, index, mime),
      };
    }

    lastStatus = response.status;
    const shouldRetry = response.status === 429 || response.status === 408 || response.status >= 500;
    if (!shouldRetry || attempt === 3) {
      throw new Error(`Failed to download image for Baijiahao upload: ${imageUrl} (${response.status})`);
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const delayMs = retryAfterMs ?? (2000 * (attempt + 1));
    console.error(
      `[baijiahao] Image download retry ${attempt + 1}/3 after ${response.status}: waiting ${delayMs}ms for ${imageUrl}`,
    );
    await sleep(delayMs);
  }

  throw new Error(`Failed to download image for Baijiahao upload: ${imageUrl} (${lastStatus || 'unknown'})`);
}

async function uploadImageToBaijiahao(session: ChromeSession, asset: RemoteImageAsset): Promise<string> {
  const uploadedUrl = await evaluate<string>(session, `
    (async function() {
      const base64 = ${JSON.stringify(asset.base64)};
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: ${JSON.stringify(asset.mime)} });
      const form = new FormData();
      form.append('media', blob, ${JSON.stringify(asset.filename)});

      const response = await fetch('/materialui/picture/uploadProxy', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      const payload = JSON.parse(await response.text());
      return payload?.ret?.https_url || payload?.ret?.bos_url || '';
    })()
  `);

  if (!uploadedUrl) {
    throw new Error(`Baijiahao uploadProxy returned no usable URL for ${asset.originalSrc}`);
  }

  return uploadedUrl.replace(/^http:/i, 'https:');
}

async function uploadRemoteImagesForBaijiahao(session: ChromeSession, html: string): Promise<UploadedImageAsset[]> {
  const uniqueRemoteUrls = Array.from(new Set(
    analyzePublishHtml(html).remoteImageUrls
      .map((url) => url.trim())
      .filter((url) => url && !/baijiahao\.baidu\.com\/bjh\/picproxy/i.test(url))
  ));

  const uploads: UploadedImageAsset[] = [];
  for (let index = 0; index < uniqueRemoteUrls.length; index += 1) {
    const asset = await downloadRemoteImageAsset(uniqueRemoteUrls[index]!, index);
    const uploadedUrl = await uploadImageToBaijiahao(session, asset);
    uploads.push({
      originalSrc: asset.originalSrc,
      uploadedUrl,
    });
  }

  return uploads;
}

function extractPublishHtml(htmlPath: string): string {
  const content = fs.readFileSync(htmlPath, 'utf-8');
  return extractPublishHtmlFromDocument(content);
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
  return escaped.split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

async function waitForLogin(session: ChromeSession, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getBaijiahaoPageState(session);
    if (isBaijiahaoSessionLoggedIn(state)) return;
    console.log('[baijiahao] Waiting for login. Please complete any QR-code or verification flow in Chrome...');
    await sleep(2_000);
  }
  throw new Error('Login timeout');
}

async function clickFirstMatchingText(session: ChromeSession, texts: string[]): Promise<boolean> {
  const candidates = await evaluate<ActionCandidate[]>(session, `
    (function() {
      const selector = ${JSON.stringify(ACTION_TEXT_SELECTORS)};
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const ownText = (node) => Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent || '')
        .join(' ');

      return Array.from(document.querySelectorAll(selector))
        .filter((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.visibility !== 'hidden'
            && style.display !== 'none'
            && rect.width > 20
            && rect.height > 16
            && style.pointerEvents !== 'none';
        })
        .map((node, id) => {
          const rect = node.getBoundingClientRect();
          return {
            id,
            tagName: node.tagName,
            role: node.getAttribute('role') || '',
            text: normalize(node.textContent || ''),
            ownText: normalize(ownText(node)),
            area: rect.width * rect.height,
          };
        });
    })()
  `);

  const target = pickActionCandidate(candidates, texts);
  if (!target) return false;

  return await evaluate<boolean>(session, `
    (function() {
      const selector = ${JSON.stringify(ACTION_TEXT_SELECTORS)};
      const targetId = ${JSON.stringify(target.id)};
      const candidates = Array.from(document.querySelectorAll(selector))
        .filter((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.visibility !== 'hidden'
            && style.display !== 'none'
            && rect.width > 20
            && rect.height > 16
            && style.pointerEvents !== 'none';
        });

      const target = candidates[targetId];
      if (!(target instanceof HTMLElement)) return false;
      if (target instanceof HTMLButtonElement && target.disabled) return false;
      if (target.getAttribute('aria-disabled') === 'true') return false;

      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    })()
  `);
}

async function fieldHintsExist(session: ChromeSession, hints: string[]): Promise<boolean> {
  return await evaluate<boolean>(session, `
    (function() {
      const hints = ${JSON.stringify(hints.map((hint) => hint.toLowerCase()))};
      const normalize = (value) => (value || '').toLowerCase();
      const nodes = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [placeholder], [aria-label]'));
      return nodes.some((node) => {
        const text = [
          node.getAttribute?.('placeholder') || '',
          node.getAttribute?.('aria-label') || '',
          node.getAttribute?.('name') || '',
          node.id || '',
          node.parentElement?.textContent || '',
        ].join(' ');
        return hints.some((hint) => normalize(text).includes(hint));
      });
    })()
  `);
}

async function editorReady(session: ChromeSession): Promise<boolean> {
  const titleReady = await fieldHintsExist(session, ['标题', 'title']);
  const bodyReady = await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(BODY_EDITOR_SELECTORS)};
      return selectors.some((selector) => {
        const nodes = document.querySelectorAll(selector);
        return Array.from(nodes).some((node) => {
          if (!(node instanceof Element)) return false;
          const rect = node.getBoundingClientRect();
          if (node instanceof HTMLElement) {
            const style = window.getComputedStyle(node);
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 250 && rect.height > 80;
          }
          return rect.width > 250 && rect.height > 80;
        });
      });
    })()
  `);
  return titleReady && bodyReady;
}

async function injectHtmlWhenEditorReady(session: ChromeSession, html: string, timeoutMs = 20_000): Promise<{ ok: boolean; detail: string }> {
  const start = Date.now();
  let lastResult = { ok: false, detail: 'Body editor not ready yet' };

  while (Date.now() - start < timeoutMs) {
    lastResult = await injectHtml(session, html);
    if (lastResult.ok) return lastResult;
    if (lastResult.detail !== 'No editor candidate found' && lastResult.detail !== 'Iframe editor body unavailable') {
      return lastResult;
    }
    await sleep(1_000);
  }

  return lastResult;
}

async function fillField(session: ChromeSession, hints: string[], value: string): Promise<boolean> {
  if (!value) return false;
  return await evaluate<boolean>(session, `
    (function() {
      const hints = ${JSON.stringify(hints.map((hint) => hint.toLowerCase()))};
      const value = ${JSON.stringify(value)};
      const normalize = (input) => (input || '').toLowerCase();
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 40 && rect.height > 16;
      };

      const scoreNode = (node) => {
        const haystack = [
          node.getAttribute?.('placeholder') || '',
          node.getAttribute?.('aria-label') || '',
          node.getAttribute?.('name') || '',
          node.id || '',
          node.parentElement?.textContent || '',
          node.previousElementSibling?.textContent || '',
        ].join(' ');
        let score = 0;
        for (const hint of hints) {
          if (normalize(haystack).includes(hint)) score += 10;
        }
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) score += 5;
        return score;
      };

      const nodes = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(visible);
      const ranked = nodes
        .map((node) => ({ node, score: scoreNode(node) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = ranked[0]?.node;
      if (!best) return false;

      if (best instanceof HTMLInputElement || best instanceof HTMLTextAreaElement) {
        best.focus();
        const prototype = best instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(best, value);
        else best.value = value;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      if (best instanceof HTMLElement) {
        best.focus();
        best.textContent = value;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      return false;
    })()
  `);
}

async function fillBySelectors(session: ChromeSession, selectors: string[], value: string): Promise<boolean> {
  if (!value || selectors.length === 0) return false;
  return await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(selectors)};
      const value = ${JSON.stringify(value)};
      const escapeHtml = (input) => input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 20 && rect.height > 16;
      };

      const best = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((node) => visible(node));

      if (!(best instanceof HTMLElement)) return false;

      if (best instanceof HTMLInputElement || best instanceof HTMLTextAreaElement) {
        best.focus();
        best.value = value;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      if (best.getAttribute('contenteditable') === 'true') {
        best.focus();
        if (best.getAttribute('data-lexical-editor') === 'true') {
          best.innerHTML = '<p dir="auto">' + escapeHtml(value) + '</p>';
        } else {
          best.textContent = value;
        }
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      return false;
    })()
  `);
}

async function typeIntoContenteditableSelectors(session: ChromeSession, selectors: string[], value: string): Promise<boolean> {
  if (!value || selectors.length === 0) return false;

  const prepared = await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(selectors)};
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 20 && rect.height > 16;
      };

      const best = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((node) => node instanceof HTMLElement && node.getAttribute('contenteditable') === 'true' && visible(node));

      if (!(best instanceof HTMLElement)) return false;

      best.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(best);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      return true;
    })()
  `);

  if (!prepared) return false;
  await sleep(100);
  await typeText(session, value);
  return true;
}

async function typeIntoTextControlSelectors(session: ChromeSession, selectors: string[], value: string): Promise<boolean> {
  if (!value || selectors.length === 0) return false;

  const prepared = await evaluate<boolean>(session, `
    (function() {
      const selectors = ${JSON.stringify(selectors)};
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 20 && rect.height > 16;
      };

      const best = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((node) => (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && visible(node));

      if (!(best instanceof HTMLInputElement || best instanceof HTMLTextAreaElement)) return false;

      best.focus();
      if (typeof best.select === 'function') best.select();
      return document.activeElement === best;
    })()
  `);

  if (!prepared) return false;
  await sleep(100);
  await typeText(session, value);
  return true;
}

async function injectHtml(session: ChromeSession, html: string): Promise<{ ok: boolean; detail: string }> {
  const uploadedImages = await uploadRemoteImagesForBaijiahao(session, html);
  const plainText = stripTags(html);
  return await evaluate<{ ok: boolean; detail: string }>(session, `
    (function() {
      const html = ${JSON.stringify(html)};
      const plainText = ${JSON.stringify(plainText)};
      const uploadedImages = ${JSON.stringify(uploadedImages)};
      const selectors = ${JSON.stringify(BODY_EDITOR_SELECTORS)};
      const visible = (node) => {
        if (!(node instanceof Element)) return false;
        const rect = node.getBoundingClientRect();
        if (node instanceof HTMLElement) {
          const style = window.getComputedStyle(node);
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 250 && rect.height > 80;
        }
        return rect.width > 250 && rect.height > 80;
      };

      const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const uploadMap = new Map(uploadedImages.map((item) => [item.originalSrc, item.uploadedUrl]));
      const buildImageBlock = (doc, originalSrc, captionText, altText) => {
        const uploadedUrl = uploadMap.get(originalSrc) || originalSrc;
        const wrapper = doc.createElement('p');
        wrapper.style.textAlign = 'center';

        const img = doc.createElement('img');
        img.setAttribute('src', uploadedUrl);
        img.setAttribute('_src', uploadedUrl);
        img.setAttribute('data-bjh-origin-src', uploadedUrl);
        img.setAttribute('data-bjh-type', 'IMG');
        if (altText) img.setAttribute('alt', altText);
        wrapper.appendChild(img);

        const nodes = [wrapper];
        if (captionText) {
          const caption = doc.createElement('p');
          caption.className = 'bjh-image-caption ue_t';
          caption.textContent = captionText;
          nodes.push(caption);
        }

        const spacer = doc.createElement('p');
        spacer.appendChild(doc.createElement('br'));
        nodes.push(spacer);
        return nodes;
      };

      const replaceNodeWithAll = (target, nodes) => {
        if (!target || !target.parentNode || !nodes.length) return;
        const first = nodes[0];
        target.parentNode.replaceChild(first, target);
        let cursor = first;
        for (let i = 1; i < nodes.length; i += 1) {
          cursor.parentNode.insertBefore(nodes[i], cursor.nextSibling);
          cursor = nodes[i];
        }
      };

      const toBaijiahaoHtml = (rawHtml) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString('<div id="codex-root">' + rawHtml + '</div>', 'text/html');
        const root = doc.querySelector('#codex-root') || doc.body;

        Array.from(root.querySelectorAll('figure')).forEach((figure) => {
          const img = figure.querySelector('img');
          if (!(img instanceof HTMLImageElement)) return;
          const originalSrc = normalizeText(img.getAttribute('src'));
          if (!originalSrc) return;
          const captionText = normalizeText(figure.querySelector('figcaption')?.textContent || img.getAttribute('alt'));
          const altText = normalizeText(img.getAttribute('alt') || captionText);
          replaceNodeWithAll(figure, buildImageBlock(doc, originalSrc, captionText, altText));
        });

        Array.from(root.querySelectorAll('img')).forEach((imgNode) => {
          if (!(imgNode instanceof HTMLImageElement)) return;
          if (imgNode.closest('p')?.classList.contains('bjh-image-container')) return;
          const originalSrc = normalizeText(imgNode.getAttribute('src'));
          if (!originalSrc) return;
          const captionText = normalizeText(imgNode.getAttribute('alt'));
          const altText = normalizeText(imgNode.getAttribute('alt'));
          const paragraphParent = imgNode.parentElement && imgNode.parentElement.tagName === 'P'
            ? imgNode.parentElement
            : imgNode;
          replaceNodeWithAll(paragraphParent, buildImageBlock(doc, originalSrc, captionText, altText));
        });

        Array.from(root.querySelectorAll('figcaption')).forEach((node) => node.remove());
        return root.innerHTML;
      };

      const editorEntry = window.$EDITORUI_V2
        ? Object.values(window.$EDITORUI_V2).find((value) => value && typeof value === 'object' && value.editor && typeof value.editor.setContent === 'function')
        : null;
      const editor = editorEntry && editorEntry.editor;
      if (editor && typeof editor.setContent === 'function') {
        const finalHtml = toBaijiahaoHtml(html);
        editor.setContent(finalHtml);
        if (typeof editor.sync === 'function') editor.sync();
        if (typeof editor.fireEvent === 'function') editor.fireEvent('contentchange');
        return { ok: true, detail: 'Set content via editor.setContent' };
      }

      const candidates = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .filter(visible);

      const best = candidates
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { node, area: rect.width * rect.height };
        })
        .sort((a, b) => b.area - a.area)[0]?.node;

      if (!best) return { ok: false, detail: 'No editor candidate found' };

      if (best instanceof HTMLIFrameElement) {
        const doc = best.contentDocument || best.contentWindow?.document;
        if (!doc || !doc.body) return { ok: false, detail: 'Iframe editor body unavailable' };

        doc.body.focus();
        doc.body.innerHTML = html;
        doc.body.dispatchEvent(new Event('input', { bubbles: true }));
        doc.body.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: 'Set innerHTML inside iframe editor body' };
      }

      if (best instanceof HTMLTextAreaElement) {
        best.focus();
        best.value = plainText;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: 'Injected plain text into textarea' };
      }

      if (best instanceof HTMLElement) {
        best.focus();
        try {
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.selectNodeContents(best);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          if (document.execCommand) {
            document.execCommand('selectAll', false);
            document.execCommand('delete', false);
            const inserted = document.execCommand('insertHTML', false, html);
            if (inserted) {
              best.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true, detail: 'Inserted HTML via execCommand' };
            }
          }
        } catch {}

        best.innerHTML = html;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: 'Set innerHTML on editor candidate' };
      }

      return { ok: false, detail: 'Unsupported editor element' };
    })()
  `);
}

async function clickAction(session: ChromeSession, labels: string[]): Promise<boolean> {
  return await clickFirstMatchingText(session, labels);
}

async function attachSessionToTarget(cdp: CdpConnection, targetId: string): Promise<ChromeSession> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, { sessionId });
  await cdp.send('Runtime.enable', {}, { sessionId });
  await cdp.send('DOM.enable', {}, { sessionId });
  return { cdp, sessionId, targetId };
}

async function installSaveResponseCapture(session: ChromeSession): Promise<void> {
  await evaluate(session, `
    (function() {
      const win = window;
      win.__codexBjhSaveResponses = [];
      if (win.__codexBjhSaveCaptureInstalled) return true;

      const matchesSaveUrl = (value) => /\\/pcui\\/article\\/save(?:\\?|$)/.test(String(value || ''));
      const record = (payload) => {
        try {
          const target = Array.isArray(win.__codexBjhSaveResponses) ? win.__codexBjhSaveResponses : [];
          target.push({
            url: String(payload.url || ''),
            status: Number(payload.status || 0),
            body: typeof payload.body === 'string' ? payload.body.slice(0, 200000) : '',
            transport: String(payload.transport || ''),
            ts: Date.now(),
          });
          win.__codexBjhSaveResponses = target;
        } catch {}
      };

      const originalFetch = window.fetch.bind(window);
      window.fetch = async function(...args) {
        const response = await originalFetch(...args);
        try {
          const request = args[0];
          const requestUrl = typeof request === 'string'
            ? request
            : (request && typeof request === 'object' && 'url' in request ? String(request.url || '') : '');
          const responseUrl = String(response.url || requestUrl || '');
          if (matchesSaveUrl(requestUrl) || matchesSaveUrl(responseUrl)) {
            response.clone().text()
              .then((body) => record({ url: responseUrl, status: response.status, body, transport: 'fetch' }))
              .catch(() => {});
          }
        } catch {}
        return response;
      };

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__codexSaveUrl = typeof url === 'string' ? url : String(url || '');
        return originalOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function(body) {
        this.addEventListener('loadend', () => {
          try {
            const responseUrl = this.responseURL || this.__codexSaveUrl || '';
            if (!matchesSaveUrl(responseUrl)) return;
            record({
              url: responseUrl,
              status: this.status,
              body: typeof this.responseText === 'string' ? this.responseText : '',
              transport: 'xhr',
            });
          } catch {}
        }, { once: true });
        return originalSend.call(this, body);
      };

      win.__codexBjhSaveCaptureInstalled = true;
      return true;
    })()
  `);
}

async function waitForCapturedSaveResponse(session: ChromeSession, timeoutMs = 20_000): Promise<CapturedSaveResponse> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const latest = await evaluate<CapturedSaveResponse | null>(session, `
      (function() {
        const entries = Array.isArray(window.__codexBjhSaveResponses) ? window.__codexBjhSaveResponses : [];
        if (!entries.length) return null;
        return entries[entries.length - 1];
      })()
    `);

    if (latest && latest.body) return latest;
    await sleep(500);
  }

  throw new Error('No Baijiahao save API response was captured after clicking the action button.');
}

function resolveListStatusCandidates(saveStatus: string, submit: boolean): string[] {
  const normalized = saveStatus.trim().toLowerCase();
  if (normalized === 'draft') return ['draft'];
  if (submit) return ['publish', 'published', 'all'];
  return ['draft', 'all'];
}

async function verifyTitleInContentList(cdp: CdpConnection, title: string, statusParam: string): Promise<ListVerificationResult> {
  const listUrl = `https://baijiahao.baidu.com/builder/rc/content?currentPage=1&pageSize=10&search=${encodeURIComponent(title)}&type=all&collection=&status=${encodeURIComponent(statusParam)}&startDate=&endDate=`;
  const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: listUrl });
  const listSession = await attachSessionToTarget(cdp, created.targetId);

  try {
    await sleep(6_000);
    const result = await evaluate<ListVerificationResult>(listSession, `
      (function() {
        const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
        return {
          statusParam: ${JSON.stringify(statusParam)},
          found: text.includes(${JSON.stringify(title)}),
          excerpt: text.slice(0, 1200),
        };
      })()
    `);
    return result;
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  }
}

async function verifyTitleInAnyContentList(cdp: CdpConnection, title: string, statusCandidates: string[]): Promise<ListVerificationResult[]> {
  const results: ListVerificationResult[] = [];
  for (const statusParam of statusCandidates) {
    const result = await verifyTitleInContentList(cdp, title, statusParam);
    results.push(result);
    if (result.found) break;
  }
  return results;
}

async function verifyPreviewContent(cdp: CdpConnection, previewUrl: string, title: string, expectations: PublishExpectations): Promise<PreviewVerificationSummary> {
  if (!previewUrl) {
    return {
      ok: false,
      titleMatched: false,
      textLength: 0,
      imageCount: 0,
      url: '',
    };
  }

  let latest: PreviewVerificationSummary = {
    ok: false,
    titleMatched: false,
    textLength: 0,
    imageCount: 0,
    url: previewUrl,
  };

  const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: previewUrl });
  const previewSession = await attachSessionToTarget(cdp, created.targetId);

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(attempt === 0 ? 8_000 : 2_000);
      const result = await evaluate<PreviewVerificationSummary>(previewSession, `
        (function() {
          const normalizedText = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
          const contentImageUrls = Array.from(document.querySelectorAll('img'))
            .map((img) => img.src || '')
            .filter((url) => {
              const normalized = String(url || '').toLowerCase();
              if (!normalized) return false;
              if (normalized.includes('/sys/portraith/')) return false;
              if (normalized.includes('.svg+xml')) return false;
              if (normalized.includes('/static/')) return false;
              return true;
            });
          const figureCount = document.querySelectorAll('figure').length;
          return {
            ok: false,
            titleMatched: normalizedText.includes(${JSON.stringify(title)}),
            textLength: normalizedText.length,
            imageCount: Math.max(contentImageUrls.length, figureCount),
            url: location.href,
          };
        })()
      `);

      latest = {
        ...result,
        ok: result.titleMatched
          && result.textLength >= expectations.minimumTextLength
          && result.imageCount >= expectations.imageCount,
      };

      if (latest.ok) return latest;
    }

    const rawHtml = await evaluate<string>(previewSession, `
      fetch(${JSON.stringify(previewUrl)}, { credentials: 'include' })
        .then((response) => response.text())
    `);
    const analysis = analyzePreviewHtml(rawHtml, title);
    return {
      ok: analysis.titleMatched
        && analysis.textLength >= expectations.minimumTextLength
        && analysis.imageCount >= expectations.imageCount,
      titleMatched: analysis.titleMatched,
      textLength: analysis.textLength,
      imageCount: analysis.imageCount,
      url: previewUrl,
    };
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  }
}

async function verifyEditorContent(cdp: CdpConnection, articleId: string, expectations: PublishExpectations): Promise<EditorVerificationSummary> {
  if (!articleId) {
    return {
      ok: expectations.imageCount === 0,
      imageCount: 0,
      url: '',
    };
  }

  const editorUrl = `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${encodeURIComponent(articleId)}`;
  const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: editorUrl });
  const editorSession = await attachSessionToTarget(cdp, created.targetId);

  try {
    await sleep(8_000);
    const result = await evaluate<EditorVerificationSummary>(editorSession, `
      (function() {
        const iframe = document.querySelector('iframe#ueditor_0');
        const doc = iframe && (iframe.contentDocument || iframe.contentWindow?.document);
        if (!doc || !doc.body) {
          return {
            ok: false,
            imageCount: 0,
            url: location.href,
          };
        }

        const imageCount = Array.from(doc.body.querySelectorAll('img'))
          .map((node) => node.getAttribute('src') || '')
          .filter((src) => src && /\\/bjh\\/picproxy/i.test(src))
          .length;

        return {
          ok: imageCount >= ${expectations.imageCount},
          imageCount,
          url: location.href,
        };
      })()
    `);
    return result;
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  }
}

async function openEditor(cdp: CdpConnection, session: ChromeSession, options: PublishOptions): Promise<ChromeSession> {
  if (options.editorUrl) {
    console.log(`[baijiahao] Navigating to configured editor URL: ${options.editorUrl}`);
    await evaluate(session, `window.location.href = ${JSON.stringify(options.editorUrl)}`);
    await sleep(5_000);
    return session;
  }

  console.log('[baijiahao] Trying heuristic create-button flow...');
  const initialTargets = await cdp.send<{ targetInfos: Array<{ targetId: string }> }>('Target.getTargets');
  const initialIds = new Set(initialTargets.targetInfos.map((target) => target.targetId));

  const clicked = await clickFirstMatchingText(session, options.createButtonTexts);
  if (!clicked) throw new Error('Could not find a Baijiahao create/publish button. Configure editor_url or create_button_texts in EXTEND.md.');

  await sleep(4_000);
  try {
    const newTargetId = await waitForNewTab(cdp, initialIds, 'baijiahao.baidu.com', 8_000);
    console.log('[baijiahao] Editor opened in a new tab.');
    return await attachSessionToTarget(cdp, newTargetId);
  } catch {
    console.log('[baijiahao] No new tab detected. Reusing current tab.');
    return session;
  }
}

async function main(): Promise<void> {
  const cliOptions = parseArgs(process.argv.slice(2));
  const config = loadExtendConfig();
  const options = resolveDefaults(cliOptions, config);

  let html = '';
  let title = options.title || '';
  let summary = options.summary || '';
  let author = options.author || '';

  if (options.htmlFile) {
    const meta = parseHtmlMeta(options.htmlFile);
    title = title || meta.title;
    summary = summary || meta.summary;
    author = author || meta.author;
    html = extractPublishHtml(options.htmlFile);
  } else if (options.markdownFile) {
    const htmlPath = markdownToHtmlFallback(options.markdownFile);
    if (!htmlPath) {
      throw new Error('Markdown provided without companion HTML. Prepare article-publish.html first or pass --html directly.');
    }
    const meta = parseHtmlMeta(htmlPath);
    title = title || meta.title;
    summary = summary || meta.summary;
    author = author || meta.author;
    html = extractPublishHtml(htmlPath);
  } else if (options.content) {
    html = buildHtmlFromPlainText(options.content);
  } else {
    throw new Error('Provide --html, --markdown, or --content.');
  }

  if (!title) throw new Error('Missing title. Pass --title or provide it in HTML metadata.');
  if (!summary) {
    const fallback = stripTags(html).slice(0, 110).trim();
    summary = fallback.length > 100 ? `${fallback.slice(0, 97)}...` : fallback;
  }

  const publishHtmlAnalysis = analyzePublishHtml(html);
  const publishExpectations = collectPublishExpectations(html);
  if (publishHtmlAnalysis.unsupportedImageRefs.length > 0) {
    throw new Error(
      `Unsupported local/non-remote images in HTML: ${publishHtmlAnalysis.unsupportedImageRefs.slice(0, 5).join(', ')}. ` +
      'Use remote image URLs in article-publish.html before uploading to Baijiahao.'
    );
  }

  let cdp: CdpConnection;
  let chrome: ReturnType<typeof import('node:child_process').spawn> | null = null;
  let runError: unknown = null;

  const portToTry = options.cdpPort ?? await findExistingChromeDebugPort();
  if (portToTry) {
    const existing = await tryConnectExisting(portToTry);
    if (existing) {
      console.log(`[cdp] Connected to existing Chrome on port ${portToTry}`);
      cdp = existing;
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

  try {
    await sleep(3_000);

    let session: ChromeSession;
    if (!chrome) {
      const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
      const existingTab = targets.targetInfos.find((target) => target.type === 'page' && target.url.includes('baijiahao.baidu.com'));
      if (existingTab) {
        session = await attachSessionToTarget(cdp, existingTab.targetId);
      } else {
        await cdp.send('Target.createTarget', { url: BAIJIAHAO_HOME });
        await sleep(5_000);
        session = await getPageSession(cdp, 'baijiahao.baidu.com');
      }
    } else {
      session = await getPageSession(cdp, 'baijiahao.baidu.com');
    }

    const initialState = await getBaijiahaoPageState(session);
    if (!isBaijiahaoSessionLoggedIn(initialState)) {
      console.log('[baijiahao] Not logged in yet. Please log into Baijiahao in Chrome.');
      await waitForLogin(session);
    }
    console.log('[baijiahao] Login confirmed.');

    session = await openEditor(cdp, session, options);
    await installSaveResponseCapture(session);

    const readyStart = Date.now();
    while (Date.now() - readyStart < 20_000) {
      if (await editorReady(session)) break;
      await sleep(1_000);
    }

    const titleFilled = await typeIntoContenteditableSelectors(session, TITLE_FIELD_SELECTORS, title)
      || await fillBySelectors(session, TITLE_FIELD_SELECTORS, title)
      || await fillField(session, ['标题', 'title'], title);
    const summaryFilled = await typeIntoTextControlSelectors(session, SUMMARY_FIELD_SELECTORS, summary)
      || await fillBySelectors(session, SUMMARY_FIELD_SELECTORS, summary)
      || await fillField(session, ['摘要', 'summary', '简介'], summary);
    const authorFilled = author ? (
      await typeIntoTextControlSelectors(session, AUTHOR_FIELD_SELECTORS, author)
      || await fillBySelectors(session, AUTHOR_FIELD_SELECTORS, author)
    ) : false;
    const bodyResult = await injectHtmlWhenEditorReady(session, html);

    console.log(`[baijiahao] Title filled: ${titleFilled}`);
    console.log(`[baijiahao] Summary filled: ${summaryFilled}`);
    console.log(`[baijiahao] Author filled: ${authorFilled}`);
    console.log(`[baijiahao] Body result: ${bodyResult.detail}`);

    await sleep(2_000);

    if (options.submit) {
      const clicked = await clickAction(session, ['发布', '确认发布', '提交发布', '立即发布']);
      if (!clicked) throw new Error('Publish button not found. The page may require manual confirmation.');
      console.log('[baijiahao] Publish click dispatched. Watch Chrome for any secondary confirmation dialog.');
    } else {
      const clicked = await clickAction(session, ['存草稿', '保存草稿', '保存为草稿', '保存', '草稿']);
      if (!clicked) throw new Error('Draft-save button not found.');
      console.log('[baijiahao] Draft-save click dispatched.');
    }

    const capturedSave = await waitForCapturedSaveResponse(session);
    const saveResult = parseSaveApiResponse(capturedSave.body);
    console.log(`[baijiahao] Save response: errno=${saveResult.errno ?? 'null'} status=${saveResult.status || 'unknown'} articleId=${saveResult.articleId || '-'} nid=${saveResult.nid || '-'} transport=${capturedSave.transport}`);

    if (saveResult.errno !== 0) {
      throw new Error(`Baijiahao save API returned errno=${saveResult.errno ?? 'null'} ${saveResult.errmsg || ''}`.trim());
    }

    const listChecks = await verifyTitleInAnyContentList(cdp, title, resolveListStatusCandidates(saveResult.status, options.submit));
    for (const result of listChecks) {
      console.log(`[baijiahao] Content list check (${result.statusParam}): found=${result.found}`);
    }

    const previewCheck = await verifyPreviewContent(cdp, saveResult.previewUrl, title, publishExpectations);
    if (previewCheck.url) {
      console.log(`[baijiahao] Preview check: titleMatched=${previewCheck.titleMatched} textLength=${previewCheck.textLength}/${publishExpectations.minimumTextLength} imageCount=${previewCheck.imageCount}/${publishExpectations.imageCount} url=${previewCheck.url}`);
    } else {
      console.log('[baijiahao] Preview check skipped: save response did not include nid.');
    }

    const editorCheck = await verifyEditorContent(cdp, saveResult.articleId, publishExpectations);
    if (editorCheck.url) {
      console.log(`[baijiahao] Editor check: imageCount=${editorCheck.imageCount}/${publishExpectations.imageCount} url=${editorCheck.url}`);
    } else {
      console.log('[baijiahao] Editor check skipped: save response did not include article_id.');
    }

    const listVerified = listChecks.some((result) => result.found);
    if (!listVerified && !previewCheck.ok) {
      throw new Error(
        'Post-save verification failed: title was not found in the content list and preview content did not meet the expected title/text/image thresholds.'
      );
    }

    if (publishExpectations.imageCount > 0 && !editorCheck.ok) {
      throw new Error('Post-save verification failed: reopened editor content did not contain the expected uploaded images.');
    }

    await sleep(3_000);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    cdp.close();
    const keepChromeOpen = Boolean(chrome && runError && !options.closeOnFailure);
    if (keepChromeOpen) {
      console.error(`[baijiahao] Keeping launched Chrome open for reuse. Profile: ${options.profileDir}`);
    } else if (chrome) {
      chrome.kill();
    }
  }
}

await main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
