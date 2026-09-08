'use strict';

/**
 * Search behaviour and its cache.
 *
 * Usage: node test/verify-search.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createSearchIndex, plainText } = require('../electron/search');

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

const doc = (body) => `<!DOCTYPE html><html><head><style>p{color:red}</style></head>`
  + `<body>${body}</body></html>`;

async function run() {
  const book = await fsp.mkdtemp(path.join(os.tmpdir(), 'csfreenote-search-'));
  const hiddenDirs = new Set(['_backup', '_images']);
  const index = createSearchIndex({ hiddenDirs });

  await fsp.mkdir(path.join(book, '폴더'), { recursive: true });
  await fsp.mkdir(path.join(book, '_backup', '폴더'), { recursive: true });
  await fsp.mkdir(path.join(book, '_images'), { recursive: true });

  await fsp.writeFile(path.join(book, '첫 노트.html'),
    doc('<p>품질 모듈 개선 계획</p>'), 'utf8');
  await fsp.writeFile(path.join(book, '폴더', '둘째.html'),
    doc('<table><tr><td>생산 <b>모듈</b> 점검</td></tr></table>'), 'utf8');
  await fsp.writeFile(path.join(book, '폴더', '___cs_free_note__folder.html'),
    doc('<p>폴더 설명</p>'), 'utf8');
  await fsp.writeFile(path.join(book, '_backup', '폴더', '둘째.html'),
    doc('<p>옛날 모듈 내용</p>'), 'utf8');

  console.log('■ 본문 추출');
  ok('태그가 제거됨', plainText('<p>가 <b>나</b></p>') === '가 나');
  ok('style 내용은 본문이 아님',
    !plainText('<style>p{color:red}</style><p>본문</p>').includes('color'));
  ok('nbsp 는 공백으로', plainText('<p>가&nbsp;나</p>') === '가 나');

  console.log('\n■ 검색');
  let found = await index.search(book, { query: '모듈' });
  ok('본문에서 찾음', found.length === 2, JSON.stringify(found.map((f) => f.relativePath)));
  ok('태그를 건너뛰고 찾음',
    found.some((f) => f.relativePath === '폴더/둘째.html'),
    JSON.stringify(found));
  ok('발췌를 함께 돌려줌', found.every((f) => f.snippet.includes('모듈')),
    JSON.stringify(found.map((f) => f.snippet)));

  found = await index.search(book, { query: '첫' });
  ok('파일 이름으로도 찾음', found.length === 1 && found[0].relativePath === '첫 노트.html',
    JSON.stringify(found));

  found = await index.search(book, { query: '모듈', scopeRelative: '폴더' });
  ok('폴더로 범위를 좁힘', found.length === 1 && found[0].relativePath === '폴더/둘째.html',
    JSON.stringify(found));

  found = await index.search(book, { query: '옛날' });
  ok('백업 폴더는 검색하지 않음', found.length === 0, JSON.stringify(found));

  found = await index.search(book, { query: '폴더 설명' });
  ok('폴더 마커는 검색하지 않음', found.length === 0, JSON.stringify(found));

  ok('빈 검색어는 빈 결과', (await index.search(book, { query: '   ' })).length === 0);

  console.log('\n■ 캐시');
  index.clear();
  await index.search(book, { query: '모듈' });
  const cold = index.stats();
  await index.search(book, { query: '점검' });
  const warm = index.stats();
  // Two notes are searchable: the folder marker and the backup copy are not.
  ok('첫 검색은 파일을 읽음', cold.misses === 2 && cold.hits === 0, JSON.stringify(cold));
  ok('검색 대상만 캐시됨', cold.entries === 2, JSON.stringify(cold));
  ok('두번째 검색은 캐시를 씀', warm.misses === cold.misses && warm.hits > 0,
    JSON.stringify(warm));

  // A note that changes must not keep answering with its old text.
  await fsp.writeFile(path.join(book, '첫 노트.html'),
    doc('<p>완전히 다른 내용</p>'), 'utf8');
  found = await index.search(book, { query: '품질' });
  ok('파일이 바뀌면 캐시가 갱신됨', found.length === 0, JSON.stringify(found));
  found = await index.search(book, { query: '완전히' });
  ok('새 내용으로 찾힘', found.length === 1, JSON.stringify(found));

  // Explicit invalidation, the path the app uses after a save.
  const before = index.stats().entries;
  index.invalidate(path.join(book, '첫 노트.html'));
  ok('invalidate 가 항목을 지움', index.stats().entries === before - 1,
    `${before} → ${index.stats().entries}`);

  index.invalidate(path.join(book, '폴더'));
  ok('폴더 invalidate 가 하위까지 지움', index.stats().entries === 0,
    JSON.stringify(index.stats()));

  // Deleting outside the app should not leave the note in results.
  await fsp.rm(path.join(book, '폴더', '둘째.html'));
  found = await index.search(book, { query: '점검' });
  ok('앱 밖에서 지운 노트는 결과에서 사라짐', found.length === 0, JSON.stringify(found));

  console.log('\n■ 취소');
  const signal = { cancelled: true };
  const cancelled = await index.search(book, { query: '완전히', signal });
  ok('취소된 검색은 빈 결과', cancelled.length === 0, JSON.stringify(cancelled));

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  await fsp.rm(book, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
