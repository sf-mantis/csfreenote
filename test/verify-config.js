'use strict';

/**
 * Settings file: defaults, validation, and the one-time INI migration.
 *
 * Usage: node test/verify-config.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const cfg = require('../electron/config');

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

// Built with an explicit backslash so no layer of escaping can quietly eat it:
// The INI wrote note paths Windows-style, and that is the thing under test.
const BS = String.fromCharCode(92);

const LEGACY_INI = [
  '[DataDir1]',
  'Name=기본 폴더',
  `dir=C:${BS}노트${BS}BookData`,
  '[DataDir2]',
  'Name=업무',
  `dir=D:${BS}업무노트`,
  '[PROGRAM]',
  'fld_temp=0',
  'template=2',
  'Maximized=0',
  'Left=-80',
  'Top=62',
  'Width=1100',
  'Height=760',
  'TreeWidth=250',
  `lstPage=업무기록${BS}노트_01.htm`,
  'theme=light',
  '',
].join(String.fromCharCode(10));

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'csfreenote-cfg-'));

  console.log('■ 기본값');
  const base = cfg.defaults();
  ok('책이 하나 있음', base.books.length === 1 && base.books[0].dir === 'BookData');
  ok('상대 경로로 시작', !path.isAbsolute(base.books[0].dir));

  console.log('\n■ 손상된 값 교정');
  const fixed = cfg.normalise({
    books: [{ name: '  ', dir: 'X' }, { name: '없는 경로', dir: '   ' }, null],
    activeBook: 99,
    window: { width: 5, height: 'abc', left: null, top: 3, maximized: false },
    ui: { theme: '이상함', treeWidth: 9999, lastPage: 5 },
    editor: { autosaveMs: -1, startMode: '이상함' },
  });
  ok('이름 없는 책에 이름을 줌', fixed.books[0].name === '노트 폴더', fixed.books[0].name);
  ok('경로 없는 항목은 버림', fixed.books.length === 1, JSON.stringify(fixed.books));
  ok('activeBook 이 범위 안으로', fixed.activeBook === 0, String(fixed.activeBook));
  ok('창 크기가 최소값으로', fixed.window.width === 400, String(fixed.window.width));
  ok('숫자가 아니면 기본값', fixed.window.height === 800, String(fixed.window.height));
  ok('maximized=false 는 유지', fixed.window.maximized === false);
  ok('모르는 테마는 dark', fixed.ui.theme === 'dark');
  ok('트리 폭이 상한으로', fixed.ui.treeWidth === 480, String(fixed.ui.treeWidth));
  ok('lastPage 는 문자열', typeof fixed.ui.lastPage === 'string');
  ok('자동저장 간격이 하한으로', fixed.editor.autosaveMs === 300, String(fixed.editor.autosaveMs));
  ok('모르는 시작 모드는 browse', fixed.editor.startMode === 'browse');

  console.log('\n■ INI 이전');
  await fsp.writeFile(path.join(root, cfg.LEGACY_FILE_NAME), LEGACY_INI, 'utf8');
  const first = cfg.load(root);
  ok('이전이 일어남', first.migrated === true);
  ok('책 두 개를 모두 가져옴', first.config.books.length === 2,
    JSON.stringify(first.config.books));
  ok('책 이름 보존', first.config.books[1].name === '업무');
  ok('창 위치 보존', first.config.window.left === -80 && first.config.window.top === 62);
  ok('Maximized=0 이 false 로', first.config.window.maximized === false);
  ok('테마 보존', first.config.ui.theme === 'light');
  ok('경로 구분자가 / 로 바뀜',
    first.config.ui.lastPage === '업무기록/노트_01.htm', first.config.ui.lastPage);
  ok('JSON 파일이 생김', fs.existsSync(cfg.configPath(root)));
  ok('옛 INI 는 사라짐', !fs.existsSync(path.join(root, cfg.LEGACY_FILE_NAME)));

  const second = cfg.load(root);
  ok('두번째 실행은 이전하지 않음', second.migrated === false);
  ok('내용이 같음', JSON.stringify(second.config) === JSON.stringify(first.config));

  console.log('\n■ 손상된 JSON');
  await fsp.writeFile(cfg.configPath(root), '{ 망가진 json', 'utf8');
  const broken = cfg.load(root);
  ok('기본값으로 복구', broken.config.books.length === 1 && !!broken.recovered);
  ok('망가진 파일은 따로 보관', fs.existsSync(`${cfg.configPath(root)}.broken`));

  console.log('\n■ 경로 저장 방식');
  ok('앱 폴더 안이면 상대 경로',
    cfg.storedDir(root, path.join(root, 'BookData')) === 'BookData');
  ok('앱 폴더 밖이면 절대 경로',
    path.isAbsolute(cfg.storedDir(root, path.join(os.tmpdir(), '다른곳'))));
  ok('상대 경로가 다시 풀림',
    cfg.resolveDir(root, 'BookData') === path.join(root, 'BookData'));
  ok('절대 경로는 그대로',
    cfg.resolveDir(root, path.join(os.tmpdir(), 'X')) === path.join(os.tmpdir(), 'X'));

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  await fsp.rm(root, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
