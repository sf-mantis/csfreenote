import { darkNoteCss } from './dark-note.mjs';
import { formatDateTime, DEFAULT_FORMAT } from './datetime.mjs';
import {
  sourceBase, pendingDocument, refreshHeld,
  settledLabel, canForce, writeShape, HOLD,
} from './saving.mjs';

import './styles.css';

/* ------------------------------------------------------------------ *
 * Document helpers
 *
 * These mirror electron/document.js, which is the authority — the copy here
 * only builds the preview shown in source mode. Every real write is spliced
 * in the main process against the file as it is on disk.
 * ------------------------------------------------------------------ */

const BODY_RE = /(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i;

/**
 * Editor output as it would be written.
 *
 * Chromium serialises siblings with nothing between them, so the source view
 * would show one endless line for anything typed since the last save. The
 * write path breaks those apart; borrow the same function so the preview and
 * the file agree.
 */
function formatBody(bodyInner) {
  const text = String(bodyInner ?? '').trim();
  return api.breakBlocks ? api.breakBlocks(text) : text;
}

function spliceBody(originalDoc, newBodyInner) {
  const source = String(originalDoc);
  const match = source.match(BODY_RE);
  if (!match) return source;
  const [full, openTag, , closeTag] = match;
  return (
    source.slice(0, match.index) +
    openTag +
    `\n${formatBody(newBodyInner)}\n` +
    closeTag +
    source.slice(match.index + full.length)
  );
}

const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const api = window.csNote;

const state = {
  config: null,
  tree: null,
  mode: 'browse',
  currentPath: null,
  encoding: 'utf-8',
  mtime: 0,
  bytes: 0,
  baseUrl: '',
  diskHtml: '',
  fullHtml: '',
  // A whole-document edit the file has not taken yet — a refused save, or
  // source-mode work not written out. Source mode rebuilds its view from the
  // file on disk, which would otherwise drop this without a word.
  pendingDoc: null,
  // Why the last write was turned away, kept so the status can offer to force
  // it and say what would go.
  holdMessage: '',
  dirty: false,
  saving: false,
  selectedFolder: '',
  expanded: new Set(),
  sidebarHidden: false,
  dragging: null,
  noteSurface: 'paper',
  folderTitle: '',
  autosaveMs: 700,
  formats: [],
  startMode: 'browse',
  returnToBrowse: true,
  tableEditing: false,
  searchWholeBook: false,
  dateFormat: DEFAULT_FORMAT,
  templates: [],
  saveTimer: null,
  pastePlain: false,
  lastSavedBody: '',
  suppressChange: false,
};

const el = {
  body: document.body,
  sidebar: document.getElementById('sidebar'),
  tree: document.getElementById('tree'),
  resizeHandle: document.getElementById('resizeHandle'),
  emptyState: document.getElementById('emptyState'),
  editorRoot: document.getElementById('editorRoot'),
  frame: document.getElementById('noteFrame'),
  sourceEditor: document.getElementById('sourceEditor'),
  noteTitle: document.getElementById('noteTitle'),
  notePath: document.getElementById('notePath'),
  saveStatus: document.getElementById('saveStatus'),
  findBar: document.getElementById('findBar'),
  sourceMark: document.getElementById('sourceMark'),
  findInput: document.getElementById('findInput'),
  findCount: document.getElementById('findCount'),
  replaceInput: document.getElementById('replaceInput'),
  replaceOne: document.getElementById('replaceOne'),
  replaceAll: document.getElementById('replaceAll'),
  attachPanel: document.getElementById('attachPanel'),
  attachToggle: document.getElementById('attachToggle'),
  attachTitle: document.getElementById('attachTitle'),
  attachChevron: document.getElementById('attachChevron'),
  attachBody: document.getElementById('attachBody'),
  attachPreview: document.getElementById('attachPreview'),
  attachImage: document.getElementById('attachImage'),
  attachKind: document.getElementById('attachKind'),
  attachList: document.getElementById('attachList'),
  attachInsert: document.getElementById('attachInsert'),
  attachInsertLeft: document.getElementById('attachInsertLeft'),
  attachInsertRight: document.getElementById('attachInsertRight'),
  attachAdd: document.getElementById('attachAdd'),
  attachRemove: document.getElementById('attachRemove'),
  formatBar: document.getElementById('formatBar'),
  tableHandles: document.getElementById('tableHandles'),
  rowInsert: document.getElementById('rowInsert'),
  colInsert: document.getElementById('colInsert'),
  rowRemove: document.getElementById('rowRemove'),
  colRemove: document.getElementById('colRemove'),
  colGrip: document.getElementById('colGrip'),
  tableGrid: document.getElementById('tableGrid'),
  tableGridCells: document.getElementById('tableGridCells'),
  tableGridLabel: document.getElementById('tableGridLabel'),
  bookDir: document.getElementById('btnBookDir'),
  searchPanel: document.getElementById('searchPanel'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  btnShowTree: document.getElementById('btnShowTree'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  modalInput: document.getElementById('modalInput'),
  statusPath: document.getElementById('statusPath'),
  statusMeta: document.getElementById('statusMeta'),
  settings: document.getElementById('settings'),
  bookList: document.getElementById('bookList'),
};

let frameDoc = null;

// The empty state is rewritten to describe a folder, so its original markup
// has to be kept to put back.
const emptyStateMarkup = el.emptyState ? el.emptyState.innerHTML : '';

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

function setStatus(kind, text) {
  el.saveStatus.className = `save-status ${kind || ''}`;
  el.saveStatus.textContent = text;
  // One status can be acted on. The file turned a write away, and this is the
  // only door back — without it the work can only be abandoned.
  const forceable = canForce(text, state.holdMessage);
  el.saveStatus.classList.toggle('actionable', forceable);
  el.saveStatus.setAttribute('role', forceable ? 'button' : 'status');
  el.saveStatus.tabIndex = forceable ? 0 : -1;
  el.saveStatus.title = forceable ? '눌러서 그래도 저장' : '';
}

/* ------------------------------------------------------------------ *
 * Status bar
 * ------------------------------------------------------------------ */


function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const when = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = new Date().toDateString() === when.toDateString();
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (sameDay) return `오늘 ${time}`;
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

function renderStatusBar() {
  if (!el.statusPath) return;

  if (!state.currentPath) {
    const root = state.tree?.root || '';
    el.statusPath.textContent = state.config?.Name || state.tree?.name || '';
    el.statusPath.title = root;
    el.statusMeta.textContent = countNotes(state.tree?.children || []) > 0
      ? `노트 ${countNotes(state.tree?.children || [])}개`
      : '';
    return;
  }

  el.statusPath.textContent = state.currentPath;
  el.statusPath.title = state.currentPath;

  const parts = [formatWhen(state.mtime), formatBytes(state.bytes)].filter(Boolean);
  el.statusMeta.textContent = parts.join('  ·  ');

}

function countNotes(nodes) {
  let total = 0;
  for (const node of nodes) {
    if (node.type === 'note') total += 1;
    else if (node.children) total += countNotes(node.children);
  }
  return total;
}

let toastTimer = null;

/**
 * Failures used to reach only the console, which no one could open.
 *
 * `action` adds a button — used to undo a move, where the cost of a stray drag
 * is not that the note is damaged but that it is somewhere the user did not
 * look.
 */
function showToast(message, kind = 'error', action = null) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.className = `toast ${kind}`;
  toast.textContent = '';

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      toast.classList.add('hidden');
      Promise.resolve(action.run()).catch((err) => {
        console.error(err);
        showToast(err?.message || String(err));
      });
    });
    toast.appendChild(button);
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), action ? 12000 : 8000);
  toast.classList.remove('hidden');
}

function scheduleSave(delay = state.autosaveMs) {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  setStatus('saving', '저장 대기…');
  state.saveTimer = setTimeout(() => {
    save();
  }, delay);
}

/** Say where the file actually stands — see settledLabel in saving.mjs. */
function settledStatus() {
  const label = settledLabel(state.pendingDoc);
  setStatus(label === HOLD ? 'error' : 'saved', label);
}

async function save({ force = false } = {}) {
  if (!state.currentPath || state.saving || state.mode === 'browse') return;

  // Nothing was touched — never rewrite a file just because it was opened.
  // Forcing skips every such shortcut: the whole point is to write again what
  // the file already refused, which by definition looks like no change.
  if (!force && !state.dirty) {
    settledStatus();
    return;
  }

  let payload;
  let nextBody = null;
  const shape = writeShape({ mode: state.mode, force, pendingDoc: state.pendingDoc });
  if (shape === 'held') {
    nextBody = frameBody();
    payload = {
      relativePath: state.currentPath,
      html: nextBody === null ? state.pendingDoc : spliceBody(state.pendingDoc, nextBody),
      fullDocument: true,
      baseMtime: state.mtime,
      force: true,
    };
  } else if (shape === 'document') {
    const html = el.sourceEditor.value;
    if (!force && html === state.fullHtml) {
      settledStatus();
      return;
    }
    payload = {
      relativePath: state.currentPath,
      html,
      fullDocument: true,
      baseMtime: state.mtime,
      force,
    };
  } else {
    nextBody = frameBody();
    if (nextBody === null) return;
    if (!force && nextBody === state.lastSavedBody) {
      settledStatus();
      return;
    }
    payload = {
      relativePath: state.currentPath,
      body: nextBody,
      fullDocument: false,
      baseMtime: state.mtime,
      force,
    };
  }

  state.saving = true;
  setStatus('saving', '저장 중…');
  try {
    const result = await api.writeNote(payload);

    if (result && result.ok === false) {
      // The write was refused. Keep the buffer dirty so nothing is lost.
      if (Number.isFinite(result.mtime)) state.mtime = result.mtime;
      const held = result.reason === 'loss' || result.reason === 'malformed';
      state.holdMessage = held ? result.message : '';
      setStatus('error', held ? HOLD : '저장 실패');
      showToast(result.message);
      return;
    }

    if (state.mode === 'source') state.fullHtml = payload.html;
    else state.lastSavedBody = nextBody;
    state.dirty = false;
    // The document on disk has changed; source mode reads this, so keeping it
    // stale made the source view show the note as it was before the edit.
    if (typeof result?.html === 'string') state.diskHtml = result.html;
    // An edit-mode save writes the body only — it never carried the held head,
    // so clearing it here would lose that head as quietly as before. It does
    // move the words, though, and the held copy has to follow.
    state.pendingDoc = payload.fullDocument
      ? null
      : refreshHeld(state.pendingDoc, nextBody, spliceBody);
    // The head is on the file now, so there is nothing left to force.
    if (!state.pendingDoc) state.holdMessage = '';
    if (Number.isFinite(result?.mtime)) state.mtime = result.mtime;
    if (Number.isFinite(result?.bytes)) state.bytes = result.bytes;
    renderStatusBar();
    // The body landed, but a held head has still not — settledStatus() says so.
    settledStatus();
  } catch (err) {
    console.error(err);
    setStatus('error', '저장 실패');
    showToast(`저장에 실패했습니다: ${err?.message || err}`);
  } finally {
    state.saving = false;
  }
}

async function flushPending() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  if (state.currentPath && state.mode !== 'browse' && state.dirty) {
    await save();
  }
}

/**
 * Ask before leaving a note that holds an edit the file would not take.
 *
 * flushPending() has already tried to save. What survives that is work the
 * write guard refused, and opening another note replaces it — so this is the
 * last moment anyone can speak up. Only asked when the user chose to go
 * somewhere; a note reopened because it was renamed or moved is not leaving.
 */
function heldDocument() {
  return state.mode === 'source'
    ? pendingDocument(el.sourceEditor.value, state.diskHtml)
    : state.pendingDoc;
}

/**
 * Write the note even though the guard objected.
 *
 * The guard is right nearly every time — a save that empties a note is almost
 * always a slip. Nearly is why this exists. The message it refused with says
 * what would go, and the file is copied aside before it is overwritten, so
 * this is not the last word either.
 */
async function forceSave() {
  if (!state.holdMessage || state.saving || !state.currentPath) return;
  const ok = await confirmDialog(
    '그래도 저장',
    `${state.holdMessage} 덮어쓰기 전 백업은 남습니다.`,
    '그래도 저장',
  );
  if (!ok) return;
  await save({ force: true });
}

async function confirmDiscard(action = 'leave') {
  if (!heldDocument()) return true;
  const closing = action === 'close';
  return confirmDialog(
    '저장하지 못한 수정',
    '이 노트에는 파일이 받지 않은 수정이 있습니다. '
      + (closing ? '지금 닫으면' : '여기서 나가면') + ' 그 수정은 사라집니다.',
    closing ? '버리고 닫기' : '버리고 나가기',
  );
}

/* ------------------------------------------------------------------ *
 * Theme and modes
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  el.body.dataset.theme = theme === 'light' ? 'light' : 'dark';
  document.getElementById('btnTheme').textContent = theme === 'light' ? '☀' : '☾';
}

/** The theme covers the whole surface, the note included. */
function setTheme(theme) {
  applyTheme(theme);
  state.noteSurface = theme === 'dark' ? 'dark' : 'paper';
  applyNoteSurface();
}

function setMode(mode) {
  if (mode === state.mode) return;
  if (state.currentPath && state.mode !== 'browse') {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    save().then(() => applyMode(mode));
    return;
  }
  void applyMode(mode);
}

async function applyMode(mode) {
  const leavingSource = state.mode === 'source' && mode !== 'source';
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const editable = mode === 'edit';
  el.formatBar.classList.toggle('disabled', !editable);
  // 모드가 바뀌면 바꾸기 단추가 따라 숨거나 돌아온다.
  showReplace();
  // 붙임 칸은 편집 모드에만 있다. 노트를 바꿔 왔을 수도 있으므로 목록도 다시 읽는다.
  void refreshAttachments({ settleOpen: true });
  el.sourceEditor.classList.toggle('hidden', mode !== 'source');
  el.frame.classList.toggle('hidden', mode === 'source');
  applyEditableState();

  if (!state.currentPath) return;

  if (mode === 'source') {
    // Source mode shows the file as it is on disk. Pending edits are spliced
    // into that real document so the preview matches what a save would write.
    // Unless a whole-document edit is still waiting — see source-view.mjs.
    const base = sourceBase(state.diskHtml, state.pendingDoc);
    const pending = state.dirty ? frameBody() : null;
    state.fullHtml = pending === null ? base : spliceBody(base, pending);
    el.sourceEditor.value = state.fullHtml;
  } else if (leavingSource) {
    // Whatever the user typed in the source view becomes the live document.
    state.fullHtml = el.sourceEditor.value;
    // Held back from the file — remember it, or the trip back here loses it.
    state.pendingDoc = pendingDocument(state.fullHtml, state.diskHtml);
    await renderNote(state.fullHtml, state.baseUrl);
  }
}

/* ------------------------------------------------------------------ *
 * Modal prompt
 * ------------------------------------------------------------------ */

// Only one dialog at a time. Two could otherwise stack — each adding its own
// key listener — and a single Enter would answer both, running the action
// twice. That is how a delete came to be attempted on a note it had already
// removed.
let modalBusy = false;

function prompt(title, value = '') {
  if (modalBusy) return Promise.resolve(null);
  modalBusy = true;
  return new Promise((resolve) => {
    el.modal.classList.remove('hidden');
    el.modalTitle.textContent = title;
    el.modalInput.value = value;
    el.modalInput.focus();
    el.modalInput.select();

    const close = (result) => {
      modalBusy = false;
      el.modal.classList.add('hidden');
      document.getElementById('modalOk').onclick = null;
      document.getElementById('modalCancel').onclick = null;
      el.modalInput.onkeydown = null;
      resolve(result);
    };

    document.getElementById('modalOk').onclick = () => close(el.modalInput.value.trim());
    document.getElementById('modalCancel').onclick = () => close(null);
    el.modalInput.onkeydown = (event) => {
      if (event.key === 'Enter') close(el.modalInput.value.trim());
      if (event.key === 'Escape') close(null);
    };
  });
}

/**
 * Find inside the note that is open — Ctrl-F.
 *
 * Two searches, because the note is shown two ways. In browse and edit it is a
 * document in an iframe, and Chromium's own findInPage walks it. In source it
 * is text in a <textarea>, which findInPage cannot see, so that one is searched
 * here and shown by selecting the match.
 *
 * Nothing happens while you type. Searching as each letter lands meant the
 * source view took the focus back on every keystroke, and the next backspace
 * fell through to the note itself and deleted a character of it. Enter searches;
 * the box keeps the focus; the note is never typed into by accident.
 *
 * Separate from Ctrl-Shift-D, which reads every note in the folder. This one
 * reads the note in front of you.
 */
const findState = { query: '', hits: 0, at: 0, ticket: 0, replacing: false, replaceWanted: false };

const findInSource = () => state.mode === 'source';

function closeFind() {
  el.findBar.classList.add('hidden');
  el.findCount.textContent = '';
  findState.query = '';
  findState.at = 0;
  showReplace(false);
  clearNoteHighlight();
  hideSourceMark();
}

/**
 * Show or hide the replace half of the bar.
 *
 * Only where a note can actually be changed. Offering to replace in browse
 * mode would be offering something that cannot happen — the document is not
 * editable there, and execCommand would simply refuse.
 *
 * What the user asked for and what the mode allows are kept apart, so moving
 * to browse mode and back brings the row the user opened back with it.
 * Called with nothing to re-apply that after a mode change.
 */
function showReplace(on) {
  if (on !== undefined) findState.replaceWanted = on;
  const can = findState.replaceWanted && (state.mode === 'edit' || state.mode === 'source');
  for (const node of [el.replaceInput, el.replaceOne, el.replaceAll]) {
    node.classList.toggle('hidden', !can);
  }
  findState.replacing = can;
}

function openFind({ replace } = {}) {
  if (!state.currentPath) return;
  el.findBar.classList.remove('hidden');
  showReplace(replace);
  const editor = el.sourceEditor;
  const picked = findInSource()
    ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : '';
  if (picked && picked.length < 80 && !picked.includes('\n')) el.findInput.value = picked;
  el.findInput.focus();
  el.findInput.select();
  el.findCount.textContent = el.findInput.value ? 'Enter로 찾기' : '';
}

/** Every place the query sits in the source text. */
function sourceMatches(query) {
  const hay = el.sourceEditor.value.toLowerCase();
  const needle = query.toLowerCase();
  const spots = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) spots.push(i);
  return spots;
}

const MARKER_NAME = '___cs_free_note__folder.html';

const FIND_STYLE_ID = 'csfreenote-find-style';
const FIND_CSS = `::highlight(csfreenote-find) { background: #ffe066; color: #14161a; }
::highlight(csfreenote-find-here) { background: #f97316; color: #fff; }`;

/**
 * Every place the query sits in the note, as ranges over its own document.
 *
 * Not Chromium's findInPage: that searches the whole window. It counts the note
 * titles in the tree and the words in the title bar, and it scrolls to those —
 * which is why the count was too high and the note never moved. This looks
 * inside the note and nowhere else.
 */
function noteMatches(query) {
  if (!frameDoc || !frameDoc.body || !query) return [];
  const needle = query.toLowerCase();
  const walker = frameDoc.createTreeWalker(frameDoc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const tag = node.parentElement && node.parentElement.tagName;
      return tag === 'SCRIPT' || tag === 'STYLE'
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const found = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = node.textContent.toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      const range = frameDoc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      found.push(range);
    }
  }
  return found;
}

/**
 * Colour the matches.
 *
 * Through the highlight registry, which paints ranges without putting anything
 * in the document. Wrapping each match in a <mark> would show the same thing
 * and would be in the file at the next save. The rule itself goes in <head>,
 * where saving cannot reach it.
 */
function paintMatches(ranges, active) {
  const view = frameDoc && frameDoc.defaultView;
  if (!view || !view.CSS || !view.CSS.highlights) return;
  view.CSS.highlights.delete('csfreenote-find');
  view.CSS.highlights.delete('csfreenote-find-here');
  if (!ranges.length) return;

  if (!frameDoc.getElementById(FIND_STYLE_ID) && frameDoc.head) {
    const style = frameDoc.createElement('style');
    style.id = FIND_STYLE_ID;
    style.textContent = FIND_CSS;
    frameDoc.head.appendChild(style);
  }
  const rest = ranges.filter((_, i) => i !== active);
  if (rest.length) view.CSS.highlights.set('csfreenote-find', new view.Highlight(...rest));
  if (ranges[active]) {
    view.CSS.highlights.set('csfreenote-find-here', new view.Highlight(ranges[active]));
  }
}

function clearNoteHighlight() {
  const view = frameDoc && frameDoc.defaultView;
  if (view && view.CSS && view.CSS.highlights) {
    view.CSS.highlights.delete('csfreenote-find');
    view.CSS.highlights.delete('csfreenote-find-here');
  }
  const style = frameDoc && frameDoc.getElementById(FIND_STYLE_ID);
  if (style) style.remove();
}

function scrollNoteTo(range) {
  const box = range.getBoundingClientRect();
  const root = frameDoc.documentElement;
  const view = frameDoc.defaultView;
  const height = view.innerHeight || root.clientHeight;
  if (box.top >= 0 && box.bottom <= height) return;
  root.scrollTop = Math.max(0, root.scrollTop + box.top - height / 3);
}

/**
 * Mark the match in the source view.
 *
 * A textarea's selection goes grey the moment it loses the focus, and the focus
 * has to go back to the find box. So the mark is drawn on top instead: the same
 * hidden copy that measures where to scroll also says where the match sits, and
 * a box is placed there over the text.
 */
// Where the mark belongs, in the text rather than on the screen. The mark is
// positioned fixed, so it has to be put back every time the text moves under
// it — otherwise it sits where the match used to be and follows the scroll.
let sourceMarkAt = null;

function placeSourceMark() {
  const editor = el.sourceEditor;
  const mark = el.sourceMark;
  if (!mark) return;
  if (!sourceMarkAt || state.mode !== 'source') { mark.classList.remove('on'); return; }

  const { spot } = sourceMarkAt;
  const box = editor.getBoundingClientRect();
  mark.style.left = `${box.left + spot.left - editor.scrollLeft}px`;
  mark.style.top = `${box.top + spot.top - editor.scrollTop}px`;
  mark.style.width = `${Math.max(2, spot.width)}px`;
  mark.style.height = `${spot.height}px`;
  // Out of sight above or below the box: no mark rather than one floating over
  // the toolbar.
  const visible = spot.top - editor.scrollTop >= -spot.height
    && spot.top - editor.scrollTop <= editor.clientHeight;
  mark.classList.toggle('on', visible);
}

function markSourceMatch(index, length) {
  const mark = el.sourceMark;
  if (!mark) return;
  const spot = measureSource(index, length);
  if (!spot) { sourceMarkAt = null; mark.classList.remove('on'); return; }
  sourceMarkAt = { index, length, spot };
  placeSourceMark();
}

/** The text wraps differently at a new width, so the measurement is stale. */
function remeasureSourceMark() {
  if (!sourceMarkAt) return;
  markSourceMatch(sourceMarkAt.index, sourceMarkAt.length);
}

function hideSourceMark() {
  sourceMarkAt = null;
  if (el.sourceMark) el.sourceMark.classList.remove('on');
}

/** Where a stretch of the source text falls once the lines have wrapped. */
function measureSource(index, length) {
  const editor = el.sourceEditor;
  if (!editor.value) return null;
  const style = getComputedStyle(editor);
  const mirror = document.createElement('div');
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
    'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.top = '-9999px';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.width = `${editor.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = style.overflowWrap || 'break-word';

  mirror.textContent = editor.value.slice(0, index);
  const piece = document.createElement('span');
  piece.textContent = editor.value.slice(index, index + length) || '\u200b';
  mirror.appendChild(piece);
  mirror.appendChild(document.createTextNode(editor.value.slice(index + length)));
  document.body.appendChild(mirror);
  const rect = piece.getBoundingClientRect();
  const base = mirror.getBoundingClientRect();
  const spot = {
    left: rect.left - base.left,
    top: rect.top - base.top,
    width: rect.width,
    height: rect.height,
  };
  mirror.remove();
  return spot;
}

/**
 * Bring a spot in the source view into sight.
 *
 * A textarea scrolls to its selection only while it holds the focus, and the
 * focus goes straight back to the find box — so the count would climb while the
 * page sat still. Measuring it instead: a hidden copy of the same text, in the
 * same font at the same width, says how far down the match falls once the lines
 * have wrapped. Counting newlines cannot: one logical line can occupy five.
 */
function scrollSourceTo(index) {
  const editor = el.sourceEditor;
  const spot = measureSource(index, 1);
  if (!spot) return;
  // A third of the way down reads better than flush against the top edge.
  editor.scrollTop = Math.max(0, spot.top - editor.clientHeight / 3);
}

function showSourceMatch(query, step) {
  const spots = sourceMatches(query);
  findState.hits = spots.length;
  if (!spots.length) {
    findState.at = 0;
    el.findCount.textContent = '없음';
    return;
  }
  findState.at = ((findState.at + step - 1 + spots.length) % spots.length) + 1;
  const at = spots[findState.at - 1];
  const editor = el.sourceEditor;

  // Select so the match is visible, scroll to it ourselves, and never take the
  // focus off the find box — a note that holds the focus takes the keystrokes
  // meant for the search, and a backspace lands in the note.
  editor.setSelectionRange(at, at + query.length);
  scrollSourceTo(at);
  markSourceMatch(at, query.length);
  el.findCount.textContent = `${findState.at} / ${spots.length}`;
}

function runFind(step) {
  const query = el.findInput.value;
  if (!query) {
    findState.query = '';
    findState.at = 0;
    el.findCount.textContent = '';
    clearNoteHighlight();
    hideSourceMark();
    return;
  }

  if (query !== findState.query) findState.at = 0;
  findState.query = query;

  if (findInSource()) {
    clearNoteHighlight();
    showSourceMatch(query, step || 1);
    return;
  }

  hideSourceMark();
  const ranges = noteMatches(query);
  findState.hits = ranges.length;
  if (!ranges.length) {
    findState.at = 0;
    paintMatches([], -1);
    el.findCount.textContent = '없음';
    return;
  }
  findState.at = ((findState.at + (step || 1) - 1 + ranges.length) % ranges.length) + 1;
  paintMatches(ranges, findState.at - 1);
  scrollNoteTo(ranges[findState.at - 1]);
  el.findCount.textContent = `${findState.at} / ${ranges.length}`;
}

/* ------------------------------------------------------------------ *
 * Replace
 *
 * Every replacement goes through execCommand('insertText'). Editing the
 * document directly would be shorter and is the reason this project has been
 * bitten twice: the browser's undo remembers the edits it made, so when the
 * text underneath has moved since, Ctrl+Z puts words back in the wrong
 * places. If the command is refused, nothing is written — a refusal is not an
 * invitation to reach into the DOM.
 *
 * Undo is therefore one step per replacement. There is no way to fold several
 * execCommand calls into one, and a wrong undo is worse than a long one.
 * ------------------------------------------------------------------ */

/** Put the replacement in at `range`, the way a person typing would. */
function typeOver(range, text) {
  const view = frameDoc && frameDoc.defaultView;
  if (!view) return false;
  // execCommand needs the frame to hold the focus, and the caret to be where
  // the edit goes. Done on a button press only: doing it per keystroke is how
  // Korean input lost its first consonant and a backspace ate the note.
  frameDoc.body.focus();
  const selection = view.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return frameDoc.execCommand('insertText', false, text) === true;
}

/** The same, in the source textarea, so its own undo keeps working. */
function typeOverSource(index, length, text) {
  const editor = el.sourceEditor;
  editor.focus();
  editor.setSelectionRange(index, index + length);
  return document.execCommand('insertText', false, text) === true;
}

/**
 * Replace the match the user is looking at, then move to the next one.
 *
 * Nothing happens without a current match: 바꾸기 pressed on an empty search
 * would otherwise change whatever the caret happened to be near.
 */
function replaceCurrent() {
  const query = el.findInput.value;
  const text = el.replaceInput.value;
  if (!query || !findState.replacing) return;

  if (findInSource()) {
    const spots = sourceMatches(query);
    if (!spots.length || !findState.at) { runFind(1); return; }
    const at = spots[Math.min(findState.at, spots.length) - 1];
    if (!typeOverSource(at, query.length, text)) {
      showToast('바꾸지 못했습니다.');
      return;
    }
    state.dirty = true;
    scheduleSave();
    // The text moved, so the count and the mark are both stale.
    findState.at = Math.max(0, findState.at - 1);
    el.findInput.focus();
    runFind(1);
    return;
  }

  const ranges = noteMatches(query);
  if (!ranges.length || !findState.at) { runFind(1); return; }
  const range = ranges[Math.min(findState.at, ranges.length) - 1];
  if (!typeOver(range, text)) {
    showToast('바꾸지 못했습니다. 편집 모드인지 확인해 주십시오.');
    return;
  }
  findState.at = Math.max(0, findState.at - 1);
  el.findInput.focus();
  runFind(1);
}

/**
 * Replace every match.
 *
 * Last match first. A replacement changes the text after it and nothing
 * before, so the earlier ranges stay where they were — and a replacement that
 * contains what was searched for ("가" for "가가") cannot feed itself a new
 * match to find, which a forwards loop would chase forever.
 */
function replaceEvery() {
  const query = el.findInput.value;
  const text = el.replaceInput.value;
  if (!query || !findState.replacing) return;

  let done = 0;
  let refused = false;

  if (findInSource()) {
    const spots = sourceMatches(query);
    for (let i = spots.length - 1; i >= 0; i -= 1) {
      if (!typeOverSource(spots[i], query.length, text)) { refused = true; break; }
      done += 1;
    }
    if (done) {
      state.dirty = true;
      scheduleSave();
    }
  } else {
    const ranges = noteMatches(query);
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      if (!typeOver(ranges[i], text)) { refused = true; break; }
      done += 1;
    }
  }

  findState.at = 0;
  el.findInput.focus();
  clearNoteHighlight();
  hideSourceMark();
  el.findCount.textContent = done ? `${done}곳 바꿈` : '없음';
  if (refused) showToast(`${done}곳까지 바꾸고 멈췄습니다.`);
  else if (done) showToast(`${done}곳을 바꿨습니다. 되돌리기는 ${done}번입니다.`, 'notice');
}

/* ------------------------------------------------------------------ *
 * Files a note carries
 *
 * The panel shows under the note while editing. One file at a time is
 * selected and the buttons act on that — the alternative, a row of buttons
 * per file, makes the list wide and leaves nowhere to show a picture big
 * enough to recognise.
 *
 * Inserting goes through execCommand, like every other change to a note, so
 * that Ctrl+Z walks back through it. See the replace section above for why
 * that is not negotiable.
 * ------------------------------------------------------------------ */

const attachState = { files: [], selected: '', open: true };

/** Only where a note can be changed, and only when a note is open. */
function attachVisible() {
  return Boolean(state.currentPath) && state.mode === 'edit';
}

/** An image can be placed; anything else can only be linked. */
function attachSelected() {
  return attachState.files.find((f) => f.name === attachState.selected) || null;
}

function renderAttachList() {
  const list = el.attachList;
  list.textContent = '';

  if (!attachState.files.length) {
    const empty = document.createElement('li');
    empty.className = 'attach-empty';
    empty.textContent = '붙은 파일이 없습니다.';
    list.appendChild(empty);
  }

  for (const file of attachState.files) {
    const row = document.createElement('li');
    row.className = `attach-item${file.name === attachState.selected ? ' on' : ''}`;
    row.dataset.name = file.name;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(file.name === attachState.selected));
    row.title = file.name;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(file.bytes);
    row.append(name, size);
    list.appendChild(row);
  }

  el.attachTitle.textContent = attachState.files.length
    ? `붙임 파일 (${attachState.files.length})`
    : '붙임 파일';
}

/**
 * Show the selected file.
 *
 * The <img> here belongs to the app window, not to the note, and is fed a
 * file:// URL the main process built. Nothing about this reaches the document.
 */
async function renderAttachPreview() {
  const file = attachSelected();
  el.attachImage.hidden = true;
  el.attachImage.removeAttribute('src');
  el.attachKind.textContent = '';

  const has = Boolean(file);
  el.attachInsert.disabled = !has;
  el.attachRemove.disabled = !has;
  // Placing left or right only means something for a picture; a link has no
  // side to sit on.
  el.attachInsertLeft.disabled = !has || !file.image;
  el.attachInsertRight.disabled = !has || !file.image;

  if (!file) return;
  if (!file.image) {
    const dot = file.name.lastIndexOf('.');
    el.attachKind.textContent = dot > 0 ? file.name.slice(dot + 1) : '파일';
    return;
  }
  const ref = await api.attachmentRef({ relativePath: state.currentPath, name: file.name });
  if (!ref || attachState.selected !== file.name) return;
  el.attachImage.src = ref.preview;
  el.attachImage.hidden = false;
}

function applyAttachOpen() {
  el.attachBody.classList.toggle('collapsed', !attachState.open);
  el.attachChevron.textContent = attachState.open ? '▾' : '▸';
  el.attachToggle.setAttribute('aria-expanded', String(attachState.open));
}

/**
 * Read what the note has and draw it.
 *
 * Opened for a note that already carries files, folded away for one that does
 * not — most notes never get an attachment, and the space belongs to the note
 * until there is a reason to take it.
 */
async function refreshAttachments({ settleOpen = false } = {}) {
  el.attachPanel.classList.toggle('hidden', !attachVisible());
  if (!attachVisible()) return;

  // A preload without this API is one the panel has nothing to say to. Asking
  // anyway threw before the promise existed, so the catch never saw it.
  if (!api.listAttachments) {
    el.attachPanel.classList.add('hidden');
    return;
  }
  const files = await api.listAttachments({ relativePath: state.currentPath })
    .catch(() => []);
  attachState.files = Array.isArray(files) ? files : [];
  if (!attachState.files.some((f) => f.name === attachState.selected)) {
    attachState.selected = attachState.files.length ? attachState.files[0].name : '';
  }
  if (settleOpen) {
    attachState.open = state.attachOpen !== false && attachState.files.length > 0;
    applyAttachOpen();
  }
  renderAttachList();
  await renderAttachPreview();
}

function selectAttachment(name) {
  if (attachState.selected === name) return;
  attachState.selected = name;
  renderAttachList();
  void renderAttachPreview();
}

/** Move the selection with the arrow keys, the way the list dialogs do. */
function stepAttachment(step) {
  if (!attachState.files.length) return;
  const at = attachState.files.findIndex((f) => f.name === attachState.selected);
  const next = Math.min(Math.max((at === -1 ? 0 : at) + step, 0), attachState.files.length - 1);
  selectAttachment(attachState.files[next].name);
  const row = el.attachList.querySelector('.attach-item.on');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

const ATTACH_PLACE = {
  inline: 'vertical-align: middle;',
  left: 'float: left; margin: 0 12px 6px 0;',
  right: 'float: right; margin: 0 0 6px 12px;',
};

/**
 * Put the selected file into the note.
 *
 * A picture goes in as a picture; anything else goes in as a link to itself,
 * which is the only useful thing to say about a spreadsheet in running text.
 * `inline` sits in the line with the text centred against it; left and right
 * float, so the words run alongside — those two cannot be combined, since a
 * floated picture has left the line box that the centring would apply to.
 */
async function insertAttachment(where) {
  const file = attachSelected();
  if (!file || !frameDoc || state.mode !== 'edit') return;
  if (where !== 'inline' && !file.image) return;

  const ref = await api.attachmentRef({ relativePath: state.currentPath, name: file.name });
  if (!ref) return;

  const href = escapeAttr(ref.href);
  const label = escapeHtml(ref.name);
  const html = ref.image
    ? `<img src="${href}" alt="${label}" style="${ATTACH_PLACE[where]}">`
    : `<a href="${href}">${label}</a>`;

  frameDoc.body.focus();
  if (frameDoc.execCommand('insertHTML', false, html) !== true) {
    showToast('넣지 못했습니다. 편집 모드인지 확인해 주십시오.');
    return;
  }
  scheduleSave();
}

async function addAttachments() {
  if (!state.currentPath) return;
  const result = await api.addAttachments({ relativePath: state.currentPath });
  if (result && result.ok === false) showToast(result.message);
  if (result && Array.isArray(result.added) && result.added.length) {
    attachState.selected = result.added[result.added.length - 1];
    attachState.open = true;
    applyAttachOpen();
    showToast(`${result.added.length}개를 붙였습니다.`, 'notice');
  }
  await refreshAttachments();
}

/**
 * Remove the selected file.
 *
 * Asked about twice over when the note is using it: the link would break
 * silently, and `_backup` keeps notes rather than their files, so there is
 * nowhere to get it back from except the recycle bin.
 */
async function removeAttachment() {
  const file = attachSelected();
  if (!file) return;

  const ref = await api.attachmentRef({ relativePath: state.currentPath, name: file.name });
  const used = ref ? noteUsesHref(ref.href) : false;
  const ok = await confirmDialog(
    '붙임 파일 삭제',
    used
      ? `'${file.name}' 은 본문에서 쓰이고 있습니다. 지우면 그 자리가 깨집니다.`
      : `'${file.name}' 을 휴지통으로 보냅니다.`,
    '삭제',
  );
  if (!ok) return;

  const result = await api.removeAttachment({ relativePath: state.currentPath, name: file.name });
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  attachState.selected = '';
  await refreshAttachments();
}

/** Does the note point at this file anywhere? */
function noteUsesHref(href) {
  if (!frameDoc || !frameDoc.body) return false;
  const want = decodeURIComponent(String(href));
  for (const node of frameDoc.body.querySelectorAll('[src], [href]')) {
    const value = node.getAttribute('src') || node.getAttribute('href') || '';
    let plain = value;
    try {
      plain = decodeURIComponent(value);
    } catch {
      /* leave it as it came */
    }
    if (plain === want) return true;
  }
  return false;
}

async function openAttachment() {
  const file = attachSelected();
  if (!file) return;
  const result = await api.openAttachment({ relativePath: state.currentPath, name: file.name });
  if (result && result.ok === false) showToast(result.message);
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const books = { items: [], active: 0, selected: 0 };

async function openSettings() {
  const current = await api.getSettings();
  document.getElementById('setStartMode').value = current.editor.startMode;
  document.getElementById('setAutosave').value = (current.editor.autosaveMs / 1000).toFixed(1);
  document.getElementById('setSearchScope').value = current.ui.searchWholeBook ? 'book' : 'folder';
  document.getElementById('setStartAs').value = current.window.startAs || 'restore';
  document.getElementById('setReturnToBrowse').checked = current.editor.returnToBrowse !== false;
  document.getElementById('setDateFormat').value = current.editor.dateFormat || DEFAULT_FORMAT;
  document.getElementById('setTableEditing').checked = current.editor.tableEditing === true;
  document.getElementById('setUpdateCheck').checked = current.update?.check !== false;
  document.getElementById('setMinimizeToTray').checked = current.window.minimizeToTray === true;
  updateDateFormatPreview();
  await refreshBooks();
  state.formats = current.formats;
  renderFormats();
  el.settings.classList.remove('hidden');
  window.addEventListener('keydown', onSettingsKey, true);
}

function closeSettings() {
  el.settings.classList.add('hidden');
  window.removeEventListener('keydown', onSettingsKey, true);
}

function onSettingsKey(event) {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  event.preventDefault();
  closeSettings();
}

/** Show what the format string produces right now, so it needs no explaining. */
function updateDateFormatPreview() {
  const preview = document.getElementById('dateFormatPreview');
  const value = document.getElementById('setDateFormat').value;
  if (preview) preview.textContent = formatDateTime(value || DEFAULT_FORMAT);
}

async function refreshBooks() {
  const listed = await api.listBooks();
  books.items = listed.books;
  books.active = listed.active;
  books.selected = Math.min(books.selected, books.items.length - 1);
  renderBooks();
}

function renderBooks() {
  el.bookList.innerHTML = '';
  books.items.forEach((book, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `book-row${index === books.selected ? ' selected' : ''}`;

    const name = document.createElement('span');
    name.textContent = book.name;
    row.appendChild(name);

    const badges = document.createElement('span');
    if (index === books.active) {
      const open = document.createElement('span');
      open.className = 'book-badge open';
      open.textContent = '열림';
      badges.appendChild(open);
    }
    if (book.missing) {
      const missing = document.createElement('span');
      missing.className = 'book-badge missing';
      missing.textContent = '경로 없음';
      badges.appendChild(missing);
    }
    row.appendChild(badges);

    const where = document.createElement('small');
    where.textContent = book.path;
    where.title = book.path;
    row.appendChild(where);

    row.addEventListener('click', () => {
      books.selected = index;
      renderBooks();
    });
    row.addEventListener('dblclick', () => void selectBook(index));
    el.bookList.appendChild(row);
  });

  const single = books.items.length <= 1;
  document.getElementById('bookRemove').disabled = single;
  document.getElementById('bookUp').disabled = books.selected <= 0;
  document.getElementById('bookDown').disabled = books.selected >= books.items.length - 1;
}

async function selectBook(index) {
  const book = books.items[index];
  if (book?.missing) {
    showToast(`'${book.name}' 경로를 찾을 수 없습니다: ${book.path}`);
    return;
  }
  const result = await api.selectBook(index);
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  closeSettings();
  if (result.unchanged) return;

  state.config = await api.getConfig();
  state.expanded = new Set();
  state.selectedFolder = '';
  closeNote();
  await refreshTree();
  showToast(`'${books.items[index].name}' 을(를) 열었습니다.`, 'notice');
}

/** Add or edit one book: pick the folder, then name it. */
async function editBook(index) {
  const existing = index >= 0 ? books.items[index] : null;
  const chosen = await api.chooseBookDir();
  if (!chosen) return;

  const name = await prompt('노트 폴더 이름', existing ? existing.name : '');
  if (!name) return;

  const result = await api.saveBook({ index, name, dir: chosen, shared: false });
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  books.selected = result.index;
  await refreshBooks();
  // Editing the open book changes what the tree is showing.
  if (result.index === books.active) {
    state.config = await api.getConfig();
    closeNote();
    await refreshTree();
  }
}

async function removeBook(index) {
  const book = books.items[index];
  if (!book) return;
  const confirmed = await confirmDialog(
    '노트 폴더 목록에서 제거',
    `'${book.name}' 을(를) 목록에서 지웁니다. 노트 파일은 그대로 남습니다.`,
  );
  if (!confirmed) return;

  const result = await api.removeBook(index);
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  books.selected = Math.max(0, index - 1);
  await refreshBooks();
  state.config = await api.getConfig();
  closeNote();
  await refreshTree();
}

async function moveBook(delta) {
  const to = books.selected + delta;
  if (to < 0 || to >= books.items.length) return;
  const result = await api.reorderBooks({ from: books.selected, to });
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  books.selected = to;
  await refreshBooks();
}

/* ------------------------------------------------------------------ *
 * Format presets
 * ------------------------------------------------------------------ */

const FONT_CHOICES = [
  ['', '(그대로)'],
  ['맑은 고딕', '맑은 고딕'],
  ['돋움', '돋움'],
  ['굴림', '굴림'],
  ['바탕', '바탕'],
  ['궁서', '궁서'],
  ['나눔고딕', '나눔고딕'],
  ['Arial', 'Arial'],
  ['Times New Roman', 'Times New Roman'],
  ['Consolas', 'Consolas'],
];

const SIZE_CHOICES = [
  [0, '(그대로)'], [1, '아주 작게'], [2, '작게'], [3, '보통'],
  [4, '조금 크게'], [5, '크게'], [6, '더 크게'], [7, '아주 크게'],
];

const ALIGN_CHOICES = [['', '(그대로)'], ['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']];

/** Cycle a toggle through set / unset / leave-alone. */
const nextTriState = (value) => (value === null ? true : (value === true ? false : null));
const triLabel = (value) => (value === null ? 'off-unset' : (value ? 'on' : 'off'));

function renderFormats() {
  const list = document.getElementById('formatList');
  list.innerHTML = '';

  state.formats.forEach((preset, index) => {
    const row = document.createElement('div');
    row.className = 'format-row';

    const key = document.createElement('span');
    key.className = 'format-key';
    key.textContent = `Ctrl-${index + 1}`;
    row.appendChild(key);

    const label = document.createElement('input');
    label.type = 'text';
    label.value = preset.label;
    label.placeholder = '이름';
    label.maxLength = 20;
    label.addEventListener('change', () => void updateFormat(index, { label: label.value }));
    row.appendChild(label);

    const select = (className, choices, value, key2, cast) => {
      const node = document.createElement('select');
      node.className = className;
      for (const [optionValue, text] of choices) {
        const option = document.createElement('option');
        option.value = String(optionValue);
        option.textContent = text;
        node.appendChild(option);
      }
      node.value = String(value);
      node.addEventListener('change',
        () => void updateFormat(index, { [key2]: cast(node.value) }));
      row.appendChild(node);
    };
    select('font', FONT_CHOICES, preset.font, 'font', (v) => v);
    select('size', SIZE_CHOICES, preset.size, 'size', Number);

    const swatch = (field, title) => {
      const wrap = document.createElement('span');
      wrap.className = `format-swatch${preset[field] ? '' : ' unset'}`;
      const input = document.createElement('input');
      input.type = 'color';
      input.title = title;
      input.value = preset[field] || '#000000';
      input.addEventListener('change',
        () => void updateFormat(index, { [field]: input.value }));
      wrap.appendChild(input);

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = '×';
      clear.title = `${title} 지정 안 함`;
      clear.addEventListener('click', () => void updateFormat(index, { [field]: '' }));
      wrap.appendChild(clear);
      row.appendChild(wrap);
    };
    swatch('color', '글자색');
    swatch('highlight', '형광펜');

    for (const [field, text] of [['bold', 'B'], ['italic', 'I'], ['underline', 'U']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'format-toggle';
      button.textContent = text;
      button.dataset.state = triLabel(preset[field]);
      button.title = '켬 / 끔 / 그대로';
      button.addEventListener('click',
        () => void updateFormat(index, { [field]: nextTriState(preset[field]) }));
      row.appendChild(button);
    }

    select('align', ALIGN_CHOICES, preset.align, 'align', (v) => v);
    list.appendChild(row);
  });
}

async function updateFormat(index, patch) {
  const next = state.formats.map((preset, i) => (i === index ? { ...preset, ...patch } : preset));
  const saved = await api.saveSettings({ formats: next });
  state.formats = saved.formats;
  renderFormats();
}

async function resetFormats() {
  const confirmed = await confirmDialog('서식 되돌리기', '아홉 개 서식을 모두 기본값으로 되돌립니다.');
  if (!confirmed) return;
  const saved = await api.saveSettings({ formats: null });
  state.formats = saved.formats;
  renderFormats();
}

/* ------------------------------------------------------------------ *
 * Tree
 * ------------------------------------------------------------------ */

/** Yes/no dialog reusing the modal, so deleting no longer means typing a word. */
function confirmDialog(title, message, okLabel = '삭제') {
  if (modalBusy) return Promise.resolve(false);
  modalBusy = true;
  return new Promise((resolve) => {
    el.modal.classList.remove('hidden');
    el.modal.classList.add('confirm');
    el.modalTitle.textContent = title;
    el.modalInput.classList.add('hidden');

    let note = document.getElementById('modalMessage');
    if (!note) {
      note = document.createElement('p');
      note.id = 'modalMessage';
      el.modalInput.insertAdjacentElement('afterend', note);
    }
    note.textContent = message;
    note.classList.remove('hidden');

    const ok = document.getElementById('modalOk');
    const cancel = document.getElementById('modalCancel');
    ok.textContent = okLabel;
    cancel.focus();

    const close = (answer) => {
      modalBusy = false;
      el.modal.classList.add('hidden');
      el.modal.classList.remove('confirm');
      el.modalInput.classList.remove('hidden');
      note.classList.add('hidden');
      ok.textContent = '확인';
      ok.onclick = null;
      cancel.onclick = null;
      window.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(false); }
      if (event.key === 'Enter') { event.stopPropagation(); close(true); }
    };

    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    window.addEventListener('keydown', onKey, true);
  });
}

/**
 * Pick one item from a list, with arrow keys, Enter and double-click.
 * Resolves to the chosen value, or null if the user cancelled.
 */
function chooseFromList(title, items) {
  if (modalBusy) return Promise.resolve(null);
  modalBusy = true;
  return new Promise((resolve) => {
    el.modal.classList.remove('hidden');
    el.modal.classList.add('picker');
    el.modalTitle.textContent = title;
    el.modalInput.classList.add('hidden');

    let list = document.getElementById('modalList');
    if (!list) {
      list = document.createElement('div');
      list.id = 'modalList';
      list.className = 'modal-list';
      el.modalInput.insertAdjacentElement('afterend', list);
    }
    list.innerHTML = '';
    list.classList.remove('hidden');

    let index = 0;
    const buttons = items.map((item, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'modal-list-item';
      button.textContent = item.label;
      if (item.hint) {
        const hint = document.createElement('small');
        hint.textContent = item.hint;
        button.appendChild(hint);
      }
      button.addEventListener('click', () => select(i));
      button.addEventListener('dblclick', () => close(items[i].value));
      list.appendChild(button);
      return button;
    });

    function select(next) {
      index = Math.max(0, Math.min(items.length - 1, next));
      buttons.forEach((b, i) => b.classList.toggle('selected', i === index));
      buttons[index]?.scrollIntoView({ block: 'nearest' });
    }

    const ok = document.getElementById('modalOk');
    const cancel = document.getElementById('modalCancel');

    function close(value) {
      modalBusy = false;
      el.modal.classList.add('hidden');
      el.modal.classList.remove('picker');
      el.modalInput.classList.remove('hidden');
      list.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    }

    function onKey(event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); select(index + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); select(index - 1); }
      else if (event.key === 'Home') { event.preventDefault(); select(0); }
      else if (event.key === 'End') { event.preventDefault(); select(items.length - 1); }
      else if (event.key === 'Enter') { event.preventDefault(); close(items[index].value); }
      else if (event.key === 'Escape') { event.preventDefault(); close(null); }
      else return;
      event.stopPropagation();
    }

    ok.onclick = () => close(items[index].value);
    cancel.onclick = () => close(null);
    window.addEventListener('keydown', onKey, true);

    select(0);
    buttons[0]?.focus();
  });
}

/**
 * Which template a new note starts from.
 * Returns the template name, '' for a blank note, or undefined if cancelled.
 */
async function chooseTemplate() {
  if (!state.templates.length) return '';
  const picked = await chooseFromList('노트 양식', [
    { label: '빈 노트', hint: '양식 없이 시작', value: '' },
    ...state.templates.map((name) => ({ label: name, value: name })),
  ]);
  return picked === null ? undefined : picked;
}

function renderTree() {
  const tree = state.tree;
  el.tree.innerHTML = '';
  if (!tree) return;
  const fragment = document.createDocumentFragment();
  fragment.appendChild(buildRootRow(tree));
  for (const node of tree.children || []) fragment.appendChild(buildNode(node));
  el.tree.appendChild(fragment);
}

/** The book root: selecting it puts new notes at the top level. */
function buildRootRow(tree) {
  const row = document.createElement('div');
  row.className = 'tree-row root-row';
  if (!state.selectedFolder) row.classList.add('active');

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '🗂';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = state.config?.Name || tree.name || '기본 폴더';
  label.title = tree.root;

  row.append(icon, label);
  row.addEventListener('click', () => {
    state.selectedFolder = '';
    renderTree();
    openFolder({
      type: 'folder', name: label.textContent, relative: '', marker: tree.marker || null,
    }).catch((err) => {
      console.error(err);
      showToast(err?.message || String(err));
    });
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openContextMenu(event, { type: 'folder', name: label.textContent, relative: '' });
  });
  row.addEventListener('dragover', (event) => {
    if (!state.dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    row.classList.remove('drop-target');
    void dropOnto('', event.ctrlKey);
  });
  return row;
}

function buildNode(node) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  wrapper.dataset.path = node.relative;

  const row = document.createElement('div');
  row.className = 'tree-row';
  if (node.type === 'note' && node.relative === state.currentPath) row.classList.add('active');

  const twisty = document.createElement('span');
  twisty.className = 'tree-twisty';
  if (node.type === 'folder') {
    twisty.textContent = state.expanded.has(node.relative) ? '▼' : '▶';
    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleExpand(node.relative);
    });
  } else {
    twisty.textContent = '';
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = node.type === 'folder' ? '📁' : '📄';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;
  label.title = node.relative;

  row.append(twisty, icon, label);

  row.addEventListener('click', () => {
    if (node.type === 'folder') {
      state.selectedFolder = node.relative;
      toggleExpand(node.relative, true);
      markActive(node.relative, true);
      openFolder(node).catch((err) => {
        console.error(err);
        showToast(err?.message || String(err));
      });
    } else {
      openNote(node.relative, undefined, { ask: true }).catch((err) => {
        console.error(err);
        setStatus('error', '열기 실패');
        showToast(`노트를 열지 못했습니다: ${err?.message || err}`);
      });
    }
  });
  row.addEventListener('dblclick', () => {
    if (node.type === 'folder') toggleExpand(node.relative);
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event, node);
  });

  // Drag a note or folder onto a folder to move it; hold Ctrl to copy.
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    event.stopPropagation();
    state.dragging = node;
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', node.relative);
  });
  row.addEventListener('dragend', () => {
    state.dragging = null;
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });

  if (node.type === 'folder') {
    row.addEventListener('dragover', (event) => {
      if (!canDropOn(node.relative)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('drop-target');
      void dropOnto(node.relative, event.ctrlKey);
    });
  }

  wrapper.appendChild(row);

  if (node.type === 'folder') {
    const children = document.createElement('div');
    children.className = 'tree-children';
    if (!state.expanded.has(node.relative)) children.classList.add('collapsed');
    for (const child of node.children || []) children.appendChild(buildNode(child));
    wrapper.appendChild(children);
  }

  return wrapper;
}

function toggleExpand(relative, forceOpen = false) {
  if (forceOpen) state.expanded.add(relative);
  else if (state.expanded.has(relative)) state.expanded.delete(relative);
  else state.expanded.add(relative);
  renderTree();
}

function markActive(relative, isFolder = false) {
  document.querySelectorAll('.tree-row.active').forEach((row) => row.classList.remove('active'));
  const row = el.tree.querySelector(`[data-path="${cssEscape(relative)}"] > .tree-row`);
  if (row) row.classList.add('active');
  if (isFolder) state.selectedFolder = relative;
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
}

/** Where a folder keeps the note that describes it. */
function folderMarkerFor(relative) {
  return relative ? `${relative}/${MARKER_NAME}` : MARKER_NAME;
}

/**
 * The thing the tree is pointing at, folder or note.
 *
 * There is no single flag for it. `currentPath` is the note on screen, and
 * choosing a folder puts that folder's own description there — or nothing at
 * all, when it has none yet. `selectedFolder` is not the answer either: it
 * follows a note as well, being where the next new note would go. So a folder
 * is what is chosen when the note on screen is that folder's description, or
 * when there is no note on screen at all.
 *
 * The highlighted row cannot be asked: it is set when a folder is clicked and
 * then rebuilt from `currentPath` on the next render, which drops it again.
 */
function selectedNode() {
  const nodes = state.tree?.children || [];
  const folder = state.selectedFolder;
  const onFolder = !state.currentPath
    || (folder && state.currentPath === folderMarkerFor(folder));
  if (onFolder) return folder ? findNode(nodes, folder) : null;   // the book root has no name to change
  return findNode(nodes, state.currentPath);
}

function findNode(nodes, relative) {
  for (const node of nodes) {
    if (node.relative === relative) return node;
    if (node.children) {
      const hit = findNode(node.children, relative);
      if (hit) return hit;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

function closeContextMenu() {
  const existing = document.getElementById('contextMenu');
  if (existing) existing.remove();
}

/**
 * A real popup menu. This used to be a prompt asking the user to type
 * "rename" or "delete".
 */
function openContextMenu(event, node) {
  closeContextMenu();
  const isFolder = node.type === 'folder';

  const items = [
    { label: '열기', hidden: isFolder, run: () => openNote(node.relative, undefined, { ask: true }) },
    { label: '새 노트', hidden: !isFolder, run: () => newNote(node.relative) },
    { label: '새 폴더', hidden: !isFolder, run: () => newFolder(node.relative) },
    { separator: true },
    { label: '이름 변경', accel: 'F2', run: () => renameItem(node) },
    { label: '복제', run: () => duplicateItem(node) },
    { label: '삭제', accel: 'Del', danger: true, run: () => deleteItem(node) },
    { separator: true },
    { label: '탐색기에서 열기', run: () => api.showInFolder(node.relative) },
  ].filter((item) => !item.hidden);

  const menu = document.createElement('div');
  menu.id = 'contextMenu';
  menu.className = 'context-menu';

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `context-item${item.danger ? ' danger' : ''}`;
    button.innerHTML = `<span>${escapeHtml(item.label)}</span>`;
    if (item.accel) {
      const accel = document.createElement('small');
      accel.textContent = item.accel;
      button.appendChild(accel);
    }
    button.addEventListener('click', () => {
      closeContextMenu();
      Promise.resolve(item.run()).catch((err) => {
        console.error(err);
        showToast(err?.message || String(err));
      });
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);

  // Keep the menu on screen when opened near an edge.
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;

  setTimeout(() => {
    window.addEventListener('click', closeContextMenu, { once: true });
    window.addEventListener('contextmenu', closeContextMenu, { once: true });
  }, 0);
}

async function deleteItem(node) {
  const kind = node.type === 'folder' ? '폴더' : '노트';
  const ok = await confirmDialog(`${kind} 삭제`, `'${node.name}' 을(를) 휴지통으로 보냅니다.`);
  if (!ok) return;

  await flushPending();
  try {
    await api.deleteItem({ relativePath: node.relative });
    if (state.currentPath === node.relative
      || state.currentPath?.startsWith(`${node.relative}/`)) {
      closeNote();
    }
    showToast(`'${node.name}' 을(를) 휴지통으로 보냈습니다.`, 'notice');
  } catch (err) {
    // The delete may have happened before whatever failed, so the tree has to
    // be re-read either way — leaving a note listed that is no longer there is
    // worse than the error itself.
    console.error(err);
    showToast(`삭제하지 못했습니다: ${err?.message || err}`);
  } finally {
    await refreshTree();
  }
}

async function duplicateItem(node) {
  const parent = node.relative.includes('/')
    ? node.relative.slice(0, node.relative.lastIndexOf('/'))
    : '';
  const result = await api.moveItem({
    relativePath: node.relative, targetFolder: parent, copy: true,
  });
  // Copying into the same folder is the one case where "already there" is fine.
  if (result && result.ok === false && result.reason !== 'same') {
    showToast(result.message);
    return;
  }
  await refreshTree();
}

/* ------------------------------------------------------------------ *
 * Move and copy
 * ------------------------------------------------------------------ */

function canDropOn(targetFolder, node = state.dragging) {
  if (!node) return false;
  if (node.relative === targetFolder) return false;
  // Dropping a folder into its own subtree would destroy it.
  if (node.type === 'folder' && targetFolder.startsWith(`${node.relative}/`)) return false;
  return true;
}

async function dropOnto(targetFolder, copy) {
  // Take the dragged node before clearing it — canDropOn reads it, and
  // clearing first made every drop a no-op.
  const node = state.dragging;
  state.dragging = null;
  if (!canDropOn(targetFolder, node)) return;

  await flushPending();
  const result = await api.moveItem({ relativePath: node.relative, targetFolder, copy });
  if (result && result.ok === false) {
    if (result.reason !== 'same') showToast(result.message);
    return;
  }

  // Follow the note that just moved so the user does not lose their place.
  const wasOpen = state.currentPath === node.relative;
  if (!copy && wasOpen) state.currentPath = result.relativePath;
  if (!copy && state.selectedFolder === node.relative) state.selectedFolder = result.relativePath;
  state.expanded.add(targetFolder);

  await refreshTree();
  if (wasOpen && !copy) await openNote(result.relativePath);

  const where = targetFolder || (state.config?.Name || '기본 폴더');
  if (copy) {
    showToast(`'${node.name}' 을(를) '${where}' 로 복사했습니다.`, 'notice');
    return;
  }

  // A stray drag is cheap to make and easy to miss, so say what moved and
  // offer the way back.
  const from = node.relative.includes('/')
    ? node.relative.slice(0, node.relative.lastIndexOf('/'))
    : '';
  showToast(`'${node.name}' 을(를) '${where}' 로 옮겼습니다.`, 'notice', {
    label: '되돌리기',
    run: () => undoMove(result.relativePath, from),
  });
}

async function undoMove(currentRelative, originalFolder) {
  await flushPending();
  const result = await api.moveItem({
    relativePath: currentRelative, targetFolder: originalFolder,
  });
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  const wasOpen = state.currentPath === currentRelative;
  if (wasOpen) state.currentPath = result.relativePath;
  await refreshTree();
  if (wasOpen) await openNote(result.relativePath);
}

async function renameItem(node) {
  const current = node.name;
  const next = await prompt('이름 변경 (F2)', current);
  if (!next || next === current) return;

  await flushPending();
  const result = await api.renameItem({
    relativePath: node.relative,
    newName: next,
    isFolder: node.type === 'folder',
  });
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }

  // Renaming a folder moves everything under it, so remap by prefix — an
  // exact-match check left the open note pointing at a path that no longer
  // exists, and the next autosave would recreate it there.
  const remap = (p) => {
    if (p === node.relative) return result.relativePath;
    if (p && p.startsWith(`${node.relative}/`)) {
      return result.relativePath + p.slice(node.relative.length);
    }
    return p;
  };
  state.currentPath = remap(state.currentPath);
  state.selectedFolder = remap(state.selectedFolder);
  state.expanded = new Set([...state.expanded].map(remap));

  await refreshTree();
  if (state.currentPath) await openNote(state.currentPath);
}

async function refreshTree() {
  state.tree = await api.getTree();
  el.bookDir.textContent = state.config?.Name || state.tree.name || '기본 폴더';
  el.bookDir.title = state.tree.root;
  renderTree();
  renderStatusBar();
}

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

/**
 * Show a folder's description document.
 *
 * Selecting a folder opens it — that is what the marker file inside every
 * folder is for, and why the app hides it from the tree. A folder without
 * one offers to start it rather than showing nothing.
 */
async function openFolder(node) {
  const marker = node.marker || folderMarkerFor(node.relative);

  // The row was highlighted on the way in. Staying put means putting the
  // highlight back on the note that is still open.
  await flushPending();
  if (!(await confirmDiscard())) {
    if (state.currentPath) markActive(state.currentPath);
    return;
  }

  if (!node.marker) {
    showFolderPlaceholder(node);
    return;
  }
  await openNote(marker, node.name);
}

function showFolderPlaceholder(node) {
  clearFrame();
  state.currentPath = null;
  state.bytes = 0;
  state.mtime = 0;
  state.folderTitle = '';
  el.editorRoot.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  el.emptyState.innerHTML = '';

  const heading = document.createElement('h1');
  heading.textContent = node.name;
  el.emptyState.appendChild(heading);

  const line = document.createElement('p');
  line.textContent = '이 폴더에는 아직 설명이 없습니다.';
  el.emptyState.appendChild(line);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'empty-action';
  button.textContent = '폴더 설명 만들기';
  button.addEventListener('click', () => void describeFolder(node));
  el.emptyState.appendChild(button);

  renderStatusBar();
  setStatus('', '준비됨');
}

async function describeFolder(node) {
  await flushPending();
  if (!(await confirmDiscard())) return;
  const result = await api.describeFolder({ relativePath: node.relative });
  if (result && result.ok === false) {
    showToast(result.message);
    return;
  }
  await refreshTree();
  await openNote(result.relativePath, node.name);
  setMode('edit');
}

async function openNote(relative, displayName, { ask = false } = {}) {
  await flushPending();
  if (ask && !(await confirmDiscard())) return;
  // Coming to another note with edit mode still on is how a stray keystroke
  // lands in a note nobody meant to change.
  if (state.returnToBrowse && state.mode === 'edit' && relative !== state.currentPath) {
    await applyMode('browse');
  }
  const note = await api.readNote(relative);

  state.currentPath = note.relativePath;
  state.mtime = note.mtime || 0;
  state.bytes = note.bytes || 0;
  state.baseUrl = note.baseUrl || '';
  state.diskHtml = note.html;
  state.fullHtml = note.html;
  state.pendingDoc = null;
  state.holdMessage = '';
  attachState.selected = '';
  state.dirty = false;

  const segments = note.relativePath.split('/');
  let path = '';
  for (let i = 0; i < segments.length - 1; i++) {
    path = path ? `${path}/${segments[i]}` : segments[i];
    state.expanded.add(path);
  }
  state.selectedFolder = segments.length > 1 ? segments.slice(0, -1).join('/') : '';

  el.emptyState.classList.add('hidden');
  el.editorRoot.classList.remove('hidden');
  // A folder's description is shown under the folder's name; the marker file
  // name is an implementation detail nobody needs to read.
  state.folderTitle = displayName || '';
  el.noteTitle.textContent = displayName
    || note.relativePath.split('/').pop().replace(/\.(htm|html)$/i, '');
  el.notePath.textContent = note.relativePath;

  await renderNote(note.html, note.baseUrl);

  el.sourceEditor.value = state.mode === 'source' ? state.fullHtml : '';

  await api.setConfig({ lstPage: note.relativePath });
  state.config.lstPage = note.relativePath;

  renderTree();
  renderStatusBar();
  setStatus('saved', '불러옴');
}

function closeNote() {
  clearFrame();
  el.emptyState.innerHTML = emptyStateMarkup;
  state.folderTitle = '';
  state.currentPath = null;
  state.bytes = 0;
  state.mtime = 0;
  state.fullHtml = '';
  state.pendingDoc = null;
  state.holdMessage = '';
  state.lastSavedBody = '';
  state.dirty = false;
  el.editorRoot.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  renderStatusBar();
  setStatus('', '준비됨');
}

async function newNote(parentFolder) {
  await flushPending();
  if (!(await confirmDiscard())) return;
  const parent = parentFolder ?? state.selectedFolder ?? '';
  const title = await prompt('새 노트 이름', '새 노트');
  if (!title) return;

  const templateName = await chooseTemplate();
  if (templateName === undefined) return;  // cancelled

  const created = await api.createNote({ parentRelative: parent, title, templateName });
  if (created && created.ok === false) {
    showToast(created.message);
    return;
  }
  if (parent) state.expanded.add(parent);
  await refreshTree();
  await openNote(created.relativePath);
  setMode('edit');
}

async function newFolder(parentFolder) {
  const parent = parentFolder ?? state.selectedFolder ?? '';
  const name = await prompt('새 폴더 이름', '새 폴더');
  if (!name) return;
  const created = await api.createFolder({ parentRelative: parent, name });
  if (created && created.ok === false) {
    showToast(created.message);
    return;
  }
  if (parent) state.expanded.add(parent);
  state.expanded.add(created.relativePath);
  state.selectedFolder = created.relativePath;
  await refreshTree();
}

/* ------------------------------------------------------------------ *
 * Editor
 *
 * The note is rendered as the document it actually is, inside an iframe, and
 * edited in place with designMode. Nothing is parsed into a schema, so tables,
 * <font>, inline styles and the note's own stylesheet survive editing — which
 * is how a note like this is written in the first place.
 * ------------------------------------------------------------------ */

const ESCAPE_ATTR = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };
const escapeAttr = (value) => String(value).replace(/[&"<>]/g, (c) => ESCAPE_ATTR[c]);

/**
 * Everything injected into the note lives in <head>.
 *
 * Saving takes body.innerHTML, so nothing added here can ever reach the file.
 * That is what makes it safe to restyle a note for viewing without touching
 * what the note actually is.
 */
/**
 * Put tags at the very start of `<head>`.
 *
 * `<base>` belongs here: it has to precede anything in the head that carries a
 * URL, or those resolve against the wrong root.
 */
function injectHead(html, tags) {
  if (!tags) return html;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + tags);
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${tags}</head>`);
  }
  return `<head>${tags}</head>${html}`;
}

/**
 * Put tags at the end of `<head>`, after the note's own stylesheet.
 *
 * The dark rendering has to go here. Placed first, a note's own
 * `td { color: #222 }` beats the rule that hands text colour back to the theme
 * — same specificity, and whoever comes last wins — leaving dark text on a dark
 * background. Rules with a class or an id still win, so a note keeps the
 * colours it went out of its way to name.
 *
 * This is also where applyNoteSurface has always put it, so the note now looks
 * the same whether it was opened in dark mode or switched into it.
 */
function appendHead(html, tags) {
  if (!tags) return html;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, (m) => tags + m);
  return injectHead(html, tags);
}

const VIEW_STYLE_ID = 'csfreenote-view-style';

function noteViewStyle(html) {
  return state.noteSurface === 'dark'
    ? `<style id="${VIEW_STYLE_ID}">${darkNoteCss(html)}</style>`
    : '';
}

/** Apply or remove the dark rendering on the note that is already loaded. */
function applyNoteSurface() {
  el.frame.classList.toggle('dark-surface', state.noteSurface === 'dark');
  if (!frameDoc || !frameDoc.head) return;
  const existing = frameDoc.getElementById(VIEW_STYLE_ID);
  if (state.noteSurface !== 'dark') {
    if (existing) existing.remove();
    return;
  }
  const css = darkNoteCss(state.diskHtml || frameDoc.documentElement.outerHTML);
  if (existing) {
    existing.textContent = css;
    return;
  }
  const style = frameDoc.createElement('style');
  style.id = VIEW_STYLE_ID;
  style.textContent = css;
  frameDoc.head.appendChild(style);
}

/** Current body markup as the browser sees it, or null when nothing is loaded. */
function frameBody() {
  if (!frameDoc || !frameDoc.body) return null;

  // Decide here, act on a copy.
  //
  // A <span> that only restates what it would inherit says nothing, and the
  // editor plants them: Chromium keeps a typing style for the caret and writes
  // it out when it is unsure the new position would hold it — walking the caret
  // up into the note's title row and back is enough — after which every line
  // made from that line inherits it.
  //
  // Whether a span says anything can only be told from the live document, where
  // the stylesheet actually applies. But changing the live document behind the
  // editor's back is what broke undo: the browser remembers the edits it made,
  // and when the text underneath has moved since, undo puts words back in the
  // wrong places. So the live document is only read. The copy is what gets
  // trimmed, and the copy is what is written to the file.
  const live = frameDoc.body;
  const copy = live.cloneNode(true);
  const mine = [...live.querySelectorAll('span')];
  const theirs = [...copy.querySelectorAll('span')];
  if (mine.length !== theirs.length) return copy.innerHTML;   // not the same tree; leave it

  const view = frameDoc.defaultView;
  for (let i = 0; i < mine.length; i += 1) {
    if (!saysNothing(mine[i], view)) continue;
    const twin = theirs[i];
    twin.replaceWith(...twin.childNodes);
  }
  return copy.innerHTML;
}

/**
 * Does this <span> only repeat what it would inherit?
 *
 * Judged on font-size and colour alone, and on the computed value, which is
 * resolved — px and rgb() — so the comparison is exact. font-family is not:
 * the computed value is the list as written, and "맑은 고딕" and "Malgun
 * Gothic" are one face under two names.
 *
 * Formatting the author applied is never in question. The editor emits <b>,
 * <i> and <font> rather than styled spans, so none of it arrives as a span at
 * all; and a span that changes anything fails the comparison and stays.
 */
function saysNothing(span, view) {
  if ([...span.attributes].some((a) => a.name !== 'style')) return false;
  if (!span.style.length) return false;
  if (![...span.style].every((d) => d === 'font-size' || d === 'color')) return false;
  const parent = span.parentElement;
  if (!parent) return false;
  const mine = view.getComputedStyle(span);
  const theirs = view.getComputedStyle(parent);
  return [...span.style].every((d) => (d === 'font-size'
    ? mine.fontSize === theirs.fontSize
    : mine.color === theirs.color));
}

function onFrameInput() {
  if (state.suppressChange || !state.currentPath || state.mode !== 'edit') return;
  // Nothing touches the document here. What the file should not keep is taken
  // off the copy in frameBody(), where undo cannot be hurt by it.
  state.dirty = true;
  scheduleSave();
}

/**
 * Intercept pasted images.
 *
 * Left alone, Chromium inserts a `blob:` URL that is only valid for the life
 * of this document — the picture would look fine until the app was restarted
 * and then be permanently broken. Instead the bytes are written into the book
 * and referenced by a relative path, so the image survives a restart and
 * travels with the notes.
 */
// What survives a paste, and what it may wear.
//
// Structure and meaning stay: the lines, links, tables, lists and emphasis.
// Appearance goes, because the note already says how it looks and a paste that
// brings its own font is how a document ends up with six of them. Colour is the
// exception — a note uses blue and red to mean something, so they are content.
const PASTE_TAGS = new Set(['P', 'BR', 'DIV', 'SPAN', 'A', 'B', 'STRONG', 'I', 'EM',
  'U', 'S', 'STRIKE', 'DEL', 'INS', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COL', 'COLGROUP',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'IMG']);
const PASTE_GONE = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD',
  'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT']);
const PASTE_STYLE = ['color', 'font-weight', 'font-style', 'text-decoration',
  'text-decoration-line'];
const PASTE_ATTR = { A: ['href', 'title'], IMG: ['src', 'alt'],
  TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
const SAFE_HREF = /^(https?:|mailto:|#|\/|\.|[^:]*$)/i;
const SAFE_SRC = /^(https?:|data:image\/)/i;

/** Clean the pasted markup down to what the note should keep. */
function cleanPaste(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const node of [...doc.body.querySelectorAll('*')]) {
    if (!node.isConnected) continue;
    if (PASTE_GONE.has(node.nodeName) || node.nodeName.includes(':')) {
      // Word's own namespaces hold nothing; scripts and styles must not travel.
      if (node.nodeName.includes(':')) node.replaceWith(...node.childNodes);
      else node.remove();
      continue;
    }
    if (!PASTE_TAGS.has(node.nodeName)) {
      // Unknown but harmless — keep the words, drop the wrapper.
      if (node.nodeName === 'FONT') {
        const colour = node.getAttribute('color');
        if (colour) {
          const span = doc.createElement('span');
          span.style.color = colour;
          span.append(...node.childNodes);
          node.replaceWith(span);
          continue;
        }
      }
      node.replaceWith(...node.childNodes);
      continue;
    }

    // Read what is worth keeping before stripping, then put it back.
    const kept = {};
    for (const name of PASTE_ATTR[node.nodeName] || []) {
      const value = node.getAttribute(name);
      if (value !== null) kept[name] = value;
    }
    const styles = PASTE_STYLE
      .map((d) => [d, node.style.getPropertyValue(d)])
      .filter(([, v]) => v);

    for (const attr of [...node.attributes]) node.removeAttribute(attr.name);

    if (kept.href !== undefined && !SAFE_HREF.test(kept.href.trim())) delete kept.href;
    if (kept.src !== undefined && !SAFE_SRC.test(kept.src.trim())) delete kept.src;
    for (const [name, value] of Object.entries(kept)) node.setAttribute(name, value);
    if (styles.length) node.setAttribute('style', styles.map(([d, v]) => `${d}: ${v}`).join('; '));

    // A link with nowhere to go, or a picture with no picture, is just words.
    if (node.nodeName === 'A' && kept.href === undefined) node.replaceWith(...node.childNodes);
    else if (node.nodeName === 'IMG' && kept.src === undefined) node.remove();
    else if (node.nodeName === 'SPAN' && !node.attributes.length) node.replaceWith(...node.childNodes);
  }

  // Comments say nothing on the page.
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walk.nextNode()) comments.push(walk.currentNode);
  comments.forEach((c) => c.remove());

  return doc.body.innerHTML;
}

function onFramePaste(event) {
  if (state.mode !== 'edit' || !state.currentPath) return;

  const data = event.clipboardData;
  const items = Array.from(data?.items || []);
  const images = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (images.length) {
    event.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (file) void insertImage(file);
    }
    return;
  }

  const plain = data ? data.getData('text/plain') : '';
  const html = data ? data.getData('text/html') : '';
  const asText = state.pastePlain;
  state.pastePlain = false;

  if (asText || !html) {
    if (!plain) return;
    event.preventDefault();
    frameDoc.execCommand('insertText', false, plain);
    onFrameInput();
    return;
  }

  event.preventDefault();
  frameDoc.execCommand('insertHTML', false, cleanPaste(html));
  onFrameInput();
}

async function insertImage(file) {
  try {
    setStatus('saving', '이미지 저장 중…');
    const buffer = await file.arrayBuffer();
    const saved = await api.saveImage({
      relativePath: state.currentPath,
      mimeType: file.type,
      data: new Uint8Array(buffer),
    });
    if (!frameDoc) return;
    el.frame.contentWindow.focus();
    frameDoc.execCommand('insertHTML', false,
      `<img src="${escapeHtml(saved.href)}" alt="">`);
    onFrameInput();
    setStatus('saving', '저장 대기…');
  } catch (err) {
    console.error(err);
    setStatus('error', '이미지 저장 실패');
    showToast(`이미지를 저장하지 못했습니다: ${err?.message || err}`);
  }
}

// Links must not navigate the note away; hand them to the OS browser instead.
function onFrameClick(event) {
  const anchor = event.target && event.target.closest && event.target.closest('a[href]');
  if (!anchor) return;
  const href = anchor.getAttribute('href') || '';
  if (/^https?:/i.test(href)) {
    event.preventDefault();
    api.openExternal(anchor.href);
  } else if (href.startsWith('#')) {
    // in-note anchor: let it be
  } else {
    event.preventDefault();
  }
}

/**
 * Clicking a picture selects it.
 *
 * Chromium leaves the selection collapsed in the text beside an image, so
 * Delete had nothing to act on and there was no way to take a picture out of a
 * note with the mouse at all. Selecting it hands the job back to the browser:
 * Delete, Backspace, cut and typing over it then all work, and every one of
 * them lands in the undo stack. That is why this sets a selection instead of
 * removing the element — reaching into the document is what once made Ctrl+Z
 * put words back in the wrong places.
 *
 * Bubble phase on purpose. Chromium settles its own collapsed selection first,
 * and ours has to be the one that stands.
 */
function selectClickedImage(event) {
  if (state.mode !== 'edit' || !frameDoc) return;
  const img = event.target && event.target.closest ? event.target.closest('img') : null;
  if (!img) return;
  const view = frameDoc.defaultView;
  if (!view) return;
  const range = frameDoc.createRange();
  range.selectNode(img);
  const selection = view.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Key events raised inside the iframe never reach the app window, so the
// same shortcut handler is attached to the note document as well.
/** Where the caret is drawn, or the cell itself when it has no rect to give. */
function caretRect(range, fallback) {
  const rects = range.getClientRects();
  if (rects.length) return rects[0];
  const cloned = range.cloneRange();
  cloned.selectNodeContents(fallback);
  const inner = cloned.getClientRects();
  return inner.length ? inner[0] : fallback.getBoundingClientRect();
}

/** The block the caret sits in — the thing a line-move steps out of. */
function caretBlock() {
  const selection = frameDoc.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const start = selection.getRangeAt(0).startContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
  if (!el || !frameDoc.body.contains(el)) return null;
  const block = el.closest(BLOCK_SELECTOR);
  return block && block !== frameDoc.body ? block : null;
}

/** Put the caret in the cell of `row` that sits under `x`. */
function enterRowAt(row, x, fromAbove) {
  const cells = [...row.cells];
  if (!cells.length) return false;
  // Nearest by distance, not the first that happens to contain x: a caret at
  // the very start of the block below sits a pixel outside the first cell, and
  // falling through to the last one put it at the wrong end of the row.
  const target = cells.reduce((best, cell) => {
    const box = cell.getBoundingClientRect();
    const gap = x < box.left ? box.left - x : (x > box.right ? x - box.right : 0);
    return best && best.gap <= gap ? best : { cell, gap };
  }, null).cell;

  const box = target.getBoundingClientRect();
  const style = frameDoc.defaultView.getComputedStyle(target);
  const y = fromAbove
    ? box.top + (parseFloat(style.paddingTop) || 0) + 1
    : box.bottom - (parseFloat(style.paddingBottom) || 0) - 1;
  const landing = frameDoc.caretRangeFromPoint(
    Math.min(Math.max(x, box.left + 1), box.right - 1), y);

  const placed = frameDoc.createRange();
  if (landing && target.contains(landing.startContainer)) {
    placed.setStart(landing.startContainer, landing.startOffset);
  } else {
    placed.selectNodeContents(target);
    placed.collapse(fromAbove);
  }
  placed.collapse(true);
  const selection = frameDoc.getSelection();
  selection.removeAllRanges();
  selection.addRange(placed);
  return true;
}

/**
 * Step into a table from outside it, landing in the column being left.
 *
 * The mirror of stepping out. Without it, arrowing up into a table drops the
 * caret in whichever cell the document happens to end with, which is rarely the
 * one under the cursor.
 */
function enterTableByRow(down) {
  const block = caretBlock();
  if (!block || block.closest('table')) return false;

  const selection = frameDoc.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
  const caret = caretRect(selection.getRangeAt(0), block);
  const box = block.getBoundingClientRect();
  const style = frameDoc.defaultView.getComputedStyle(block);
  const onEdge = down
    ? caret.bottom >= box.bottom - (parseFloat(style.paddingBottom) || 0) - 2
    : caret.top <= box.top + (parseFloat(style.paddingTop) || 0) + 2;
  if (!onEdge) return false;

  const beside = down ? block.nextElementSibling : block.previousElementSibling;
  const table = beside && beside.tagName === 'TABLE' ? beside : null;
  if (!table || !table.rows.length) return false;

  const row = down ? table.rows[0] : table.rows[table.rows.length - 1];
  return enterRowAt(row, caret.left, down);
}

/**
 * Take the caret up or down a column.
 *
 * Chromium moves it by line, and a cell holding one line has no next line — so
 * Down out of the middle of a table lands in the cell to the *right*, then
 * wraps to the start of the row below, walking the document rather than the
 * grid. Inside a cell with several lines the browser is right and is left
 * alone; only the step out of the last line is taken over.
 *
 * The horizontal position is kept by asking the document what is at the same x
 * in the row being moved to, which is what makes a column feel like a column.
 */
function moveCaretByRow(down) {
  const cell = currentCell();
  if (!cell) return enterTableByRow(down);
  const row = cell.closest('tr');
  const table = cell.closest('table');
  if (!row || !table) return false;

  const selection = frameDoc.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  // Measure against the line the caret is on, not the cell. A collapsed range
  // in an empty paragraph has no box of its own, and falling back to the cell
  // put every empty line at the cell's top edge — so pressing Up from a blank
  // line made by Enter looked like leaving the cell, whichever line it was.
  const caret = caretRect(range, caretBlock() || cell);
  const box = cell.getBoundingClientRect();
  const style = frameDoc.defaultView.getComputedStyle(cell);
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;

  // Still a line to go inside this cell? Let the browser have it.
  const onEdge = down
    ? caret.bottom >= box.bottom - padBottom - 2
    : caret.top <= box.top + padTop + 2;
  if (!onEdge) return false;

  const rows = [...table.rows];
  const next = rows[rows.indexOf(row) + (down ? 1 : -1)];
  if (!next || !next.cells.length) {
    // Off the end of the grid: step out of the table rather than sideways into
    // the cell the document happens to hold next. Land inside the block on the
    // other side, not in the gap between them, where there is nothing to type
    // into.
    const beyond = down ? table.nextElementSibling : table.previousElementSibling;
    const out = frameDoc.createRange();
    if (beyond) {
      out.selectNodeContents(beyond);
      out.collapse(down);
    } else if (down) {
      out.setStartAfter(table);
    } else {
      out.setStartBefore(table);
    }
    out.collapse(true);
    selection.removeAllRanges();
    selection.addRange(out);
    return true;
  }
  const target = next.cells[Math.min(cell.cellIndex, next.cells.length - 1)];
  if (!target) return false;

  const to = target.getBoundingClientRect();
  const x = Math.min(Math.max(caret.left, to.left + 1), to.right - 1);
  const y = down ? to.top + padTop + 1 : to.bottom - padBottom - 1;
  const landing = frameDoc.caretRangeFromPoint(x, y);
  const placed = frameDoc.createRange();
  if (landing && target.contains(landing.startContainer)) {
    placed.setStart(landing.startContainer, landing.startOffset);
  } else {
    placed.selectNodeContents(target);
    placed.collapse(down);
  }
  placed.collapse(true);
  selection.removeAllRanges();
  selection.addRange(placed);
  return true;
}

function onFrameKeydown(event) {
  // Ctrl+Shift+V pastes the words alone. The paste event carries no modifiers,
  // so the intent is written down here for it to read a moment later.
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'V' || event.key === 'v')) {
    state.pastePlain = true;
  }
  if (state.mode === 'edit' && !event.ctrlKey && !event.metaKey && !event.altKey
      && (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      && moveCaretByRow(event.key === 'ArrowDown')) {
    event.preventDefault();
    return;
  }
  handleShortcut(event);
}

const EDIT_STYLE_ID = 'csfreenote-edit-style';

// A block with nothing in it lays out at zero height, so there is no target to
// click and the caret cannot be put there. Notes written in other editors are
// full of them — dead spots in the middle of the page.
//
// Filling them with <br> would fix that and change the file: every note holding
// one grows by the height it gains. This gives them a target while the note is
// being edited instead, and reaches nothing. Saving reads <body>; a rule that lives
// in <head> cannot get into the file, which is the same route the dark
// rendering takes.
const EDIT_CSS = 'p:empty, div:empty, td:empty, li:empty { min-height: 1.2em; }';

/** Show empty blocks while editing, so there is something to click. */
function applyEditAffordances() {
  if (!frameDoc || !frameDoc.head) return;
  const existing = frameDoc.getElementById(EDIT_STYLE_ID);
  if (state.mode !== 'edit') {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const style = frameDoc.createElement('style');
  style.id = EDIT_STYLE_ID;
  style.textContent = EDIT_CSS;
  frameDoc.head.appendChild(style);
}

function applyEditableState() {
  if (!frameDoc) return;
  const editing = state.mode === 'edit';
  try {
    frameDoc.designMode = editing ? 'on' : 'off';
    if (editing) {
      // Emit <b>/<i>/<font> rather than styled spans — closer to what these
      // notes already contain.
      frameDoc.execCommand('styleWithCSS', false, 'false');
    }
  } catch (err) {
    console.error(err);
  }
  // The highlight belongs to the view that drew it.
  if (!el.findBar.classList.contains('hidden')) {
    findState.query = '';
    findState.at = 0;
    clearNoteHighlight();
    el.findCount.textContent = el.findInput.value ? 'Enter로 찾기' : '';
  }
  applyEditAffordances();
  hideTableHandles();
  hideColumnGrip();
  el.frame.classList.toggle('editing', editing);
}

/** Load a note document into the frame and resolve once it is live. */
function renderNote(html, baseUrl) {
  return new Promise((resolve) => {
    const onLoad = () => {
      el.frame.removeEventListener('load', onLoad);
      frameDoc = el.frame.contentDocument;
      if (frameDoc) {
        applyNoteSurface();
        frameDoc.addEventListener('input', onFrameInput);
        frameDoc.addEventListener('paste', onFramePaste, true);
        frameDoc.addEventListener('click', onFrameClick, true);
          frameDoc.addEventListener('click', selectClickedImage);
        frameDoc.addEventListener('keydown', onFrameKeydown);
        frameDoc.addEventListener('mousemove', (event) => {
          const box = el.frame.getBoundingClientRect();
          updateTableHandles(event.clientX + box.left, event.clientY + box.top);
        });
        frameDoc.addEventListener('mouseleave', scheduleHideTableHandles);
        frameDoc.addEventListener('scroll', hideTableHandles, true);
      }
      applyEditableState();
      state.lastSavedBody = frameBody() ?? '';
      state.suppressChange = false;
      resolve();
    };
    state.suppressChange = true;
    el.frame.addEventListener('load', onLoad);
    const base = baseUrl ? `<base href="${escapeAttr(baseUrl)}">` : '';
    el.frame.srcdoc = appendHead(injectHead(html, base), noteViewStyle(html));
  });
}

function clearFrame() {
  frameDoc = null;
  el.frame.srcdoc = '';
}

const EXEC_COMMANDS = {
  bold: ['bold'],
  italic: ['italic'],
  underline: ['underline'],
  strike: ['strikeThrough'],
  h1: ['formatBlock', 'h1'],
  h2: ['formatBlock', 'h2'],
  bullet: ['insertUnorderedList'],
  ordered: ['insertOrderedList'],
  quote: ['formatBlock', 'blockquote'],
  hr: ['insertHorizontalRule'],
  alignLeft: ['justifyLeft'],
  alignCenter: ['justifyCenter'],
  alignRight: ['justifyRight'],
  undo: ['undo'],
  redo: ['redo'],
};

/**
 * Apply one of the saved formats.
 *
 * Blank fields are left alone, so a preset can change only what it names. The
 * three toggles are set rather than flipped: applying "굵게" to text that is
 * already bold has to leave it bold.
 */
function applyFormatPreset(index) {
  const preset = state.formats[index];
  if (!preset || !frameDoc || state.mode !== 'edit') return;

  const selection = frameDoc.getSelection();
  if (!selection || selection.isCollapsed) {
    showToast('서식을 적용할 부분을 먼저 선택하세요.', 'notice');
    return;
  }

  el.frame.contentWindow.focus();
  const run = (command, value) => {
    try {
      frameDoc.execCommand(command, false, value);
    } catch (err) {
      console.error(command, err);
    }
  };
  const setToggle = (command, wanted) => {
    if (wanted === null || wanted === undefined) return;
    let active = false;
    try {
      active = frameDoc.queryCommandState(command);
    } catch { /* treat as off */ }
    if (active !== wanted) run(command);
  };

  if (preset.font) run('fontName', preset.font);
  if (preset.size) run('fontSize', String(preset.size));
  if (preset.color) run('foreColor', preset.color);
  if (preset.highlight) run('hiliteColor', preset.highlight);
  setToggle('bold', preset.bold);
  setToggle('italic', preset.italic);
  setToggle('underline', preset.underline);
  if (preset.align) {
    run(`justify${preset.align[0].toUpperCase()}${preset.align.slice(1)}`);
  }

  onFrameInput();
}

/**
 * True when execCommand will act where the caret actually is.
 *
 * What throws it off is a block laid out at zero height: it reports success and
 * drops the text somewhere else, usually straight into `<body>`. Give the same
 * block a line to sit on and the command behaves. The edit-mode stylesheet does
 * exactly that for empty blocks, so this normally holds — but a note whose own
 * CSS collapses one still falls back to placing the text directly.
 */
function caretTakesEditCommand(range) {
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) return true;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!el && el.getBoundingClientRect().height > 0;
}

/**
 * Stamp the current date and time where the caret is.
 *
 * execCommand is the only way an edit gets into the browser's undo stack, so
 * use it wherever it can be trusted — otherwise Ctrl-Z after F5 undoes the
 * sentence typed before the stamp and leaves the stamp sitting there.
 *
 * Where it cannot be trusted, or where it silently declines, the text is placed
 * directly and that one insertion is not undoable. That is the lesser cost: a
 * stamp in the wrong place is worse than a stamp that cannot be taken back.
 */
function insertDateTime() {
  if (!frameDoc || state.mode !== 'edit') return;

  const stamp = formatDateTime(state.dateFormat || DEFAULT_FORMAT);
  const selection = frameDoc.getSelection();
  const range = selection && selection.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : null;
  const inNote = range && frameDoc.body.contains(range.commonAncestorContainer);

  el.frame.contentWindow.focus();

  if (inNote && selection && caretTakesEditCommand(range)) {
    selection.removeAllRanges();
    selection.addRange(range);
    const before = frameDoc.body.textContent;
    frameDoc.execCommand('insertText', false, stamp);
    if (frameDoc.body.textContent !== before) {
      onFrameInput();
      return;
    }
    // Declined — an unfocused window does this. Place it directly instead.
  }

  const text = frameDoc.createTextNode(stamp);
  if (inNote) {
    range.deleteContents();
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else {
    // No caret in the note yet — put it at the end, which is where someone
    // clicking the button without having clicked into the text would expect.
    frameDoc.body.appendChild(text);
  }

  el.frame.contentWindow.focus();
  onFrameInput();
}

/** The cell the caret is in, or null. */
function currentCell() {
  if (!frameDoc) return null;
  const selection = frameDoc.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const start = selection.getRangeAt(0).startContainer;
  const el = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
  const cell = el ? el.closest('td, th') : null;
  return cell && frameDoc.body.contains(cell) ? cell : null;
}

function freshCell(model) {
  const cell = frameDoc.createElement(model && model.tagName === 'TH' ? 'th' : 'td');
  // An empty cell lays out at zero height and cannot be clicked into.
  cell.appendChild(frameDoc.createElement('br'));
  return cell;
}

/**
 * Swap a table for a changed copy, through execCommand.
 *
 * Rewriting the rows in place would work and would not be undoable — there is
 * no execCommand for adding a row, and a DOM change the browser did not make is
 * a change it cannot take back. Replacing the whole element is something it
 * does record, so Ctrl-Z puts the row back.
 */
function replaceTable(table, nextHtml) {
  const selection = frameDoc.getSelection();
  el.frame.contentWindow.focus();
  if (selection) {
    const pick = frameDoc.createRange();
    pick.selectNode(table);
    selection.removeAllRanges();
    selection.addRange(pick);
    const before = frameDoc.body.innerHTML;
    frameDoc.execCommand('insertHTML', false, nextHtml);
    if (frameDoc.body.innerHTML !== before) {
      onFrameInput();
      return;
    }
    // Declined — an unfocused window does this.
  }
  if (nextHtml) table.outerHTML = nextHtml;
  else table.remove();
  onFrameInput();
}

/**
 * Add or remove a row or a column around the caret.
 *
 * Merged cells are refused rather than mangled: with a colspan in play the
 * column a cell sits in is not its index, so inserting by index would shear the
 * table.
 */
function editTable(action, target) {
  const cell = target || currentCell();
  if (!cell || !frameDoc.body.contains(cell)) return;
  const table = cell.closest('table');
  const row = cell.closest('tr');
  if (!table || !row) return;

  if (table.querySelector('[colspan], [rowspan]')) {
    showToast('셀이 병합된 표는 행·열을 바꿀 수 없습니다. 소스 탭에서 고쳐 주세요.', 'notice');
    return;
  }

  const rows = [...table.rows];
  const index = cell.cellIndex;
  // Measured on the live table — the copy below is detached and has no style.
  const columnExtra = rows[0] && rows[0].cells[0] ? boxExtra(rows[0].cells[0]) : 0;
  // The room the columns take up now — not the table's outer box, which
  // also carries the table's own border.
  const columnRoom = rows[0]
    ? [...rows[0].cells].reduce((total, td) => total + td.getBoundingClientRect().width, 0)
    : 0;
  const copy = table.cloneNode(true);
  const copyRows = [...copy.rows];
  const at = rows.indexOf(row);

  if (action === 'rowAbove' || action === 'rowBelow') {
    const model = copyRows[at];
    const fresh = frameDoc.createElement('tr');
    for (const source of model.cells) fresh.appendChild(freshCell(source));
    model.parentNode.insertBefore(fresh, action === 'rowBelow' ? model.nextSibling : model);
  } else if (action === 'rowDelete') {
    if (copyRows.length <= 1) {
      replaceTable(table, '');
      return;
    }
    copyRows[at].remove();
  } else if (action === 'colLeft' || action === 'colRight') {
    const where = action === 'colRight' ? index + 1 : index;
    for (const target of copyRows) {
      target.insertBefore(freshCell(target.cells[index]), target.cells[where] || null);
    }
    rescaleColumns(copy, columnRoom, columnExtra);
  } else if (action === 'colDelete') {
    if (copyRows[0].cells.length <= 1) {
      replaceTable(table, '');
      return;
    }
    for (const target of copyRows) {
      if (target.cells[index]) target.cells[index].remove();
    }
    rescaleColumns(copy, columnRoom, columnExtra);
  } else {
    return;
  }

  replaceTable(table, copy.outerHTML);
}

/**
 * Row and column controls, drawn at the edge being pointed at.
 *
 * A toolbar button has to guess which table is meant, and the caret is a bad
 * way to ask: 노트 양식 keeps the whole note inside a layout table, so the
 * buttons were always lit and a stray click took a row out of the note's own
 * frame. Pointing at an edge says which table, which row and which side, and
 * shows it while you decide.
 *
 * The controls live in the app, not in the note. Anything put inside the note's
 * <body> is in the file at the next save.
 */
const HANDLE_SIZE = 18;
// How close to the table's left or top edge the pointer has to come.
const HANDLE_GUTTER = 28;

/** What the pointer is over: a cell, and which edges it is nearest. */
let handleTarget = null;

let handleHideTimer = null;

/** Leaving the note does not mean leaving the controls — they sit outside it. */
function scheduleHideTableHandles() {
  clearTimeout(handleHideTimer);
  handleHideTimer = setTimeout(hideTableHandles, 400);
}

function keepTableHandles() {
  clearTimeout(handleHideTimer);
}

function hideTableHandles() {
  clearTimeout(handleHideTimer);
  handleTarget = null;
  for (const key of ['rowInsert', 'colInsert', 'rowRemove', 'colRemove']) {
    el[key].classList.remove('on');
  }
}

function placeHandle(button, left, top) {
  button.style.left = `${Math.round(left)}px`;
  button.style.top = `${Math.round(top)}px`;
  button.classList.add('on');
}

function updateTableHandles(clientX, clientY) {
  if (state.mode !== 'edit' || !frameDoc || !frameDoc.body) {
    hideTableHandles();
    return;
  }
  const frame = el.frame.getBoundingClientRect();
  const at = frameDoc.elementFromPoint(clientX - frame.left, clientY - frame.top);
  const cell = at ? at.closest('td, th') : null;
  const row = cell ? cell.closest('tr') : null;
  const table = cell ? cell.closest('table') : null;
  if (!cell || !row || !table) {
    hideTableHandles();
    hideColumnGrip();
    return;
  }

  const cellBox = cell.getBoundingClientRect();
  const tableBox = table.getBoundingClientRect();
  const inFrame = (box) => ({
    left: box.left + frame.left, top: box.top + frame.top,
    right: box.right + frame.left, bottom: box.bottom + frame.top,
  });
  const c = inFrame(cellBox);
  const t = inFrame(tableBox);
  keepTableHandles();
  for (const key of ['rowInsert', 'colInsert', 'rowRemove', 'colRemove']) {
    el[key].classList.remove('on');
  }

  // Which half of the cell the pointer is in decides which side a new row or
  // column goes — so two buttons cover above, below, left and right.
  const edge = clientY < (c.top + c.bottom) / 2 ? 'top' : 'bottom';
  const side = clientX < (c.left + c.right) / 2 ? 'left' : 'right';

  // Only near the table's own margin. 노트 양식 keeps the whole note inside a
  // layout table; without this the controls would hang over every line of it.
  const half = HANDLE_SIZE / 2;
  const nearLeft = clientX - t.left <= HANDLE_GUTTER;
  const nearTop = clientY - t.top <= HANDLE_GUTTER;
  updateColumnGrip(clientX, clientY, cell, c, t);
  // Making a table and setting its column widths stay on; adding and removing
  // rows waits to be asked for. 노트 양식 writes the whole note inside a layout
  // table, where a delete marker over the text is a mistake waiting to happen.
  if (!state.tableEditing) return;
  if (!nearLeft && !nearTop) {
    hideTableHandles();
    return;
  }
  handleTarget = { cell, edge, side };

  // Straddling the table's edge, not floating off to the side: the pointer is
  // already within a finger's width of it, and anything further means crossing
  // out of the frame to reach a button.
  if (nearLeft) {
    placeHandle(el.rowInsert, t.left - half, (edge === 'top' ? c.top : c.bottom) - half);
    placeHandle(el.rowRemove, t.left - half, (c.top + c.bottom) / 2 - half);
  }
  if (nearTop) {
    placeHandle(el.colInsert, (side === 'left' ? c.left : c.right) - half, t.top - half);
    placeHandle(el.colRemove, (c.left + c.right) / 2 - half, t.top - half);
  }
}

const MIN_COLUMN = 30;

/** Which boundary is being dragged, and what the pair started at. */
let columnDrag = null;

function hideColumnGrip() {
  if (columnDrag) return;
  el.colGrip.classList.remove('on');
  el.colGrip.dataset.index = '';
}

/**
 * Offer a grip on a column boundary.
 *
 * Only below the gutter that the insert and delete controls own — otherwise
 * the two would sit on the same boundary at the same point, since a new column
 * goes in exactly where an existing one ends.
 *
 * Only on tables laid out fixed, which is what this app makes. An auto table
 * re-divides its columns from their content, so a width set by dragging would
 * not hold, and pinning one down means changing how a note that already exists
 * is drawn.
 */
function updateColumnGrip(clientX, clientY, cell, c, t) {
  if (columnDrag) return;
  const table = cell.closest('table');
  const row = cell.closest('tr');
  if (!table || !row || frameDoc.defaultView.getComputedStyle(table).tableLayout !== 'fixed') {
    hideColumnGrip();
    return;
  }
  if (clientY <= t.top + HANDLE_GUTTER || clientY >= t.bottom) {
    hideColumnGrip();
    return;
  }

  // Inner boundaries only — the table's own outer edges are not a column pair.
  const index = cell.cellIndex;
  const last = row.cells.length - 1;
  let boundary = null;
  let leftIndex = null;
  if (index > 0 && Math.abs(clientX - c.left) <= 5) {
    boundary = c.left;
    leftIndex = index - 1;
  } else if (index < last && Math.abs(clientX - c.right) <= 5) {
    boundary = c.right;
    leftIndex = index;
  }
  if (boundary === null) {
    hideColumnGrip();
    return;
  }

  el.colGrip.style.left = `${Math.round(boundary - 3)}px`;
  el.colGrip.style.top = `${Math.round(t.top + HANDLE_GUTTER)}px`;
  el.colGrip.style.height = `${Math.round(t.bottom - t.top - HANDLE_GUTTER)}px`;
  el.colGrip.classList.add('on');
  el.colGrip.dataset.index = String(leftIndex);
  columnGripTable = table;
}

let columnGripTable = null;

/**
 * The measured width of a cell, and what to write to keep it.
 *
 * getBoundingClientRect gives the border box — content plus padding plus
 * border. style.width sets the content box. Writing one into the other made
 * every cell grow by its own padding on each drag, so the table crept wider
 * whichever way the boundary was pulled.
 */
function boxExtra(cell) {
  const cs = frameDoc.defaultView.getComputedStyle(cell);
  if (cs.boxSizing === 'border-box') return 0;
  return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((total, key) => total + (parseFloat(cs[key]) || 0), 0);
}

function widthOf(cell) {
  return cell.getBoundingClientRect().width;
}

/** Write a border-box width, whatever box model the cell is using. */
function setCellWidth(cell, borderBox) {
  cell.style.width = `${Math.round(Math.max(1, borderBox - boxExtra(cell)))}px`;
}

/**
 * Share the row's width out again after a column comes or goes.
 *
 * With table-layout fixed the widths named on the first row are honoured first,
 * and what is left over is split between the cells that named none. Add a
 * column to a table whose widths already account for all of it and the new one
 * is handed nothing — an invisible column, which turns up later when a delete
 * frees some room. Rescaling keeps the proportions and leaves nothing at zero.
 *
 * `extra` is padding and border, measured on the live table: the copy being
 * rewritten is detached, and a detached element has no computed style.
 */
function rescaleColumns(copy, totalWidth, extra) {
  const head = copy.rows[0];
  if (!head) return;
  const cells = [...head.cells];
  const named = cells.map((cell) => {
    const width = parseFloat(cell.style.width);
    return width > 0 ? width + extra : 0;
  });
  if (!named.some((value) => value > 0)) return;

  const average = named.reduce((a, b) => a + b, 0) / named.filter((v) => v > 0).length;
  const wanted = named.map((value) => (value > 0 ? value : average));
  const sum = wanted.reduce((a, b) => a + b, 0);
  const room = Math.max(totalWidth, cells.length * MIN_COLUMN);
  for (const [index, cell] of cells.entries()) {
    const box = Math.max(MIN_COLUMN, wanted[index] * room / sum);
    cell.style.width = `${Math.round(Math.max(1, box - extra))}px`;
  }
}

const DRAG_SLOP = 3;

/**
 * Drag a column boundary.
 *
 * Pointer capture, not window listeners. The note is an iframe, and once the
 * pointer crosses into it the parent window stops hearing about it — the moves
 * go missing and, worse, so does the release. The drag then never ends, and the
 * next time the pointer passes over the app the boundary jumps to wherever it
 * happens to be. Capture keeps every event on the grip until the button is let
 * go, wherever that happens.
 */
function startColumnDrag(event) {
  const table = columnGripTable;
  const index = Number(el.colGrip.dataset.index);
  if (!table || !Number.isInteger(index) || !frameDoc || !frameDoc.body.contains(table)) return;
  const head = table.rows[0];
  const left = head.cells[index];
  const right = head.cells[index + 1];
  if (!left || !right) return;

  columnDrag = {
    table,
    left,
    right,
    startX: event.clientX,
    leftWidth: widthOf(left),
    rightWidth: widthOf(right),
    moved: false,
    // What the table looked like before, so the whole drag can be handed to
    // execCommand as one step and taken back with Ctrl-Z.
    before: { left: left.style.width, right: right.style.width },
  };
  try {
    el.colGrip.setPointerCapture(event.pointerId);
  } catch { /* a synthetic event has no pointer to capture */ }
  el.colGrip.classList.add('dragging');
  event.preventDefault();
}

function moveColumnDrag(event) {
  if (!columnDrag) return;
  const shift = event.clientX - columnDrag.startX;
  // A press that never travels is a click, not a drag; leave the table alone.
  if (!columnDrag.moved && Math.abs(shift) < DRAG_SLOP) return;
  columnDrag.moved = true;

  // The pair keeps its total: pull past the point where one of them hits the
  // floor and it stops there, rather than the other going on growing and the
  // row spilling out past the table's width.
  //
  // Not covered by a test. The offscreen window the renderer tests run in does
  // not carry a drag that far, so a check written for it passes either way —
  // which is worse than no check. Verified by hand instead.
  const span = columnDrag.leftWidth + columnDrag.rightWidth;
  if (span < MIN_COLUMN * 2) return;
  const left = Math.min(span - MIN_COLUMN,
    Math.max(MIN_COLUMN, columnDrag.leftWidth + shift));
  const right = span - left;
  setCellWidth(columnDrag.left, left);
  setCellWidth(columnDrag.right, right);
  el.colGrip.style.left = `${Math.round(columnDrag.left.getBoundingClientRect().right
    + el.frame.getBoundingClientRect().left - 3)}px`;
}

function endColumnDrag(event) {
  if (!columnDrag) return;
  const { table, left, right, before, moved } = columnDrag;
  columnDrag = null;
  el.colGrip.classList.remove('dragging');
  if (event && event.pointerId !== undefined) {
    try {
      el.colGrip.releasePointerCapture(event.pointerId);
    } catch { /* already released */ }
  }
  if (!moved) return;

  const finalLeft = left.style.width;
  const finalRight = right.style.width;
  left.style.width = before.left;
  right.style.width = before.right;

  const cells = [...table.rows[0].cells];
  const copy = table.cloneNode(true);
  copy.rows[0].cells[cells.indexOf(left)].style.width = finalLeft;
  copy.rows[0].cells[cells.indexOf(right)].style.width = finalRight;
  replaceTable(table, copy.outerHTML);
  columnGripTable = null;
  hideColumnGrip();
}

function runHandle(action) {
  if (!handleTarget) return;
  const { cell, edge, side } = handleTarget;
  const resolved = action === 'insertRow' ? (edge === 'top' ? 'rowAbove' : 'rowBelow')
    : action === 'insertCol' ? (side === 'left' ? 'colLeft' : 'colRight')
      : action;
  hideTableHandles();
  editTable(resolved, cell);
}

// The tags a line-move steps out of, as a selector.
const BLOCK_SELECTOR = 'p, div, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6,'
  + ' td, th, pre, section, article, header, footer, center, figure';

const TABLE_ACTIONS = new Set([
  'rowAbove', 'rowBelow', 'rowDelete', 'colLeft', 'colRight', 'colDelete',
]);

const TABLE_GRID_ROWS = 8;
const TABLE_GRID_COLS = 10;

/**
 * Choose a table size by pointing at it.
 *
 * Typing "3x3" into a box works, but every editor people already use lets them
 * sweep a grid and click once, and they are right to expect it.
 */
function buildTableGrid() {
  if (el.tableGridCells.childElementCount) return;
  for (let row = 1; row <= TABLE_GRID_ROWS; row += 1) {
    for (let col = 1; col <= TABLE_GRID_COLS; col += 1) {
      const cell = document.createElement('span');
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      el.tableGridCells.appendChild(cell);
    }
  }

  const paint = (rows, cols) => {
    for (const cell of el.tableGridCells.children) {
      const on = Number(cell.dataset.row) <= rows && Number(cell.dataset.col) <= cols;
      cell.classList.toggle('on', on);
    }
    el.tableGridLabel.textContent = rows && cols
      ? `${rows} × ${cols}` : '칸을 짚어 크기를 고르세요';
  };

  el.tableGridCells.addEventListener('mouseover', (event) => {
    const cell = event.target.closest('span[data-row]');
    if (cell) paint(Number(cell.dataset.row), Number(cell.dataset.col));
  });
  el.tableGridCells.addEventListener('mouseleave', () => paint(0, 0));
  el.tableGridCells.addEventListener('click', (event) => {
    const cell = event.target.closest('span[data-row]');
    if (!cell) return;
    closeTableGrid();
    insertTable(Number(cell.dataset.row), Number(cell.dataset.col));
  });
}

function closeTableGrid() {
  el.tableGrid.classList.add('hidden');
  const button = el.formatBar.querySelector('[data-cmd="table"]');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function toggleTableGrid() {
  if (!el.tableGrid.classList.contains('hidden')) {
    closeTableGrid();
    return;
  }
  buildTableGrid();
  const button = el.formatBar.querySelector('[data-cmd="table"]');
  const anchor = button.getBoundingClientRect();
  el.tableGrid.classList.remove('hidden');
  // Anchor under the button, kept inside the window.
  const width = el.tableGrid.offsetWidth;
  const left = Math.min(anchor.left, window.innerWidth - width - 8);
  el.tableGrid.style.left = `${Math.max(8, left)}px`;
  el.tableGrid.style.top = `${anchor.bottom + 4}px`;
  el.tableGridLabel.textContent = '칸을 짚어 크기를 고르세요';
  for (const cell of el.tableGridCells.children) cell.classList.remove('on');
  button.setAttribute('aria-expanded', 'true');
}

// The shape a hand-made table already uses. Matching it means a new table sits
// alongside the ones already there instead of announcing itself.
//
// table-layout is the one addition. Without it the browser re-divides the
// columns on every keystroke — type into the first cell and the other two
// collapse to nothing — which makes a table unusable to fill in.
const TABLE_ATTRS = 'cellspacing="0" cellpadding="2" width="600" bgcolor="#ffffff"'
  + ' border="1" style="table-layout: fixed"';
const TABLE_MAX = 20;


function tableMarkup(rows, cols) {
  // Each cell carries a <br>: an empty one lays out at zero height and cannot
  // be clicked into, the same trap the note templates fell into.
  const row = `\n  <tr>${'\n    <td><br></td>'.repeat(cols)}\n  </tr>`;
  return `<table ${TABLE_ATTRS}>${row.repeat(rows)}\n</table>`;
}

/**
 * Put a table where the caret is.
 *
 * Until now a table could only arrive by pasting, or by being typed into the
 * source tab. This does the making — changing one afterwards is still the
 * source tab's job.
 */
function insertTable(rows, cols) {
  if (!frameDoc || state.mode !== 'edit') return;
  if (!(rows >= 1 && cols >= 1)) return;

  el.frame.contentWindow.focus();
  const html = tableMarkup(rows, cols);
  const selection = frameDoc.getSelection();
  const range = selection && selection.rangeCount
    ? selection.getRangeAt(0).cloneRange()
    : null;
  const inNote = range && frameDoc.body.contains(range.commonAncestorContainer);

  if (inNote && selection && caretTakesEditCommand(range)) {
    selection.removeAllRanges();
    selection.addRange(range);
    const before = frameDoc.body.querySelectorAll('table').length;
    frameDoc.execCommand('insertHTML', false, html);
    if (frameDoc.body.querySelectorAll('table').length > before) {
      onFrameInput();
      return;
    }
    // Declined — an unfocused window does this. Place it directly instead.
  }

  const holder = frameDoc.createElement('div');
  holder.innerHTML = html;
  const table = holder.firstElementChild;
  if (inNote) {
    range.deleteContents();
    range.insertNode(table);
    range.setStartAfter(table);
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else {
    frameDoc.body.appendChild(table);
  }
  el.frame.contentWindow.focus();
  onFrameInput();
}

function runFormatCommand(command) {
  if (!frameDoc) return;
  el.frame.contentWindow.focus();

  if (command === 'link') {
    const selection = frameDoc.getSelection();
    const anchor = selection && selection.anchorNode && selection.anchorNode.parentElement
      ? selection.anchorNode.parentElement.closest('a[href]')
      : null;
    prompt('링크 URL', anchor ? anchor.getAttribute('href') : 'https://').then((next) => {
      if (next === null) return;
      el.frame.contentWindow.focus();
      frameDoc.execCommand(next ? 'createLink' : 'unlink', false, next || undefined);
      onFrameInput();
    });
    return;
  }

  if (command === 'datetime') {
    insertDateTime();
    return;
  }

  if (command === 'table') {
    toggleTableGrid();
    return;
  }

  const spec = EXEC_COMMANDS[command];
  if (!spec) return;
  frameDoc.execCommand(spec[0], false, spec[1]);
  onFrameInput();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function setSidebarVisible(visible) {
  state.sidebarHidden = !visible;
  el.sidebar.classList.toggle('collapsed', !visible);
  el.btnShowTree.classList.toggle('hidden', visible);
}

function bindEvents() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  document.getElementById('btnFolder').onclick = () => void newFolder();
  document.getElementById('btnNote').onclick = () => void newNote();
  document.getElementById('btnRefresh').onclick = () => void refreshTree();
  document.getElementById('btnHideTree').onclick = () => setSidebarVisible(false);
  document.getElementById('btnShowTree').onclick = () => setSidebarVisible(true);
  document.getElementById('btnReveal').onclick = () =>
    api.showInFolder(state.currentPath || state.selectedFolder || '');

  document.getElementById('btnTheme').onclick = async () => {
    // One control. The note is part of the app's surface, so a separate switch
    // for it only invited the two to disagree.
    const theme = el.body.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(theme);
    state.config = await api.setConfig({ theme });
  };

  // The book button now opens the list rather than a folder picker: with more
  // than one book, "change folder" was the wrong question.
  document.getElementById('btnBookDir').onclick = () => void openSettings();
  document.getElementById('btnSettings').onclick = () => void openSettings();
  document.getElementById('settingsClose').onclick = closeSettings;
  el.settings.addEventListener('click', (event) => {
    if (event.target === el.settings) closeSettings();
  });

  document.getElementById('bookAdd').onclick = () => void editBook(-1);
  document.getElementById('bookEdit').onclick = () => void editBook(books.selected);
  document.getElementById('bookRemove').onclick = () => void removeBook(books.selected);
  document.getElementById('bookUp').onclick = () => void moveBook(-1);
  document.getElementById('formatsReset').onclick = () => void resetFormats();
  document.getElementById('bookDown').onclick = () => void moveBook(1);

  document.getElementById('setStartMode').onchange = async (event) => {
    await api.saveSettings({ editor: { startMode: event.target.value } });
  };

  document.getElementById('setSearchScope').onchange = async (event) => {
    const whole = event.target.value === 'book';
    state.searchWholeBook = whole;
    await api.saveSettings({ ui: { searchWholeBook: whole } });
  };

  const formatInput = document.getElementById('setDateFormat');
  formatInput.oninput = updateDateFormatPreview;
  formatInput.onchange = async (event) => {
    const saved = await api.saveSettings({ editor: { dateFormat: event.target.value } });
    state.dateFormat = saved.editor.dateFormat;
    event.target.value = state.dateFormat;
    updateDateFormatPreview();
  };

  document.getElementById('setStartAs').onchange = async (event) => {
    await api.saveSettings({ window: { startAs: event.target.value } });
  };

  document.getElementById('setTableEditing').addEventListener('change', async (event) => {
    state.tableEditing = event.target.checked;
  state.attachOpen = state.config.attachOpen !== false;
    hideTableHandles();
    await api.saveSettings({ editor: { tableEditing: event.target.checked } });
  });
  document.getElementById('setUpdateCheck').onchange = async (event) => {
    await api.saveSettings({ update: { check: event.target.checked } });
  };
  document.getElementById('setMinimizeToTray').onchange = async (event) => {
    await api.saveSettings({ window: { minimizeToTray: event.target.checked } });
  };

  document.getElementById('setReturnToBrowse').onchange = async (event) => {
    state.returnToBrowse = event.target.checked;
    await api.saveSettings({ editor: { returnToBrowse: event.target.checked } });
  };

  document.getElementById('setAutosave').onchange = async (event) => {
    const seconds = Number(event.target.value);
    if (!Number.isFinite(seconds)) return;
    const saved = await api.saveSettings({
      editor: { autosaveMs: Math.round(seconds * 1000) },
    });
    state.autosaveMs = saved.editor.autosaveMs;
    event.target.value = (saved.editor.autosaveMs / 1000).toFixed(1);
  };

  document.getElementById('btnSearch').onclick = () => {
    el.searchPanel.classList.toggle('hidden');
    if (!el.searchPanel.classList.contains('hidden')) el.searchInput.focus();
  };

  let searchTimer = null;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const query = el.searchInput.value.trim();
      if (!query) {
        el.searchResults.innerHTML = '';
        return;
      }
      const scope = state.searchWholeBook ? '' : (state.selectedFolder || '');
      const hits = await api.searchNotes({ query, scopeRelative: scope });
      el.searchResults.innerHTML = '';
      for (const hit of hits) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'search-hit';
        button.innerHTML =
          `<strong>${escapeHtml(hit.name)}</strong>` +
          `<small>${escapeHtml(hit.snippet || hit.relativePath)}</small>`;
        button.onclick = () => void openNote(hit.relativePath, undefined, { ask: true });
        el.searchResults.appendChild(button);
      }
    }, 250);
  });

  // Fixed position, moving text: put the mark back under its match.
  el.saveStatus.addEventListener('click', () => void forceSave());
  el.saveStatus.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void forceSave();
  });

  el.sourceEditor.addEventListener('scroll', placeSourceMark);
  window.addEventListener('resize', remeasureSourceMark);

  el.sourceEditor.addEventListener('input', () => {
    // Editing moves everything after the caret; the old measurement is a lie.
    hideSourceMark();
    if (state.mode !== 'source' || !state.currentPath) return;
    state.dirty = true;
    // Do not touch state.fullHtml here. It is the last document actually saved,
    // and the save path skips the write when the textarea still matches it —
    // moving it forward on every keystroke meant nothing was ever written.
    scheduleSave();
  });

  document.addEventListener('mousedown', (event) => {
    if (el.tableGrid.classList.contains('hidden')) return;
    if (el.tableGrid.contains(event.target)) return;
    if (event.target.closest('[data-cmd="table"]')) return;
    closeTableGrid();
  });

  // No searching while the word is being typed — see the note on openFind.
  // Nothing that crosses to the main process while a word is being typed. A
  // Korean syllable arrives one jamo at a time, each firing input, and a
  // stopFindInPage in the middle of that ends the composition — the first
  // consonant lands and the rest of the word cannot be typed. Clearing the last
  // search waits until the next one actually runs.
  el.findInput.addEventListener('input', () => {
    findState.at = 0;
    findState.query = '';
    el.findCount.textContent = el.findInput.value ? 'Enter로 찾기' : '';
  });
  el.findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runFind(event.shiftKey ? -1 : 1);
    }
    if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
  });
  document.getElementById('findNext').addEventListener('click', () => runFind(1));
  document.getElementById('findPrev').addEventListener('click', () => runFind(-1));
  document.getElementById('findClose').addEventListener('click', closeFind);
  el.replaceOne.addEventListener('click', replaceCurrent);

  el.attachToggle.addEventListener('click', async () => {
    attachState.open = !attachState.open;
    applyAttachOpen();
    // 접었다 편 상태는 사람의 뜻이므로 남긴다.
    state.attachOpen = attachState.open;
    await api.saveSettings({ editor: { attachOpen: attachState.open } });
  });
  el.attachList.addEventListener('click', (event) => {
    const row = event.target.closest('.attach-item');
    if (row) selectAttachment(row.dataset.name);
  });
  el.attachList.addEventListener('dblclick', (event) => {
    if (event.target.closest('.attach-item')) void openAttachment();
  });
  el.attachList.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); stepAttachment(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepAttachment(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); void insertAttachment('inline'); }
    else if (event.key === 'Delete') { event.preventDefault(); void removeAttachment(); }
  });
  el.attachInsert.addEventListener('click', () => void insertAttachment('inline'));
  el.attachInsertLeft.addEventListener('click', () => void insertAttachment('left'));
  el.attachInsertRight.addEventListener('click', () => void insertAttachment('right'));
  el.attachAdd.addEventListener('click', () => void addAttachments());
  el.attachRemove.addEventListener('click', () => void removeAttachment());
  el.replaceAll.addEventListener('click', replaceEvery);
  el.replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeFind(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) replaceEvery();
    else replaceCurrent();
  });

  el.colGrip.addEventListener('mouseenter', keepTableHandles);
  el.colGrip.addEventListener('mouseleave', scheduleHideTableHandles);
  el.colGrip.addEventListener('pointerdown', startColumnDrag);
  el.colGrip.addEventListener('pointermove', moveColumnDrag);
  el.colGrip.addEventListener('pointerup', endColumnDrag);
  el.colGrip.addEventListener('pointercancel', endColumnDrag);
  el.colGrip.addEventListener('lostpointercapture', endColumnDrag);
  // A synthetic drag, and any release the capture did not catch.
  el.colGrip.addEventListener('mousedown', startColumnDrag);
  window.addEventListener('mousemove', moveColumnDrag);
  window.addEventListener('mouseup', endColumnDrag);

  // mouseenter and mouseleave do not bubble, so each control carries its own.
  for (const [key, action] of [
    ['rowInsert', 'insertRow'], ['colInsert', 'insertCol'],
    ['rowRemove', 'rowDelete'], ['colRemove', 'colDelete'],
  ]) {
    el[key].addEventListener('mouseenter', keepTableHandles);
    el[key].addEventListener('mouseleave', scheduleHideTableHandles);
    el[key].addEventListener('click', () => runHandle(action));
  }
  el.tableHandles.classList.remove('hidden');

  el.formatBar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-cmd]');
    if (!button || !frameDoc || state.mode !== 'edit') return;
    runFormatCommand(button.dataset.cmd);
  });

  let resizing = false;
  el.resizeHandle.addEventListener('mousedown', () => {
    resizing = true;
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (event) => {
    if (!resizing) return;
    const width = Math.min(480, Math.max(180, event.clientX));
    document.documentElement.style.setProperty('--tree-w', `${width}px`);
  });
  window.addEventListener('mouseup', async () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    const width = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--tree-w'),
      10,
    );
    if (Number.isFinite(width)) state.config = await api.setConfig({ TreeWidth: width });
  });

  window.addEventListener('keydown', handleShortcut);
}

/** App shortcuts, wired to both the app window and the note iframe. */
function handleShortcut(event) {
    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;

    if (key === 'Escape') {
      if (!el.findBar.classList.contains('hidden')) {
        closeFind();
        return;
      }
      if (!el.tableGrid.classList.contains('hidden')) {
        closeTableGrid();
        return;
      }
      if (!el.modal.classList.contains('hidden')) return;
      setSidebarVisible(false);
      return;
    }
    if (key === 'Delete' && !event.ctrlKey && document.activeElement === document.body) {
      const target = state.currentPath || state.selectedFolder;
      const node = target && findNode(state.tree?.children || [], target);
      if (node) {
        event.preventDefault();
        deleteItem(node).catch((err) => {
          console.error(err);
          showToast(err?.message || String(err));
        });
        return;
      }
    }
    if (key === 'F2') {
      const node = selectedNode();
      if (node) {
        event.preventDefault();
        renameItem(node);
      }
      return;
    }
    if (mod && event.shiftKey && key === 'Insert') {
      event.preventDefault();
      newFolder();
      return;
    }
    if (mod && key === 'Insert') {
      event.preventDefault();
      newNote();
      return;
    }
    if (mod && event.shiftKey && (key === 'D' || key === 'd')) {
      event.preventDefault();
      el.searchPanel.classList.remove('hidden');
      el.searchInput.focus();
      return;
    }
    if (mod && (key === 'D' || key === 'd') && !event.shiftKey) {
      event.preventDefault();
      api.showInFolder(state.currentPath || state.selectedFolder || '');
      return;
    }
    if (key === 'F5' && state.mode === 'edit') {
      event.preventDefault();
      insertDateTime();
      return;
    }
    if (mod && (key === 'F' || key === 'f') && !event.shiftKey) {
      event.preventDefault();
      openFind();
      return;
    }
    if (mod && (key === 'H' || key === 'h')) {
      event.preventDefault();
      openFind({ replace: true });
      return;
    }
    if (mod && (key === 'S' || key === 's')) {
      event.preventDefault();
      save();
      return;
    }
    // Ctrl-1 … Ctrl-9 apply a saved text format.
    if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
      event.preventDefault();
      applyFormatPreset(Number(key) - 1);
    }
}

function bindLifecycle() {
  // The window stays open until this finishes, so a pending autosave is
  // written rather than cancelled.
  // A version number is all that arrives; the button asks the main process to
  // open the page, which decides for itself where that is.
  api.onUpdateAvailable?.((found) => {
    const version = String(found?.version || '').slice(0, 20);
    if (!version) return;
    showToast(`새 판 ${version} 이 나왔습니다.`, 'notice', {
      label: '받는 곳 열기',
      run: () => api.openReleases(),
    });
  });

  api.onFlushRequest(async () => {
    // A normal save goes out without a word. Only work the file turned away
    // is worth stopping someone for.
    let proceed = true;
    try {
      await flushPending();
      if (heldDocument()) {
        api.flushHold();
        proceed = await confirmDiscard('close');
      }
    } catch (err) {
      console.error(err);
    } finally {
      api.flushComplete(proceed);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

async function init() {
  if (!api) {
    el.emptyState.innerHTML = '<h1>csFreeNote</h1><p>Electron preload가 필요합니다.</p>';
    return;
  }

  state.config = await api.getConfig();
  const theme = state.config.theme || 'dark';
  state.noteSurface = theme === 'dark' ? 'dark' : 'paper';
  if (Number.isFinite(state.config.autosaveMs)) state.autosaveMs = state.config.autosaveMs;
  if (state.config.startMode) state.startMode = state.config.startMode;
  state.returnToBrowse = state.config.returnToBrowse !== false;
  state.tableEditing = state.config.tableEditing === true;
  if (state.config.dateFormat) state.dateFormat = state.config.dateFormat;
  state.searchWholeBook = state.config.searchWholeBook === true;
  applyTheme(theme);
  if (state.config.TreeWidth) {
    document.documentElement.style.setProperty('--tree-w', `${state.config.TreeWidth}px`);
  }

  bindEvents();
  bindLifecycle();
  state.templates = await api.listTemplates().catch(() => []);
  state.formats = (await api.getSettings().catch(() => null))?.formats || [];
  await refreshTree();

  if (state.config.lstPage) {
    try {
      await openNote(state.config.lstPage);
    } catch {
      closeNote();
    }
  }

  setMode(state.startMode === 'edit' ? 'edit' : 'browse');
}

init().catch((err) => {
  console.error(err);
  setStatus('error', '시작 실패');
});
