'use strict';

/**
 * The source view must not throw away an edit the file refused.
 *
 * Pasting a whole document into source mode over a note that already has
 * content is refused by the write guard — rightly, the note's own words would
 * go. But the editor still held that document, and coming back to source mode
 * rebuilt the view from the file on disk, quietly replacing the pasted <head>
 * with the old one. The body was spliced back in, so the table stayed and only
 * its <style> disappeared.
 *
 * Usage: node test/verify-saving.js
 */

const path = require('path');
const { pathToFileURL } = require('url');

const doc = require('../electron/document');

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

/** A note as it sits on disk, and the document the user pastes over it. */
const ON_DISK = [
  '<!DOCTYPE html>', '<html><head><meta charset="utf-8">',
  '<style>p { margin: 0; }</style></head>',
  '<body>', '<p>원래 있던 글</p>', '</body></html>',
].join('\n');

const PASTED = [
  '<!DOCTYPE html>', '<html><head><meta charset="utf-8">',
  '<style>.custom-table th { background-color: #4f46e5; }</style></head>',
  '<body>', '<table class="custom-table"><tr><th>제목</th></tr></table>', '</body></html>',
].join('\n');

/**
 * The renderer, reduced to the moves this bug travels through.
 *
 * Only the source view's own decisions are the real thing — imported from
 * src/source-view.mjs. Everything else stands in for a mode button.
 */
function editor(diskHtml, { sourceBase, pendingDocument, refreshHeld }) {
  const state = {
    diskHtml, fullHtml: diskHtml, pendingDoc: null, dirty: false,
    mode: 'browse', text: '', frameBody: doc.extractBody(diskHtml),
  };

  return {
    state,

    /** Open source mode: the editor is rebuilt, with the live body spliced in. */
    toSource() {
      const base = sourceBase(state.diskHtml, state.pendingDoc);
      state.fullHtml = state.dirty ? doc.replaceBody(base, state.frameBody) : base;
      state.text = state.fullHtml;
      state.mode = 'source';
      return state.text;
    },

    /** Type in source mode. */
    type(text) { state.text = text; state.dirty = true; },

    /** Leave source mode: what was typed becomes the live document. */
    leaveSource(mode) {
      state.fullHtml = state.text;
      state.pendingDoc = pendingDocument(state.fullHtml, state.diskHtml);
      state.frameBody = doc.extractBody(state.fullHtml);
      state.mode = mode;
    },

    /** A save the write guard refused: the file does not move, the buffer stays dirty. */
    saveRefused() {},

    /** A source-mode save that landed: the whole document goes to the file. */
    saveOk() {
      state.diskHtml = state.text;
      state.pendingDoc = null;
      state.dirty = false;
    },

    /** An edit-mode save: only the body is written, so a held head is untouched. */
    saveBodyOk() {
      state.diskHtml = doc.replaceBody(state.diskHtml, state.frameBody);
      state.pendingDoc = refreshHeld(state.pendingDoc, state.frameBody, doc.replaceBody);
      state.dirty = false;
    },

    /** What leaving this note would throw away — what the dialog asks about. */
    held() {
      return state.mode === 'source'
        ? pendingDocument(state.text, state.diskHtml)
        : state.pendingDoc;
    },
  };
}

async function main() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'saving.mjs')).href;
  const view = await import(url);
  const {
    sourceBase, pendingDocument, refreshHeld,
    settledLabel, canForce, writeShape, HOLD, SAVED,
  } = view;
  ok('들고 있는 게 없으면 되살릴 것도 없다',
    refreshHeld(null, '<p>새 본문</p>', doc.replaceBody) === null);

  const hasStyle = (html, needle) => html.includes(needle);
  const INDIGO = '#4f46e5';
  const OLD = 'p { margin: 0; }';

  // --- the two decisions on their own -------------------------------------
  ok('없으면 디스크 문서를 쓴다', sourceBase('DISK', null) === 'DISK');
  ok('기다리는 수정이 있으면 그것을 쓴다', sourceBase('DISK', 'PENDING') === 'PENDING');
  ok('빈 문자열도 수정으로 친다 (?? 이지 || 가 아니다)', sourceBase('DISK', '') === '');
  ok('파일과 같아지면 들고 있지 않는다', pendingDocument('SAME', 'SAME') === null);
  ok('파일과 다르면 들고 있는다', pendingDocument('TYPED', 'DISK') === 'TYPED');

  // --- the sequence that lost the stylesheet -------------------------------
  const app = editor(ON_DISK, view);
  app.toSource();
  app.type(PASTED);
  app.saveRefused();

  app.leaveSource('edit');
  ok('편집 모드에서는 붙여넣은 스타일이 보인다',
    hasStyle(app.state.fullHtml, INDIGO));

  const back = app.toSource();
  ok('소스 모드로 돌아와도 스타일이 남아 있다',
    hasStyle(back, INDIGO), '디스크 문서로 다시 만들면서 head 가 버려졌다');
  ok('옛 스타일이 되돌아오지 않는다', !hasStyle(back, OLD));
  ok('본문도 그대로다', back.includes('custom-table'));

  // --- and the case the old code got right, which must still hold ----------
  const clean = editor(ON_DISK, view);
  clean.toSource();
  clean.type(PASTED);
  clean.saveOk();
  clean.leaveSource('edit');
  ok('저장이 끝나면 들고 있던 것을 놓는다', clean.state.pendingDoc === null);
  ok('저장 뒤 소스 모드는 파일을 보여준다', clean.toSource() === PASTED);

  // A note reloaded from disk starts clean — a held document from the note
  // before it would show the wrong file entirely.
  const reopened = editor(ON_DISK, view);
  reopened.toSource();
  reopened.type(PASTED);
  reopened.saveRefused();
  reopened.leaveSource('browse');
  ok('다른 노트를 열기 전에는 들고 있다', reopened.state.pendingDoc !== null);

  // --- an edit-mode save must not quietly drop the held head ---------------
  const typed = editor(ON_DISK, view);
  typed.toSource();
  typed.type(PASTED);
  typed.saveRefused();
  typed.leaveSource('edit');
  typed.state.frameBody =
    '<table class="custom-table"><tr><th>제목</th></tr></table><p>더 씀</p>';
  typed.state.dirty = true;
  typed.saveBodyOk();
  ok('본문만 저장해도 들고 있던 head 를 놓지 않는다', typed.state.pendingDoc !== null);
  ok('그 뒤 소스 모드에도 스타일이 있다', hasStyle(typed.toSource(), INDIGO));
  ok('이어 쓴 본문도 남아 있다', typed.state.fullHtml.includes('더 씀'));

  // Saving from there is how the head finally reaches the file — the body is
  // the real one by then, so the write guard has nothing to object to.
  typed.saveOk();
  ok('소스에서 저장이 끝나면 놓는다', typed.state.pendingDoc === null);

  // --- what the dialog asks about ------------------------------------------
  const asked = editor(ON_DISK, view);
  asked.toSource();
  ok('막 열었을 때는 물을 것이 없다', asked.held() === null);
  asked.type(PASTED);
  asked.saveRefused();
  ok('거부된 뒤에는 나가기 전에 묻는다', asked.held() !== null);
  asked.leaveSource('edit');
  ok('편집 모드로 옮겨도 여전히 묻는다', asked.held() !== null);
  asked.toSource();
  asked.saveOk();
  ok('저장이 끝나면 묻지 않는다', asked.held() === null);

  // --- what the status is allowed to claim ---------------------------------
  ok('파일이 다 받았으면 저장됨', settledLabel(null) === SAVED);
  ok('받지 않은 것이 남아 있으면 저장 보류', settledLabel('<html>보류</html>') === HOLD);

  // --- when the status can be pressed --------------------------------------
  ok('보류이고 이유를 알면 누를 수 있다', canForce(HOLD, '원본 구조가 사라집니다') === true);
  ok('이유를 모르면 누를 수 없다', canForce(HOLD, '') === false);
  ok('저장됨은 누를 것이 아니다', canForce(SAVED, '원본 구조가 사라집니다') === false);

  // --- which write a save makes --------------------------------------------
  const HELD = '<html>보류</html>';
  ok('편집 모드는 본문만 쓴다',
    writeShape({ mode: 'edit' }) === 'body');
  ok('소스 모드는 문서를 통째로 쓴다',
    writeShape({ mode: 'source' }) === 'document');
  ok('편집 모드에서 강제하면 들고 있던 문서를 쓴다',
    writeShape({ mode: 'edit', force: true, pendingDoc: HELD }) === 'held');
  ok('들고 있는 것이 없으면 강제해도 본문이다',
    writeShape({ mode: 'edit', force: true, pendingDoc: null }) === 'body');
  ok('소스 모드는 강제해도 편집 창 그대로다',
    writeShape({ mode: 'source', force: true, pendingDoc: HELD }) === 'document');

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
