import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMetricsFromText, parseManageCommand } from './neteasehao-manage-parse.ts';

test('parseManageCommand parses list defaults', () => {
  const parsed = parseManageCommand(['list']);
  assert.equal(parsed.mode, 'list');
  assert.equal(parsed.maxPages, 1);
  assert.equal(parsed.slowMs, 1200);
});

test('parseManageCommand requires --confirm or --dry-run-delete for delete', () => {
  assert.throws(() => parseManageCommand(['delete', '--article-id', '123']));
});

test('parseManageCommand accepts --dry-run-delete for delete mode', () => {
  const parsed = parseManageCommand(['delete', '--article-id', '123', '--dry-run-delete']);
  assert.equal(parsed.mode, 'delete');
  assert.equal(parsed.articleId, '123');
  assert.equal(parsed.dryRunDelete, true);
  assert.equal(parsed.confirm, false);
});

test('parseManageCommand rejects using --confirm with --dry-run-delete together', () => {
  assert.throws(
    () => parseManageCommand(['delete', '--article-id', '123', '--confirm', '--dry-run-delete']),
    /cannot be used together/i,
  );
});

test('extractMetricsFromText extracts canonical metrics', () => {
  const metrics = extractMetricsFromText('阅读 1.2万 点赞 345 收藏 67 转发 8 评论 9');
  assert.equal(metrics.read, 12000);
  assert.equal(metrics.like, 345);
  assert.equal(metrics.favorite, 67);
  assert.equal(metrics.share, 8);
  assert.equal(metrics.comment, 9);
});
