import { expect, test } from 'bun:test';
import {
  assertDeleteSafety,
  collectMetricRecord,
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
});

test('parseMetricValue supports chinese unit values', () => {
  expect(parseMetricValue('1.2万')).toBe(12000);
  expect(parseMetricValue('5,432')).toBe(5432);
  expect(parseMetricValue('--')).toBe(0);
});

test('collectMetricRecord maps read like collect share comment aliases', () => {
  const metrics = collectMetricRecord({
    阅读量: '1.2万',
    点赞: '210',
    收藏: '38',
    转发: '12',
    评论: '7',
  });

  expect(metrics.read).toBe(12000);
  expect(metrics.like).toBe(210);
  expect(metrics.collect).toBe(38);
  expect(metrics.share).toBe(12);
  expect(metrics.comment).toBe(7);
});

test('assertDeleteSafety rejects delete when confirm flag missing', () => {
  const parsed = parseManageArgs(['delete', '--article-id', '123']);
  expect(() => assertDeleteSafety(parsed)).toThrow('requires --confirm');
});

test('assertDeleteSafety rejects delete without explicit article target', () => {
  const parsed = parseManageArgs(['delete', '--confirm']);
  expect(() => assertDeleteSafety(parsed)).toThrow('requires --article-id or --nid');
});
