'use strict';

/**
 * Stands in for electron/preload.js so the real renderer can be driven in a
 * test: same API surface, but every call is recorded instead of touching disk.
 */

// The real preload shares this with the renderer so the source view shows
// what a save would write. Use the same function here, not a copy.
const { breakBlocks } = require('../../electron/document');

const tree = {
  root: 'C:/book',
  name: '책',
  children: [
    { type: 'folder', name: '폴더A', relative: '폴더A',
      marker: '폴더A/___cs_free_note__folder.html', children: [
      { type: 'note', name: '안쪽노트', fileName: '안쪽노트.html', relative: '폴더A/안쪽노트.html' },
      { type: 'folder', name: '하위', relative: '폴더A/하위', children: [] },
    ] },
    { type: 'folder', name: '폴더B', relative: '폴더B', marker: null, children: [] },
    { type: 'note', name: '루트노트', fileName: '루트노트.html', relative: '루트노트.html' },
  ],
};

window.__doc = '<html><head><title>t</title></head><body>\n<table bgcolor="#3c62c6"><tr><td><font color="#ffffff">머리글</font></td></tr></table>\n<p>처음</p>\n</body></html>';
window.__mtime = 1;
window.__files = [];

function makeFormats() {
  const blank = {
    label: '', font: '', size: 0, color: '', highlight: '',
    bold: null, italic: null, underline: null, align: '',
  };
  const presets = [
    { label: '본문', font: '맑은 고딕', size: 3, color: '#222222', bold: false },
    { label: '작게', size: 2 }, { label: '크게', size: 5 },
    { label: '굵게', bold: true }, { label: '파랑 강조', color: '#3c62c6', bold: true },
    { label: '빨강 강조', color: '#a33333', bold: true },
    { label: '형광펜', highlight: '#fff2a8' },
    { label: '가운데', align: 'center' }, { label: '오른쪽', align: 'right' },
  ];
  return presets.map((p) => ({ ...blank, ...p }));
}
window.__formats = makeFormats();

const calls = [];
const record = (name, result) => (payload) => {
  calls.push({ name, payload });
  return Promise.resolve(typeof result === 'function' ? result(payload) : result);
};

window.__calls = calls;
window.csNote = {
  getConfig: () => Promise.resolve({
    Name: '책', theme: 'dark', TreeWidth: 260, lstPage: '',
    startMode: 'browse', autosaveMs: 700, returnToBrowse: true, searchWholeBook: false,
    dateFormat: 'yyyy-mm-dd hh:nn',
  }),
  setConfig: record('setConfig', {}),
  chooseBookDir: record('chooseBookDir', 'C:/새폴더'),
  getTree: () => Promise.resolve(tree),
  listTemplates: () => Promise.resolve(['기본 양식', '노트 양식']),
  // A tiny in-memory book, so a save really changes what a later read sees.
  readNote: (relativePath) => Promise.resolve({
    relativePath, html: window.__doc, body: '<p>처음</p>',
    encoding: relativePath === '폴더A/안쪽노트.html' ? 'euc-kr' : 'utf-8',
    mtime: window.__mtime, bytes: window.__doc.length, baseUrl: '',
  }),
  breakBlocks: (bodyInner) => breakBlocks(bodyInner),
  writeNote: (payload) => {
    calls.push({ name: 'writeNote', payload });
    window.__doc = payload.fullDocument
      ? payload.html
      : window.__doc.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/i,
        (m, open, close) => open + '\n' + String(payload.body).trim() + '\n' + close);
    window.__mtime += 1;
    return Promise.resolve({
      ok: true, html: window.__doc,
      bytes: window.__doc.length, mtime: window.__mtime,
    });
  },
  createNote: record('createNote', { ok: true, relativePath: 'new.html' }),
  createFolder: record('createFolder', { ok: true, relativePath: 'newdir' }),
  describeFolder: record('describeFolder',
    { ok: true, relativePath: '폴더B/___cs_free_note__folder.html' }),
  renameItem: record('renameItem', { ok: true, relativePath: 'renamed.html' }),
  deleteItem: record('deleteItem', { ok: true }),
  moveItem: record('moveItem', { ok: true, relativePath: 'moved.html' }),
  saveImage: record('saveImage', { href: '../_images/a.png', fileName: 'a.png' }),
    // Files a note carries. An in-memory drawer, so a note can be given one
    // and the panel has something real to draw.
    listAttachments: () => Promise.resolve(window.__files || []),
    addAttachments: record('addAttachments', { ok: true, added: [] }),
    removeAttachment: record('removeAttachment', { ok: true }),
    openAttachment: record('openAttachment', { ok: true }),
    appVersion: () => Promise.resolve('0.0.0-test'),
    saveNotePdf: record('saveNotePdf', { ok: true, saved: true }),
    openSavedPdf: record('openSavedPdf', { ok: true }),
    openNoteLink: record('openNoteLink', { ok: true }),
    attachmentRef: ({ name }) => Promise.resolve({
      name,
      href: '_files/노트/' + name,
      image: /.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name),
      preview: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    }),
  searchNotes: (payload) => {
    calls.push({ name: 'searchNotes', payload });
    const q = String(payload.query || '').toLowerCase();
    const all = [
      { relativePath: '루트노트.html', name: '루트노트', snippet: '…모듈 개선…' },
      { relativePath: '폴더A/안쪽노트.html', name: '안쪽노트', snippet: '…품질 모듈…' },
    ];
    return Promise.resolve(q ? all.filter((r) => r.snippet.includes(q) || r.name.includes(q)) : []);
  },
  showInFolder: record('showInFolder', undefined),
  openExternal: record('openExternal', undefined),
  listBooks: () => Promise.resolve({
    books: [
      { name: '기본 폴더', dir: 'BookData', shared: false, path: 'C:/book', missing: false },
      { name: '업무', dir: 'D:/업무', shared: false, path: 'D:/업무', missing: false },
      { name: '사라진 폴더', dir: 'E:/없음', shared: false, path: 'E:/없음', missing: true },
    ],
    active: 0,
  }),
  selectBook: (index) => {
    calls.push({ name: 'selectBook', payload: index });
    return Promise.resolve({ ok: true });
  },
  saveBook: record('saveBook', { ok: true, index: 0 }),
  removeBook: record('removeBook', { ok: true, active: 0 }),
  reorderBooks: record('reorderBooks', { ok: true, active: 0 }),
  getSettings: () => Promise.resolve({
    books: [], activeBook: 0,
    window: { startAs: 'restore', minimizeToTray: false },
    ui: { theme: 'dark', treeWidth: 260, lastPage: '', searchWholeBook: false },
    editor: {
      autosaveMs: 700, startMode: 'browse', template: '기본 양식',
      returnToBrowse: true, dateFormat: 'yyyy-mm-dd hh:nn',
    },
    formats: window.__formats,
  }),
  saveSettings: (patch) => {
    calls.push({ name: 'saveSettings', payload: patch });
    if (patch && 'formats' in patch) {
      window.__formats = patch.formats === null ? makeFormats() : patch.formats;
    }
    return Promise.resolve({
      window: {
        startAs: patch?.window?.startAs ?? 'restore',
        minimizeToTray: patch?.window?.minimizeToTray ?? false,
      },
      ui: {
        theme: 'dark', treeWidth: 260, lastPage: '',
        searchWholeBook: patch?.ui?.searchWholeBook ?? false,
      },
      editor: {
        autosaveMs: patch?.editor?.autosaveMs ?? 700,
        startMode: patch?.editor?.startMode ?? 'browse',
        template: '기본 양식',
        returnToBrowse: patch?.editor?.returnToBrowse ?? true,
        dateFormat: patch?.editor?.dateFormat ?? 'yyyy-mm-dd hh:nn',
      },
      formats: window.__formats,
    });
  },
  onFlushRequest: () => {},
  flushComplete: () => {},
};
