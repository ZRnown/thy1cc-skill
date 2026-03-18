import type { ArticleMetrics, ManageCommand, ManageOptions } from './toutiao-manage-types.ts';

function toPositiveInt(input: string, flag: string): number {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${flag}: ${input}`);
  }
  return value;
}

function parseCommand(value: string | undefined): ManageCommand {
  if (value === 'list' || value === 'get' || value === 'delete') return value;
  throw new Error(`Unknown command: ${value || '(empty)'}. Expected one of: list, get, delete.`);
}

export function parseManageArgs(argv: string[]): ManageOptions {
  const first = argv[0];
  const hasExplicitCommand = first === 'list' || first === 'get' || first === 'delete';
  const command = hasExplicitCommand ? parseCommand(first) : 'list';
  const options: ManageOptions = {
    command,
    help: false,
    confirm: false,
    maxPages: 1,
    pageSizeHint: 20,
    slowMs: 2200,
    json: true,
  };

  const startIndex = hasExplicitCommand ? 1 : 0;
  for (let i = startIndex; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--id':
        options.id = argv[++i];
        break;
      case '--title':
        options.title = argv[++i];
        break;
      case '--confirm':
        options.confirm = true;
        break;
      case '--max-pages':
        options.maxPages = toPositiveInt(argv[++i], '--max-pages');
        break;
      case '--page-size-hint':
        options.pageSizeHint = toPositiveInt(argv[++i], '--page-size-hint');
        break;
      case '--cdp-port':
        options.cdpPort = toPositiveInt(argv[++i], '--cdp-port');
        break;
      case '--profile-dir':
        options.profileDir = argv[++i];
        break;
      case '--list-url':
        options.listUrl = argv[++i];
        break;
      case '--slow-ms':
        options.slowMs = toPositiveInt(argv[++i], '--slow-ms');
        break;
      case '--json':
        options.json = true;
        break;
      case '--text':
        options.json = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.command === 'list' && options.maxPages > 10) {
    throw new Error('For safety, --max-pages must be <= 10.');
  }

  return options;
}

export function normalizeMetricValue(raw: string): number {
  const text = String(raw || '').trim().replace(/[,\s]/g, '');
  if (!text) return 0;

  const matched = text.match(/([0-9]+(?:\.[0-9]+)?)(万|亿)?/);
  if (!matched) return 0;

  const base = Number.parseFloat(matched[1] || '0');
  if (!Number.isFinite(base)) return 0;

  const unit = matched[2];
  if (unit === '万') return Math.round(base * 10_000);
  if (unit === '亿') return Math.round(base * 100_000_000);
  return Math.round(base);
}

function extractMetricByLabels(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*([0-9,.]+(?:\\.[0-9]+)?(?:万|亿)?)`);
    const matched = text.match(pattern);
    if (matched && matched[1]) return normalizeMetricValue(matched[1]);
  }
  return null;
}

export function extractMetricsFromText(text: string): ArticleMetrics {
  const safeText = String(text || '').replace(/\s+/g, ' ');
  return {
    reads: extractMetricByLabels(safeText, ['阅读', '阅读量', '播放', '播放量', '展现']),
    likes: extractMetricByLabels(safeText, ['点赞', '赞同']),
    collects: extractMetricByLabels(safeText, ['收藏']),
    shares: extractMetricByLabels(safeText, ['转发', '分享']),
    comments: extractMetricByLabels(safeText, ['评论']),
  };
}

export function validateDeleteArgs(options: Pick<ManageOptions, 'command' | 'confirm' | 'id' | 'title'>): void {
  if (options.command !== 'delete') return;
  if (!options.confirm) throw new Error('Delete is blocked. Re-run with --confirm after manual check.');
  if (!options.id && !options.title) throw new Error('Delete requires --id or --title to target exactly one article.');
}
