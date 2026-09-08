'use strict';

/**
 * Call every IPC handler the app exposes, for real.
 *
 * A missing function is not a syntax error: main.js parsed fine while
 * item:delete referred to a helper that a refactor had removed, and it only
 * showed up as a raw IPC error when someone deleted a note. Loading the real
 * main.js and invoking each channel is the only thing that catches that.
 *
 * The app is pointed at a throwaway book, so nothing outside it is touched.
 *
 * Usage: npx electron test/verify-ipc.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain } = require('electron');

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

/** Invoke a handler the way ipcRenderer.invoke would. */
async function call(channel, ...args) {
  const handler = ipcMain._invokeHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args);
}

async function checked(name, channel, ...args) {
  try {
    const result = await call(channel, ...args);
    ok(name, true);
    return result;
  } catch (err) {
    ok(name, false, String(err && err.message ? err.message : err));
    return null;
  }
}

const NOTE = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
  + '<body><p>내용</p></body></html>';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csfreenote-ipc-'));
  const book = path.join(root, 'BookData');
  fs.mkdirSync(path.join(book, '폴더'), { recursive: true });
  fs.mkdirSync(path.join(root, 'csTemplate'), { recursive: true });
  fs.writeFileSync(path.join(book, '노트.html'), NOTE, 'utf8');
  fs.writeFileSync(path.join(book, '폴더', '안쪽.html'), NOTE, 'utf8');
  fs.writeFileSync(path.join(root, 'csTemplate', '기본 양식.html'), NOTE, 'utf8');

  // main.js resolves its data root from the executable's folder unless this is
  // set, which is how a portable build finds the folder it was put in.
  process.env.PORTABLE_EXECUTABLE_DIR = root;
  Object.defineProperty(app, 'isPackaged', { get: () => true });

  require('../electron/main.js');
  await app.whenReady();
  await new Promise((r) => setTimeout(r, 400));

  console.log(`책: ${book}\n`);
  console.log('■ 설정');
  const config = await checked('config:get', 'config:get');
  ok('책 경로가 잡힘', config && path.resolve(config.dir) === path.resolve(book),
    config && config.dir);
  await checked('config:set', 'config:set', { TreeWidth: 300 });
  await checked('settings:get', 'settings:get');
  await checked('settings:save', 'settings:save', { editor: { autosaveMs: 900 } });

  console.log('\n■ 책 목록');
  await checked('book:list', 'book:list');
  await checked('book:select', 'book:select', 0);
  const added = await checked('book:save', 'book:save',
    { index: -1, name: '두번째', dir: book, shared: false });
  ok('책이 추가됨', added && added.ok === true, JSON.stringify(added));
  await checked('book:reorder', 'book:reorder', { from: 1, to: 0 });
  await checked('book:remove', 'book:remove', 0);
  await checked('book:getTree', 'book:getTree');

  console.log('\n■ 노트');
  const created = await checked('note:create', 'note:create',
    { parentRelative: '폴더', title: '새 노트' });
  ok('노트가 만들어짐', created && created.relativePath, JSON.stringify(created));

  // An empty <p> lays out at zero height: nothing to click, nowhere to put the
  // caret. The templates were fixed for this; the bodies the app writes itself
  // — a note asked for with no template, a folder description — were not.
  const blank = await checked('note:create (빈 노트)', 'note:create',
    { parentRelative: '폴더', title: '빈 노트', templateName: '' });
  const blankHtml = fs.readFileSync(path.join(book, blank.relativePath), 'utf8');
  ok('양식 없이 만든 노트의 빈 줄에 커서 자리가 있음',
    !/<p>\s*<\/p>/.test(blankHtml) && blankHtml.includes('<p><br></p>'),
    JSON.stringify(blankHtml.slice(blankHtml.indexOf('<body'), blankHtml.indexOf('<body') + 110)));

  const read = await checked('note:read', 'note:read', '노트.html');
  ok('노트를 읽음', read && read.html.includes('내용'));

  const written = await checked('note:write', 'note:write', {
    relativePath: '노트.html', body: '<p>바뀐 내용</p>',
    encoding: 'utf-8', baseMtime: read && read.mtime,
  });
  ok('노트가 저장됨', written && written.ok === true, JSON.stringify(written));

  console.log('\n■ 정리');
  await checked('folder:create', 'folder:create', { parentRelative: '', name: '새 폴더' });
  const renamed = await checked('item:rename', 'item:rename',
    { relativePath: '노트.html', newName: '이름 바꾼 노트', isFolder: false });
  ok('이름이 바뀜', renamed && renamed.ok === true, JSON.stringify(renamed));

  const moved = await checked('item:move', 'item:move',
    { relativePath: '이름 바꾼 노트.html', targetFolder: '폴더' });
  ok('이동함', moved && moved.ok === true, JSON.stringify(moved));

  // The bug this suite exists for: delete referred to a helper that was gone.
  const deleted = await checked('item:delete', 'item:delete', '폴더/안쪽.html'
    ? { relativePath: '폴더/안쪽.html' } : {});
  ok('삭제가 성공을 돌려줌', deleted && deleted.ok === true, JSON.stringify(deleted));
  ok('파일이 사라짐', !fs.existsSync(path.join(book, '폴더', '안쪽.html')));

  const again = await checked('item:delete (이미 없는 것)', 'item:delete',
    { relativePath: '폴더/안쪽.html' });
  ok('두 번째 삭제도 오류가 아님', again && again.ok === true, JSON.stringify(again));

  const described = await checked('folder:describe', 'folder:describe',
    { relativePath: '폴더' });
  ok('폴더 설명이 만들어짐',
    described && described.ok === true
    && fs.existsSync(path.join(book, '폴더', '___cs_free_note__folder.html')),
    JSON.stringify(described));
  const markerHtml = fs.readFileSync(
    path.join(book, '폴더', '___cs_free_note__folder.html'), 'utf8');
  ok('폴더 설명의 빈 줄에도 커서 자리가 있음',
    !/<p>\s*<\/p>/.test(markerHtml) && markerHtml.includes('<p><br></p>'),
    markerHtml.slice(markerHtml.indexOf('<body'), markerHtml.indexOf('<body') + 90));

  const againDescribe = await checked('folder:describe (이미 있음)', 'folder:describe',
    { relativePath: '폴더' });
  ok('이미 있으면 그것을 돌려줌',
    againDescribe && described && againDescribe.relativePath === described.relativePath,
    JSON.stringify(againDescribe));

  const tree = await call('book:getTree');
  const folderNode = tree.children.find((n) => n.type === 'folder' && n.name === '폴더');
  ok('트리가 폴더 마커를 알려줌', folderNode && !!folderNode.marker,
    JSON.stringify(folderNode && folderNode.marker));
  ok('마커는 노트 목록에 없음',
    folderNode && !(folderNode.children || []).some((c) => c.name.startsWith('___')),
    JSON.stringify(folderNode && (folderNode.children || []).map((c) => c.name)));


  console.log('\n■ 검색과 기타');
  const hits = await checked('search:notes', 'search:notes',
    { query: '내용', scopeRelative: '' });
  ok('검색이 결과를 냄', Array.isArray(hits), JSON.stringify(hits));
  await checked('template:list', 'template:list');
  await checked('image:save', 'image:save', {
    relativePath: '폴더/안쪽.html', mimeType: 'image/png',
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await checked('shell:openExternal (무시되는 값)', 'shell:openExternal', 'not-a-url');

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
