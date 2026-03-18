import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('help output includes html/markdown/content upload flags', () => {
  const scriptPath = path.join(import.meta.dirname, 'toutiao-article.ts');
  const result = spawnSync('node', ['--experimental-strip-types', scriptPath, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /--html/);
  assert.match(output, /--markdown/);
  assert.match(output, /--content/);
  assert.match(output, /--title/);
});

test('source keeps the real image drawer and draft verification flow', () => {
  const scriptPath = path.join(import.meta.dirname, 'toutiao-article.ts');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.match(source, /profile_v4\/graphic\/publish/);
  assert.match(source, /\.mp-ic-img-drawer input\[type="file"\]\[accept\*="image"\]/);
  assert.match(source, /DOM\.setFileInputFiles/);
  assert.match(source, /placeholder\*="标题"/);
  assert.match(source, /草稿已保存/);
  assert.match(source, /creator_center\/draft_list/);
  assert.match(source, /继续编辑/);
});
