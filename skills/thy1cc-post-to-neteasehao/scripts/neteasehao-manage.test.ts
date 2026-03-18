import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('manage script help includes list/get/delete and confirm guard', () => {
  const scriptPath = path.join(import.meta.dirname, 'neteasehao-manage.ts');
  const result = spawnSync('node', ['--experimental-strip-types', scriptPath, '--help'], {
    cwd: import.meta.dirname,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /list/);
  assert.match(output, /get/);
  assert.match(output, /delete/);
  assert.match(output, /--confirm/);
});
