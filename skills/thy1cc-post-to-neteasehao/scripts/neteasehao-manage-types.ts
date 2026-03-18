export type ManageMode = 'list' | 'get' | 'delete';

export interface NeteasehaoArticleSummary {
  articleId: string;
  title: string;
  status: string;
  updatedAt: string;
  url: string;
  rawText: string;
}

export interface NeteasehaoMetrics {
  read: number | null;
  like: number | null;
  favorite: number | null;
  share: number | null;
  comment: number | null;
}

interface ManageCommonOptions {
  mode: ManageMode;
  cdpPort?: number;
  profileDir?: string;
  maxPages: number;
  slowMs: number;
}

export interface ListCommandOptions extends ManageCommonOptions {
  mode: 'list';
}

export interface GetCommandOptions extends ManageCommonOptions {
  mode: 'get';
  articleId?: string;
  title?: string;
  url?: string;
}

export interface DeleteCommandOptions extends ManageCommonOptions {
  mode: 'delete';
  articleId?: string;
  title?: string;
  confirm: boolean;
}

export type ManageCommandOptions = ListCommandOptions | GetCommandOptions | DeleteCommandOptions;
