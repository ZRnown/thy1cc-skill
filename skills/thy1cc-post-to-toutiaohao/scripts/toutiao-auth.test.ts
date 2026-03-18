import test from 'node:test';
import assert from 'node:assert/strict';

import { isToutiaoSessionLoggedIn, isAccountPayloadLoggedIn } from './toutiao-auth.ts';

test('isAccountPayloadLoggedIn handles common logged-in payloads', () => {
  assert.equal(isAccountPayloadLoggedIn({ code: 0, data: { user_id: '1001' } }), true);
  assert.equal(isAccountPayloadLoggedIn({ code: 401 }), false);
});

test('isToutiaoSessionLoggedIn recognizes dashboard markers', () => {
  const ok = isToutiaoSessionLoggedIn({
    url: 'https://mp.toutiao.com/profile_v4/index',
    bodyText: '发布 内容管理 数据中心 粉丝 用户设置',
    accountInfo: null,
  });
  assert.equal(ok, true);
});

test('isToutiaoSessionLoggedIn treats scan-login page as logged out', () => {
  const ok = isToutiaoSessionLoggedIn({
    url: 'https://mp.toutiao.com/auth/page/login',
    bodyText: '扫码登录 今日头条创作平台',
    accountInfo: null,
  });
  assert.equal(ok, false);
});
