'use strict';

/**
 * The update check must be quiet when it is wrong and right when it speaks.
 *
 * It reaches the network in the app, so nothing here does: the fetch is
 * handed in. What is checked is the judgement — which answers count as a new
 * version, and that every kind of failure comes back as silence rather than
 * as a message to someone who was writing.
 *
 * Usage: node test/verify-update.js
 */

const updates = require('../electron/update');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const feed = (over = {}) => JSON.stringify({
  tag_name: 'v1.4.0', draft: false, prerelease: false, ...over,
});

async function main() {
  const { parseVersion, compareVersions, readFeed, checkForUpdate } = updates;

  // --- reading a version ---------------------------------------------------
  ok('v 접두사를 읽는다', String(parseVersion('v1.3.0')) === '1,3,0');
  ok('접두사가 없어도 읽는다', String(parseVersion('1.3.0')) === '1,3,0');
  ok('버전이 아니면 null', parseVersion('latest') === null);
  ok('빈 값도 null', parseVersion('') === null && parseVersion(null) === null);
  ok('뒤에 붙은 것은 무시', String(parseVersion('v2.0.1-beta.3')) === '2,0,1');

  // --- comparing ------------------------------------------------------------
  ok('작은 자리도 비교한다', compareVersions([1, 3, 1], [1, 3, 0]) === 1);
  ok('가운데 자리', compareVersions([1, 4, 0], [1, 3, 9]) === 1);
  ok('앞자리가 이긴다', compareVersions([2, 0, 0], [1, 99, 99]) === 1);
  ok('같으면 0', compareVersions([1, 3, 0], [1, 3, 0]) === 0);
  ok('10 을 문자로 비교하지 않는다', compareVersions([1, 10, 0], [1, 9, 0]) === 1);
  ok('읽히지 않는 쪽은 언제나 옛것', compareVersions(null, [0, 0, 1]) === -1);

  // --- what the feed is allowed to say --------------------------------------
  ok('새 판이면 알린다', readFeed(feed(), '1.3.0')?.version === '1.4.0');
  ok('같은 판이면 조용', readFeed(feed({ tag_name: 'v1.3.0' }), '1.3.0') === null);
  ok('옛 판이면 조용', readFeed(feed({ tag_name: 'v1.2.0' }), '1.3.0') === null);
  ok('초안은 알리지 않는다', readFeed(feed({ draft: true }), '1.3.0') === null);
  ok('미리보기판도 알리지 않는다', readFeed(feed({ prerelease: true }), '1.3.0') === null);
  ok('태그가 버전이 아니면 조용', readFeed(feed({ tag_name: 'nightly' }), '1.3.0') === null);
  ok('JSON 이 아니면 조용', readFeed('<html>502</html>', '1.3.0') === null);
  ok('빈 응답도 조용', readFeed('', '1.3.0') === null);
  ok('배열이 와도 버티다', readFeed('[]', '1.3.0') === null);
  ok('null 이 와도 버티다', readFeed('null', '1.3.0') === null);

  // 되돌려주는 것은 버전 하나뿐이다. 피드가 실어 보낸 나머지는 아무것도
  // 따라오지 않는다 — 그중 하나라도 링크로 쓰이면 그것이 곧 구멍이다.
  const found = readFeed(feed({ html_url: 'https://evil.example/x', body: 'x'.repeat(99) }), '1.3.0');
  ok('버전 말고는 아무것도 돌려주지 않는다',
    found && Object.keys(found).join() === 'version', JSON.stringify(found));

  // --- 실패는 전부 침묵이다 --------------------------------------------------
  const nothing = [
    ['응답이 없으면', () => Promise.reject(new Error('ENOTFOUND'))],
    ['시간이 다 되면', () => Promise.reject(new Error('timeout'))],
    ['응답이 너무 크면', () => Promise.reject(new Error('too large'))],
    ['500 이 오면', () => Promise.reject(new Error('HTTP 500'))],
    ['쓰레기가 오면', () => Promise.resolve('not json at all')],
    ['던지는 fetch 여도', () => { throw new Error('boom'); }],
  ];
  for (const [name, fetch] of nothing) {
    /* eslint-disable no-await-in-loop */
    ok(`${name} 아무 말도 하지 않는다`,
      (await checkForUpdate('1.3.0', { fetch })) === null);
  }
  ok('새 판이면 그때만 말한다',
    (await checkForUpdate('1.3.0', { fetch: () => Promise.resolve(feed()) }))?.version === '1.4.0');

  // --- 사람을 보내는 곳은 상수다 ---------------------------------------------
  ok('받는 곳은 이 저장소의 releases 다',
    updates.RELEASES_PAGE === 'https://github.com/sf-mantis/csfreenote/releases/latest');
  ok('받는 곳은 https 다', updates.RELEASES_PAGE.startsWith('https://'));
  ok('피드도 https 다', updates.FEED.startsWith('https://api.github.com/'));

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
