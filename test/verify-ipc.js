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
const { app, ipcMain, shell, dialog } = require('electron');

// One channel's whole job is to open a browser. Hold that back so the suite
// stays true to "npm test does not touch the machine", and record that it was
// asked -- being asked is the thing worth checking.
const opened = [];
shell.openExternal = async (url) => { opened.push(url); };

// Saving a PDF asks where to put it, and nothing here could answer that box.
// The chooser is held back and told to answer with a path in the throwaway
// folder, so the writing itself still happens for real.
let pdfTarget = null;
function holdBackTheSaveBox(target) {
  pdfTarget = target;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdfTarget });
}


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
  ok('무시되는 값은 브라우저를 열지 않음', opened.length === 0, JSON.stringify(opened));

  await checked('app:openReleases', 'app:openReleases');
  ok('받는 곳 하나만 열림', opened.length === 1, JSON.stringify(opened));
  ok('받는 곳은 이 저장소의 releases',
    opened[0] === 'https://github.com/sf-mantis/csfreenote/releases/latest', opened[0]);

  const version = await call('app:version');
  ok('실제 도는 판을 알려줌', /^[0-9]+[.][0-9]+[.][0-9]+/.test(String(version)), String(version));

  // 앞 단계들이 노트를 옮기고 이름을 바꿔 놓았으므로, 내보낼 것은 여기서 새로
  // 놓는다. 없는 노트를 내보내면 아무 일도 일어나지 않는데, 그것을 통과로
  // 읽으면 이 검사는 아무것도 지키지 못한다.
  fs.writeFileSync(path.join(book, 'PDF로 만들 노트.html'), NOTE, 'utf8');
  const pdfPath = path.join(root, '만든 것.pdf');
  holdBackTheSaveBox(pdfPath);

  const made = await checked('note:pdf', 'note:pdf', { relativePath: 'PDF로 만들 노트.html' });
  ok('PDF 저장이 받아들여짐', made && made.ok === true && made.saved === true,
    JSON.stringify(made));
  ok('파일이 실제로 생김', fs.existsSync(pdfPath));
  // %PDF is what every reader looks for; a zero-length file would pass a
  // bare existsSync and open as nothing.
  ok('진짜 PDF 임',
    fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).subarray(0, 4).toString() === '%PDF',
    fs.existsSync(pdfPath) ? String(fs.statSync(pdfPath).size) + ' bytes' : '(없음)');

  const noNote = await call('note:pdf', { relativePath: '없는노트.html' });
  ok('없는 노트는 내보내지 않고 알린다', noNote && noNote.ok === false, JSON.stringify(noNote));

  // 저장 위치를 묻다 그만두면 파일도 만들지 않고 실패도 아니다.
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  const stopped = await call('note:pdf', { relativePath: 'PDF로 만들 노트.html' });
  ok('그만두면 실패가 아니다', stopped && stopped.ok === true && stopped.saved === false,
    JSON.stringify(stopped));

  // 본문이 가리키는 파일을 여는 길. 노트책 밖은 열지 않는다는 것이 핵심이다.
  const opened2 = [];
  shell.openPath = async (target) => { opened2.push(target); return ''; };

  fs.mkdirSync(path.join(book, '_files', 'PDF로 만들 노트'), { recursive: true });
  fs.writeFileSync(path.join(book, '_files', 'PDF로 만들 노트', '붙임.txt'), 'x', 'utf8');
  const followed = await checked('note:openLink', 'note:openLink', {
    relativePath: 'PDF로 만들 노트.html',
    href: '_files/PDF%EB%A1%9C%20%EB%A7%8C%EB%93%A4%20%EB%85%B8%ED%8A%B8/%EB%B6%99%EC%9E%84.txt',
  });
  ok('붙임 링크를 연다', followed && followed.ok === true && opened2.length === 1,
    JSON.stringify(followed));
  ok('연 것이 그 파일이다', /붙임\.txt$/.test(opened2[0] || ''), opened2[0]);

  const escaped = await call('note:openLink',
    { relativePath: 'PDF로 만들 노트.html', href: '../../../Windows/System32/notepad.exe' });
  ok('노트책 밖은 열지 않는다', escaped && escaped.ok === false, JSON.stringify(escaped));
  const scheme = await call('note:openLink',
    { relativePath: 'PDF로 만들 노트.html', href: 'file:///C:/Windows/notepad.exe' });
  ok('스킴이 붙은 링크도 열지 않는다', scheme && scheme.ok === false, JSON.stringify(scheme));
  ok('거절한 것은 열리지 않았다', opened2.length === 1, String(opened2.length));

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
