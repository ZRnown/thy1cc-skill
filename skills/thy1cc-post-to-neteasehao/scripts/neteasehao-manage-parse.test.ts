import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMetricsFromText, parseManageCommand } from './neteasehao-manage-parse.ts';

test('parseManageCommand parses list defaults', () => {
  const parsed = parseManageCommand(['list']);
  assert.equal(parsed.mode, 'list');
  assert.equal(parsed.maxPages, 1);
  assert.equal(parsed.slowMs, 1200);
});

test('parseManageCommand requires --confirm for delete', () => {
  assert.throws(() => parseManageCommand(['delete', '--article-id', '123']));
});

test('extractMetricsFromText extracts canonical metrics', () => {
  const metrics = extractMetricsFromText('阅读 1.2万 点赞 345 收藏 67 转发 8 评论 9');
  assert.equal(metrics.read, 12000);
  assert.equal(metrics.like, 345);
  assert.equal(metrics.favorite, 67);
  assert.equal(metrics.share, 8);
  assert.equal(metrics.comment, 9);
});
