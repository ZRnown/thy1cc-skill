import type { ManageCommandOptions, NeteasehaoMetrics } from './neteasehao-manage-types.ts';

const DEFAULT_MAX_PAGES = 1;
const DEFAULT_SLOW_MS = 1200;

function toInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCountToken(raw: string): number | null {
  const value = raw.trim().replace(/,/g, '');
  if (!value) return null;

  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)(万|亿|k|K)?$/);
  if (!match) return null;

  const base = Number.parseFloat(match[1] || '0');
  const unit = match[2] || '';
  if (!Number.isFinite(base)) return null;

  if (unit === '万') return Math.round(base * 10_000);
  if (unit === '亿') return Math.round(base * 100_000_000);
  if (unit.toLowerCase() === 'k') return Math.round(base * 1_000);
  return Math.round(base);
}

function pickMetric(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[：:]?\\s*([0-9]+(?:\\.[0-9]+)?(?:万|亿|k|K)?)`, 'i');
    const matched = text.match(pattern);
    if (matched?.[1]) {
      const parsed = parseCountToken(matched[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

export function extractMetricsFromText(text: string): NeteasehaoMetrics {
  const normalized = text.replace(/\s+/g, ' ');
  return {
    read: pickMetric(normalized, ['阅读', '阅读量', '浏览', '浏览量']),
    like: pickMetric(normalized, ['点赞', '赞']),
    favorite: pickMetric(normalized, ['收藏']),
    share: pickMetric(normalized, ['转发', '分享']),
    comment: pickMetric(normalized, ['评论']),
  };
}

export function parseManageCommand(argv: string[]): ManageCommandOptions {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    return {
      mode: 'list',
      maxPages: DEFAULT_MAX_PAGES,
      slowMs: DEFAULT_SLOW_MS,
    };
  }

  const mode = argv[0];
  if (mode !== 'list' && mode !== 'get' && mode !== 'delete') {
    throw new Error(`Unknown mode: ${mode}`);
  }

  let cdpPort: number | undefined;
  let profileDir: string | undefined;
  let maxPages = DEFAULT_MAX_PAGES;
  let slowMs = DEFAULT_SLOW_MS;
  let articleId: string | undefined;
  let title: string | undefined;
  let url: string | undefined;
  let confirm = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--cdp-port':
        cdpPort = toInt(argv[++i]);
        break;
      case '--profile-dir':
        profileDir = argv[++i];
        break;
      case '--max-pages':
        maxPages = Math.max(1, toInt(argv[++i]) || DEFAULT_MAX_PAGES);
        break;
      case '--slow-ms':
        slowMs = Math.max(300, toInt(argv[++i]) || DEFAULT_SLOW_MS);
        break;
      case '--article-id':
        articleId = argv[++i];
        break;
      case '--title':
        title = argv[++i];
        break;
      case '--url':
        url = argv[++i];
        break;
      case '--confirm':
        confirm = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (mode === 'list') {
    return { mode, cdpPort, profileDir, maxPages, slowMs };
  }

  if (mode === 'get') {
    if (!articleId && !title && !url) {
      throw new Error('get mode requires at least one of --article-id, --title, --url');
    }
    return { mode, cdpPort, profileDir, maxPages, slowMs, articleId, title, url };
  }

  if (!articleId && !title) {
    throw new Error('delete mode requires --article-id or --title');
  }
  if (!confirm) {
    throw new Error('delete mode requires explicit --confirm');
  }

  return { mode, cdpPort, profileDir, maxPages, slowMs, articleId, title, confirm };
}
