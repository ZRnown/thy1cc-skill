import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
});
