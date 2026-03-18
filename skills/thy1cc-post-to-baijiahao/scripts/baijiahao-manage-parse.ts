import type { ArticleMetrics, ManageCommand, ManageOptions } from './baijiahao-manage-types.ts';

export const METRIC_LABELS = ['阅读量', '阅读', '点赞量', '点赞', '收藏量', '收藏', '转发量', '转发', '分享量', '分享', '评论量', '评论'] as const;

function parsePositiveInt(value: string, flag: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

export function parseManageArgs(argv: string[]): ManageOptions {
  if (!argv.length) {
    throw new Error('Missing command: list | get | delete');
  }

  const command = argv[0] as ManageCommand;
  if (command !== 'list' && command !== 'get' && command !== 'delete') {
    throw new Error(`Unsupported command: ${argv[0]}`);
  }

  const options: ManageOptions = {
    command,
    articleId: '',
    nid: '',
    search: '',
    status: 'all',
    maxPages: 3,
    pageSize: 10,
    profileDir: '',
    confirm: false,
    slowMs: 1600,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--article-id':
        options.articleId = argv[++i] || '';
        break;
      case '--nid':
        options.nid = argv[++i] || '';
        break;
      case '--search':
        options.search = argv[++i] || '';
        break;
      case '--status':
        options.status = (argv[++i] || '').trim() || 'all';
        break;
      case '--max-pages':
        options.maxPages = parsePositiveInt(argv[++i] || '', '--max-pages');
        break;
      case '--page-size':
        options.pageSize = parsePositiveInt(argv[++i] || '', '--page-size');
        break;
      case '--profile-dir':
        options.profileDir = argv[++i] || '';
        break;
      case '--cdp-port':
        options.cdpPort = parsePositiveInt(argv[++i] || '', '--cdp-port');
        break;
      case '--slow-ms':
        options.slowMs = parsePositiveInt(argv[++i] || '', '--slow-ms');
        break;
      case '--confirm':
        options.confirm = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function assertDeleteSafety(options: ManageOptions): void {
  if (options.command !== 'delete') return;
  if (!options.confirm) {
    throw new Error('Delete command requires --confirm.');
  }
  if (!options.articleId && !options.nid) {
    throw new Error('Delete command requires --article-id or --nid.');
  }
}

export function parseMetricValue(input: string | number | undefined | null): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return 0;
    return Math.max(0, Math.floor(input));
  }

  const raw = String(input || '').trim();
  if (!raw || raw === '--' || raw === '-') return 0;
  const compact = raw.replace(/[,\s]/g, '');

  const yiMatch = compact.match(/^(\d+(?:\.\d+)?)亿$/);
  if (yiMatch) {
    return Math.max(0, Math.round(parseFloat(yiMatch[1]!) * 100000000));
  }

  const wanMatch = compact.match(/^(\d+(?:\.\d+)?)万$/);
  if (wanMatch) {
    return Math.max(0, Math.round(parseFloat(wanMatch[1]!) * 10000));
  }

  const plain = parseFloat(compact);
  if (!Number.isFinite(plain)) return 0;
  return Math.max(0, Math.round(plain));
}

function readAlias(record: Record<string, string | number | undefined>, aliases: string[]): number {
  for (const alias of aliases) {
    if (alias in record) return parseMetricValue(record[alias]);
  }
  return 0;
}

export function collectMetricRecord(record: Record<string, string | number | undefined>): ArticleMetrics {
  return {
    read: readAlias(record, ['read', 'reads', 'view', 'views', '阅读', '阅读量']),
    like: readAlias(record, ['like', 'likes', '点赞', '点赞量']),
    collect: readAlias(record, ['collect', 'favorite', 'favorites', '收藏', '收藏量']),
    share: readAlias(record, ['share', 'shares', '转发', '转发量', '分享', '分享量']),
    comment: readAlias(record, ['comment', 'comments', '评论', '评论量']),
  };
}

export function extractMetricMapFromText(input: string): Record<string, string> {
  const output: Record<string, string> = {};
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) return output;

  for (const label of METRIC_LABELS) {
    const pattern = new RegExp(label + '\\s*[:：]?\\s*([0-9][0-9,.]*(?:\\.[0-9]+)?(?:万|亿)?)');
    const match = text.match(pattern);
    if (match) output[label] = String(match[1] || '').trim();
  }

  return output;
}

export function extractMetricRecordFromText(input: string): ArticleMetrics {
  return collectMetricRecord(extractMetricMapFromText(input));
}

export function isDeleteConfirmDialogTextSafe(input: string): boolean {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const hasDeleteIntent = text.includes('删除');
  const hasRiskNotice = text.includes('无法恢复') || text.includes('确认删除');
  const hasConfirmAction = text.includes('确定');
  return hasDeleteIntent && hasRiskNotice && hasConfirmAction;
}

export function isListHydrated(snapshot: {
  url: string;
  bodyLength: number;
  anchorCount: number;
  articleLinkCount: number;
  hasListWord: boolean;
  hasContentCount: boolean;
  hasStatusTabs: boolean;
  hasActionText: boolean;
}): boolean {
  if (!snapshot.url.includes('/builder/rc/content')) return false;
  if (snapshot.articleLinkCount >= 3) return true;
  if (snapshot.hasContentCount && snapshot.hasStatusTabs && snapshot.hasActionText) return true;
  if (snapshot.hasListWord && snapshot.hasContentCount && snapshot.bodyLength >= 600) return true;
  if (snapshot.hasStatusTabs && snapshot.anchorCount >= 8 && snapshot.bodyLength >= 1000) return true;
  return false;
}
