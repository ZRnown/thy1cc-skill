import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

test('help output includes list/get/delete and confirm safety flag', () => {
  const scriptPath = path.join(import.meta.dirname, 'toutiao-manage.ts');
  const result = spawnSync('node', ['--experimental-strip-types', scriptPath, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /\blist\b/);
  assert.match(output, /\bget\b/);
  assert.match(output, /\bdelete\b/);
  assert.match(output, /--confirm/);
  assert.match(output, /--dry-run-delete/);
});

test('source targets the current content-management route and card selectors', () => {
  const scriptPath = path.join(import.meta.dirname, 'toutiao-manage.ts');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /https:\/\/mp\.toutiao\.com\/profile_v4\/manage\/content\/all/);
  assert.match(source, /\.genre-item\.genre-item-in-all-tab/);
  assert.match(source, /\.article-card/);
  assert.match(source, /isDeleteConfirmDialogTextSafe/);
  assert.match(source, /waitForDeleteConfirmDialog/);
  assert.match(source, /dialog\.querySelectorAll\('button, a, \[role="button"\], span, div'\)/);
  assert.match(source, /删除作品/);
  assert.doesNotMatch(source, /确定删除此内容/);
  assert.match(source, /if \(options\.dryRunDelete\)/);
  assert.match(source, /dry-run-delete/);
});
