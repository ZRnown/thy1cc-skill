import test from 'node:test';
import assert from 'node:assert/strict';

import { getChromeSpawnOptions, getChromeLaunchArgs } from './cdp.ts';

test('getChromeSpawnOptions detaches browser process for reuse', () => {
  const options = getChromeSpawnOptions();
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
});

test('getChromeLaunchArgs includes remote debug and profile arguments', () => {
  const args = getChromeLaunchArgs('https://mp.toutiao.com', 9222, '/tmp/toutiao-profile');
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--user-data-dir=/tmp/toutiao-profile'));
});
