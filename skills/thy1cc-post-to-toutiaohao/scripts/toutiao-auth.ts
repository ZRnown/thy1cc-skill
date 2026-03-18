import type { ChromeSession } from './cdp.ts';
import { evaluate } from './cdp.ts';

export interface ToutiaoPageState {
  url: string;
  bodyText: string;
  accountInfo: any | null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasLoggedOutText(bodyText: string): boolean {
  const text = normalize(bodyText);
  if (!text) return false;

  const markers = [
    '扫码登录',
    '手机登录',
    '验证码登录',
    '短信登录',
    '登录创作平台',
    '立即登录',
  ];

  return markers.some((marker) => text.includes(marker));
}

function hasLoggedInDashboardText(bodyText: string): boolean {
  const text = normalize(bodyText);
  if (!text) return false;

  const markers = [
    '发布',
    '内容管理',
    '数据中心',
    '创作',
    '粉丝',
    '收益',
  ];

  return markers.filter((marker) => text.includes(marker)).length >= 2;
}

export function isAccountPayloadLoggedIn(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return false;

  if (payload.code === 401 || payload.code === 403) return false;
  if (payload.code === 0) {
    const data = payload.data;
    if (data && typeof data === 'object') {
      if (data.user_id || data.userId || data.uid || data.screen_name || data.name) return true;
    }
  }

  if (payload.user_id || payload.userId || payload.uid) return true;
  return false;
}

export async function getToutiaoPageState(session: ChromeSession): Promise<ToutiaoPageState> {
  return await evaluate<ToutiaoPageState>(session, `
    (async function() {
      let accountInfo = null;
      try {
        const response = await fetch('/api/pc/account/info', {
          credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*' }
        });
        accountInfo = await response.json();
      } catch (error) {
        accountInfo = { error: String(error) };
      }

      return {
        url: window.location.href,
        bodyText: document.body?.innerText || '',
        accountInfo,
      };
    })()
  `);
}

export function isToutiaoSessionLoggedIn(state: ToutiaoPageState): boolean {
  if (isAccountPayloadLoggedIn(state.accountInfo)) return true;
  if (hasLoggedInDashboardText(state.bodyText || '')) return true;
  if (hasLoggedOutText(state.bodyText || '')) return false;

  const url = state.url || '';
  if (url.includes('mp.toutiao.com') && !url.includes('/login') && !url.includes('/auth/page/login')) return true;
  return false;
}
