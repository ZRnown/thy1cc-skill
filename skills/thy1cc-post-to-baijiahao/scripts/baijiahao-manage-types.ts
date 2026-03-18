export type ManageCommand = 'list' | 'get' | 'delete';

export interface ArticleMetrics {
  read: number;
  like: number;
  collect: number;
  share: number;
  comment: number;
}

export interface BaijiahaoArticleItem {
  title: string;
  status: string;
  publishedAt: string;
  articleId: string;
  nid: string;
  url: string;
  pageUrl: string;
  rowText: string;
  metricText: Record<string, string>;
}

export interface ManageOptions {
  command: ManageCommand;
  articleId: string;
  nid: string;
  search: string;
  status: string;
  maxPages: number;
  pageSize: number;
  cdpPort?: number;
  profileDir: string;
  confirm: boolean;
  dryRunDelete: boolean;
  slowMs: number;
}
