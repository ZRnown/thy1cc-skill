export type ManageCommand = 'list' | 'get' | 'delete';

export interface ManageOptions {
  command: ManageCommand;
  help: boolean;
  id?: string;
  title?: string;
  confirm: boolean;
  dryRunDelete: boolean;
  maxPages: number;
  pageSizeHint: number;
  cdpPort?: number;
  profileDir?: string;
  listUrl?: string;
  slowMs: number;
  json: boolean;
}

export interface ArticleMetrics {
  reads: number | null;
  likes: number | null;
  collects: number | null;
  shares: number | null;
  comments: number | null;
}

export interface ListArticleItem {
  id: string;
  title: string;
  status: string;
  publishedAt: string;
  url: string;
  rowText: string;
}

export interface ListPageSnapshot {
  page: number;
  pageUrl: string;
  pageTitle: string;
  items: ListArticleItem[];
}
