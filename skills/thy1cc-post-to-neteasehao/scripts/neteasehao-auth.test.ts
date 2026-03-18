import assert from 'node:assert/strict';
import test from 'node:test';
import { isNeteasehaoSessionLoggedIn } from './neteasehao-auth.ts';

test('isNeteasehaoSessionLoggedIn returns true for dashboard markers', () => {
  const loggedIn = isNeteasehaoSessionLoggedIn({
    url: 'https://mp.163.com/index',
    bodyText: '内容管理 数据分析 文章管理 粉丝',
  });
  assert.equal(loggedIn, true);
});

test('isNeteasehaoSessionLoggedIn returns false for login markers', () => {
  const loggedIn = isNeteasehaoSessionLoggedIn({
    url: 'https://mp.163.com/login',
    bodyText: '扫码登录 安全验证',
  });
  assert.equal(loggedIn, false);
});
