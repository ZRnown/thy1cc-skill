import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseManageArgs,
  normalizeMetricValue,
  extractMetricsFromText,
  isDeleteConfirmDialogTextSafe,
  validateDeleteArgs,
} from './toutiao-manage-parse.ts';

test('parseManageArgs parses list defaults', () => {
  const parsed = parseManageArgs(['list']);
  assert.equal(parsed.command, 'list');
  assert.equal(parsed.maxPages, 1);
  assert.equal(parsed.pageSizeHint, 20);
});

test('parseManageArgs parses get + delete identifiers', () => {
  const getParsed = parseManageArgs(['get', '--id', '12345']);
  assert.equal(getParsed.command, 'get');
  assert.equal(getParsed.id, '12345');

  const deleteParsed = parseManageArgs(['delete', '--title', '测试文章', '--confirm']);
  assert.equal(deleteParsed.command, 'delete');
  assert.equal(deleteParsed.title, '测试文章');
  assert.equal(deleteParsed.confirm, true);
});

test('parseManageArgs parses dry-run-delete flag', () => {
  const parsed = parseManageArgs(['delete', '--id', '12345', '--dry-run-delete']);
  assert.equal(parsed.command, 'delete');
  assert.equal(parsed.id, '12345');
  assert.equal(parsed.dryRunDelete, true);
  assert.equal(parsed.confirm, false);
});

test('normalizeMetricValue supports plain numbers and Chinese units', () => {
  assert.equal(normalizeMetricValue('1,203'), 1203);
  assert.equal(normalizeMetricValue('2.5万'), 25000);
  assert.equal(normalizeMetricValue('1.2亿'), 120000000);
});

test('extractMetricsFromText captures read/like/collect/share', () => {
  const text = '阅读 1.3万 点赞 265 收藏 71 转发 19 评论 12';
  const metrics = extractMetricsFromText(text);
  assert.equal(metrics.reads, 13000);
  assert.equal(metrics.likes, 265);
  assert.equal(metrics.collects, 71);
  assert.equal(metrics.shares, 19);
  assert.equal(metrics.comments, 12);
});

test('validateDeleteArgs requires explicit confirm and an identifier', () => {
  assert.throws(() => validateDeleteArgs({ command: 'delete', confirm: false, dryRunDelete: false }), /--confirm/);
  assert.throws(() => validateDeleteArgs({ command: 'delete', confirm: true, dryRunDelete: false }), /--id or --title/);
  assert.doesNotThrow(() => validateDeleteArgs({ command: 'delete', confirm: true, dryRunDelete: false, id: 'abc' }));
});

test('validateDeleteArgs allows dry-run-delete and rejects confirm conflict', () => {
  assert.doesNotThrow(() => validateDeleteArgs({ command: 'delete', confirm: false, dryRunDelete: true, id: 'abc' }));
  assert.throws(
    () => validateDeleteArgs({ command: 'delete', confirm: true, dryRunDelete: true, id: 'abc' }),
    /cannot be combined/
  );
});

test('isDeleteConfirmDialogTextSafe accepts live Toutiao delete prompt', () => {
  assert.equal(isDeleteConfirmDialogTextSafe('确定删除此内容？ 内容删除后将无法恢复，请慎重考虑 取消 确定'), true);
  assert.equal(isDeleteConfirmDialogTextSafe('作品分享设置 取消'), false);
});
