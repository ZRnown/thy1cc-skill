import { expect, test } from 'bun:test';
import fs from 'node:fs';
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

test('source scopes Baijiahao delete confirm to dialog safety checks', () => {
  const scriptPath = path.join(import.meta.dir, 'baijiahao-manage.ts');
  const source = fs.readFileSync(scriptPath, 'utf-8');

  expect(source).toContain('isDeleteConfirmDialogTextSafe');
  expect(source).toContain('Unsafe delete dialog state detected; aborting without confirm.');
  expect(source).toContain('[role="dialog"]');
  expect(source).toContain("Array.from(dialog.querySelectorAll('button,a,[role=\"button\"],span,div'))");
  expect(source).toContain("textOf(node) === '确定'");
});
