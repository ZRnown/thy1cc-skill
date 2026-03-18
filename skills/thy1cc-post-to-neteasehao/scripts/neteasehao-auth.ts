import type { ChromeSession } from './cdp.ts';
import { evaluate } from './cdp.ts';

export interface NeteasehaoPageState {
  url: string;
  bodyText: string;
  currentUser?: any;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasLoggedOutText(bodyText: string): boolean {
  const text = normalize(bodyText);
  if (!text) return false;

  const markers = [
    '扫码登录',
    '登录网易号',
    '请登录',
    '安全验证',
    '验证码',
  ];
  return markers.some((marker) => text.includes(marker.toLowerCase()));
}

function hasLoggedInDashboardText(bodyText: string): boolean {
  const text = normalize(bodyText);
  if (!text) return false;

  const markers = [
    '内容管理',
    '数据分析',
    '文章管理',
    '粉丝',
    '收益',
  ];
  const hits = markers.filter((marker) => text.includes(marker.toLowerCase()));
  return hits.length >= 2;
}

export function isNeteasehaoSessionLoggedIn(state: NeteasehaoPageState): boolean {
  if (state.currentUser && typeof state.currentUser === 'object') {
    if (state.currentUser.uid || state.currentUser.id || state.currentUser.name || state.currentUser.nickname) return true;
  }
  if (hasLoggedInDashboardText(state.bodyText || '')) return true;
  if (hasLoggedOutText(state.bodyText || '')) return false;

  const url = state.url || '';
  if (url.includes('mp.163.com') && !url.includes('/login')) return true;
  return false;
}

export async function getNeteasehaoPageState(session: ChromeSession): Promise<NeteasehaoPageState> {
  return await evaluate<NeteasehaoPageState>(session, `
    (async function() {
      let currentUser = null;
      try {
        const resp = await fetch('/api/uc/userinfo', {
          credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        currentUser = await resp.json();
      } catch (error) {
        currentUser = { error: String(error) };
      }
      return {
        url: window.location.href,
        bodyText: document.body?.innerText || '',
        currentUser,
      };
    })()
  `);
}
