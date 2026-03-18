import { expect, test } from 'bun:test';
import {
  assertDeleteSafety,
  collectMetricRecord,
  extractMetricRecordFromText,
  isDeleteConfirmDialogTextSafe,
  isListHydrated,
  parseManageArgs,
  parseMetricValue,
} from './baijiahao-manage-parse.ts';

test('parseManageArgs resolves list defaults and accepts pagination flags', () => {
  const parsed = parseManageArgs(['list', '--max-pages', '3', '--page-size', '20', '--search', '测试']);
  expect(parsed.command).toBe('list');
  expect(parsed.maxPages).toBe(3);
  expect(parsed.pageSize).toBe(20);
  expect(parsed.search).toBe('测试');
  expect(parsed.confirm).toBe(false);
  expect(parsed.dryRunDelete).toBe(false);
});

test('parseManageArgs accepts dry-run-delete for delete command', () => {
  const parsed = parseManageArgs(['delete', '--nid', '1859', '--dry-run-delete']);
  expect(parsed.command).toBe('delete');
  expect(parsed.nid).toBe('1859');
  expect(parsed.confirm).toBe(false);
  expect(parsed.dryRunDelete).toBe(true);
});

test('parseMetricValue supports chinese unit values', () => {
  expect(parseMetricValue('1.2万')).toBe(12000);
  expect(parseMetricValue('5,432')).toBe(5432);
  expect(parseMetricValue('--')).toBe(0);
});

test('collectMetricRecord maps read like collect share comment aliases', () => {
  const metrics = collectMetricRecord({
    阅读量: '1.2万',
    点赞量: '210',
    收藏量: '38',
    分享量: '12',
    评论量: '7',
  });

  expect(metrics.read).toBe(12000);
  expect(metrics.like).toBe(210);
  expect(metrics.collect).toBe(38);
  expect(metrics.share).toBe(12);
  expect(metrics.comment).toBe(7);
});

test('extractMetricRecordFromText parses detail drawer metrics', () => {
  const metrics = extractMetricRecordFromText(`
    观看分析
    阅读量 0
    互动分析
    点赞量 1
    评论量 0
    收藏量 2
    分享量 3
    转发量 4
  `);

  expect(metrics.read).toBe(0);
  expect(metrics.like).toBe(1);
  expect(metrics.collect).toBe(2);
  expect(metrics.share).toBe(4);
  expect(metrics.comment).toBe(0);
});

test('assertDeleteSafety rejects delete when confirm flag missing', () => {
  const parsed = parseManageArgs(['delete', '--article-id', '123']);
  expect(() => assertDeleteSafety(parsed)).toThrow('requires --confirm or --dry-run-delete');
});

test('assertDeleteSafety rejects delete without explicit article target', () => {
  const parsed = parseManageArgs(['delete', '--confirm']);
  expect(() => assertDeleteSafety(parsed)).toThrow('requires --article-id or --nid');
});

test('assertDeleteSafety rejects confirm and dry-run-delete together', () => {
  const parsed = parseManageArgs(['delete', '--confirm', '--dry-run-delete', '--article-id', '123']);
  expect(() => assertDeleteSafety(parsed)).toThrow('cannot be used together');
});

test('isDeleteConfirmDialogTextSafe accepts live Baijiahao delete prompt', () => {
  expect(isDeleteConfirmDialogTextSafe('提示 您删除的内容无法恢复，确认删除？ 取消 确定')).toBe(true);
  expect(isDeleteConfirmDialogTextSafe('登录已失效，请重新登录')).toBe(false);
});

test('isListHydrated waits for article links or sufficiently hydrated body text', () => {
  expect(isListHydrated({
    url: 'https://baijiahao.baidu.com/',
    bodyLength: 270,
    anchorCount: 2,
    articleLinkCount: 0,
    hasListWord: true,
    hasContentCount: false,
    hasStatusTabs: false,
    hasActionText: false,
  })).toBe(false);

  expect(isListHydrated({
    url: 'https://baijiahao.baidu.com/builder/rc/content?currentPage=1',
    bodyLength: 1310,
    anchorCount: 21,
    articleLinkCount: 8,
    hasListWord: true,
    hasContentCount: true,
    hasStatusTabs: true,
    hasActionText: true,
  })).toBe(true);
});

test('isListHydrated rejects the homepage even when it contains latest-work snippets', () => {
  expect(isListHydrated({
    url: 'https://baijiahao.baidu.com/',
    bodyLength: 1515,
    anchorCount: 31,
    articleLinkCount: 0,
    hasListWord: true,
    hasContentCount: false,
    hasStatusTabs: false,
    hasActionText: false,
  })).toBe(false);
});
