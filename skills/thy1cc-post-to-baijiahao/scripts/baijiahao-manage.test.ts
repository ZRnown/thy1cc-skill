import { expect, test } from 'bun:test';
import path from 'node:path';

test('help output documents list get delete and confirmation guard', () => {
  const scriptPath = path.join(import.meta.dir, 'baijiahao-manage.ts');
  const result = Bun.spawnSync([
    'bun',
    scriptPath,
    '--help',
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(result.exitCode).toBe(0);
  const output = `${Buffer.from(result.stdout).toString()}${Buffer.from(result.stderr).toString()}`;
  expect(output).toContain('list');
  expect(output).toContain('get');
  expect(output).toContain('delete');
  expect(output).toContain('--confirm');
});
