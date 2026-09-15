'use strict';

/**
 * Drive the real renderer and check that tree drag-and-drop actually moves
 * things.
 *
 * The built page is loaded with a stubbed window.csNote, then synthetic drag
 * events are dispatched at the real tree rows. What this proves is that the
 * listeners are attached to the elements the user actually grabs and that a
 * drop reaches api.moveItem with the right arguments.
 *
 * Usage: npx electron test/verify-tree-dnd.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

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

/** Fire the drag sequence a mouse would produce, on the real rows. */
const DRAG = `(async () => {
  const rowFor = (relative) => {
    const node = document.querySelector('[data-path="' + CSS.escape(relative) + '"]');
    return node && node.querySelector(':scope > .tree-row');
  };
  const dt = new DataTransfer();
  const fire = (el, type, init = {}) => {
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...init });
    el.dispatchEvent(ev);
    return ev;
  };

  const out = {};
  const source = rowFor(SOURCE);
  const target = rowFor(TARGET);
  out.sourceFound = !!source;
  out.targetFound = !!target;
  out.draggable = source ? source.draggable === true : false;
  if (!source || !target) return out;

  fire(source, 'dragstart');
  const over = fire(target, 'dragover', { ctrlKey: CTRL });
  out.dragoverPrevented = over.defaultPrevented;
  out.highlighted = target.classList.contains('drop-target');
  fire(target, 'drop', { ctrlKey: CTRL });
  await new Promise((r) => setTimeout(r, 250));
  out.calls = window.__calls.filter((c) => c.name === 'moveItem');
  const toast = document.getElementById('toast');
  out.toast = toast && !toast.classList.contains('hidden') ? toast.textContent : '';
  out.undo = !!(toast && toast.querySelector('.toast-action'));
  return out;
})()`;

async function scenario(win, label, source, target, ctrl, expect) {
  // Empty in place: reassigning would detach it from the array the stub pushes to.
  await win.webContents.executeJavaScript('window.__calls.length = 0', true);
  const script = DRAG
    .replace('SOURCE', JSON.stringify(source))
    .replace('TARGET', JSON.stringify(target))
    .replace(/CTRL/g, ctrl ? 'true' : 'false');
  const r = await win.webContents.executeJavaScript(script, true);

  console.log(`\n■ ${label}`);
  ok('출발 행을 찾음', r.sourceFound);
  ok('도착 행을 찾음', r.targetFound);
  ok('행이 draggable', r.draggable);
  ok('dragover 가 기본동작을 막음(드롭 허용)', r.dragoverPrevented === expect.allowed,
    String(r.dragoverPrevented));
  ok('드롭 대상이 하이라이트됨', r.highlighted === expect.allowed, String(r.highlighted));

  const call = (r.calls || [])[0];
  if (expect.allowed) {
    ok('무슨 일이 있었는지 알려줌', r.toast && r.toast.includes(source.split('/').pop().replace(/\.html$/, '')),
      r.toast);
    ok(ctrl ? '복사에는 되돌리기 없음' : '이동에는 되돌리기 제공',
      (!!r.undo) === !ctrl, `undo=${r.undo}`);
    ok('moveItem 호출됨', !!call, JSON.stringify(r.calls));
    if (call) {
      ok('올바른 원본', call.payload.relativePath === source, call.payload.relativePath);
      ok('올바른 대상 폴더', call.payload.targetFolder === target, call.payload.targetFolder);
      ok(ctrl ? '복사로 전달' : '이동으로 전달', !!call.payload.copy === ctrl,
        JSON.stringify(call.payload));
    }
  } else {
    ok('moveItem 호출 안 됨', !call, JSON.stringify(r.calls));
  }
}


/** The new-note flow should offer a real list, not a numbered prompt. */
async function templatePicker(win) {
  console.log('\n■ 양식 선택 목록');

  const shown = await win.webContents.executeJavaScript(`(async () => {
    window.__calls.length = 0;
    document.getElementById('btnNote').click();
    await new Promise(r => setTimeout(r, 60));
    const nameStage = {
      visible: !document.getElementById('modal').classList.contains('hidden'),
      hasInput: !document.getElementById('modalInput').classList.contains('hidden'),
    };
    document.getElementById('modalInput').value = '테스트 노트';
    document.getElementById('modalOk').click();
    await new Promise(r => setTimeout(r, 100));
    const list = document.getElementById('modalList');
    return {
      nameStage,
      listShown: !!list && !list.classList.contains('hidden'),
      isPicker: document.getElementById('modal').classList.contains('picker'),
      inputHidden: document.getElementById('modalInput').classList.contains('hidden'),
      items: list ? [...list.querySelectorAll('.modal-list-item')].map(b => b.textContent) : [],
      selected: list ? [...list.querySelectorAll('.modal-list-item')].findIndex(b => b.classList.contains('selected')) : -1,
    };
  })()`, true);

  ok('이름 입력 단계가 뜸', shown.nameStage.visible && shown.nameStage.hasInput,
    JSON.stringify(shown.nameStage));
  ok('양식이 목록으로 표시됨', shown.listShown && shown.isPicker, JSON.stringify(shown));
  ok('목록일 때 입력창은 숨김', shown.inputHidden === true);
  ok('항목이 빈 노트 + 양식 2개', shown.items.length === 3, JSON.stringify(shown.items));
  ok('첫 항목이 선택되어 있음', shown.selected === 0, String(shown.selected));

  const picked = await win.webContents.executeJavaScript(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const sel = [...document.querySelectorAll('.modal-list-item')].findIndex(b => b.classList.contains('selected'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return { sel, calls: window.__calls.filter(c => c.name === 'createNote') };
  })()`, true);

  ok('방향키로 선택이 움직임', picked.sel === 1, String(picked.sel));
  const call = picked.calls[0];
  ok('createNote 호출됨', !!call, JSON.stringify(picked.calls));
  if (call) {
    ok('입력한 이름이 전달됨', call.payload.title === '테스트 노트', call.payload.title);
    ok('고른 양식이 전달됨', call.payload.templateName === '기본 양식',
      JSON.stringify(call.payload.templateName));
  }
}


/**
 * Editing then switching to the source tab must show the edit, not the note
 * as it was when it was opened.
 */
async function sourceTabReflectsEdits(win) {
  console.log('\n■ 편집 → 소스 탭');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // open a note
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(200);

    // edit mode, then type into the note document
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'edit').click();
    await wait(200);
    const d = document.getElementById('noteFrame').contentDocument;
    const before = d.body.innerHTML;
    d.body.insertAdjacentHTML('beforeend', '<p>새로 쓴 문단</p>');
    d.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(120);

    // switch to source — this saves first, then shows the document
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'source').click();
    await wait(600);
    const source = document.getElementById('sourceEditor').value;

    return {
      edited: before !== d.body.innerHTML,
      sourceShowsEdit: source.includes('새로 쓴 문단'),
      sourceIsWholeDocument: source.includes('<html') && source.includes('</body>'),
      keptHead: source.includes('<title>t</title>'),
      savedDoc: window.__doc,
    };
  })()`, true);

  ok('편집 모드에서 내용이 바뀜', r.edited);
  ok('소스 탭이 편집 내용을 보여줌', r.sourceShowsEdit, r.savedDoc);
  ok('소스 탭이 문서 전체를 보여줌', r.sourceIsWholeDocument);
  ok('<head> 가 보존됨', r.keptHead);
  ok('디스크 문서에도 반영됨', String(r.savedDoc).includes('새로 쓴 문단'));
}


/**
 * Editing in the source tab has to reach the file.
 *
 * The save path skips the write when the textarea matches the last saved
 * document. The input handler was assigning that same baseline on every
 * keystroke, so the two were always equal: nothing was ever written, the status
 * said 저장됨, and the edit vanished the next time the note was opened.
 */
async function sourceEditsPersist(win) {
  console.log('\n■ 소스 탭 편집이 파일에 남는다');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    pick('source').click();
    await wait(300);
    const editor = document.getElementById('sourceEditor');
    const started = editor.value;

    // The same thing a person does: change a value inside <head>.
    editor.value = started.includes('font-size: 9pt')
      ? started.replace('font-size: 9pt', 'font-size: 10pt')
      : started.replace('<body', '<body data-probe="1"');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(900);

    // Leave the note and come back — the file is what survives that.
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(300);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    pick('source').click();
    await wait(300);

    return {
      changed: started !== editor.value,
      onDisk: String(window.__doc),
      shown: document.getElementById('sourceEditor').value,
    };
  })()`, true);

  const mark = r.onDisk.includes('font-size: 10pt') || r.onDisk.includes('data-probe');
  ok('편집이 파일에 기록됨', mark, r.onDisk.slice(0, 160));
  ok('돌아와도 편집이 남아 있음',
    r.shown.includes('font-size: 10pt') || r.shown.includes('data-probe'),
    r.shown.slice(0, 160));
}

/**
 * Empty blocks have to be reachable while editing, without the file changing.
 *
 * A block with nothing in it lays out at zero height: nothing to click, and
 * execCommand drops a timestamp into <body> instead of into the block. Filling
 * those with <br> would fix it and rewrite every note that holds one, each
 * growing by the height it gains. The stylesheet does it instead, and saving reads
 * <body>, so it cannot reach the file.
 */
async function emptyBlocksAreReachable(win) {
  console.log('\n■ 빈 칸도 편집할 수 있다');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    const styleId = 'csfreenote-edit-style';
    const frame = document.getElementById('noteFrame');

    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    const d = frame.contentDocument;
    d.body.insertAdjacentHTML('beforeend', '<p id="빈칸"></p>');
    const gap = d.getElementById('빈칸');

    const browsing = { style: !!d.getElementById(styleId), height: gap.getBoundingClientRect().height };

    pick('edit').click();
    await wait(300);
    const editing = { style: !!d.getElementById(styleId), height: gap.getBoundingClientRect().height };

    pick('browse').click();
    await wait(300);
    const back = { style: !!d.getElementById(styleId), height: gap.getBoundingClientRect().height };

    // The rule F5 uses, at the same spot, with the stylesheet on.
    pick('edit').click();
    await wait(250);
    const box = gap.getBoundingClientRect();
    const range = d.caretRangeFromPoint(box.left + 4, box.top + box.height / 2);
    let landed = '없음';
    if (range) {
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      landed = el.id || el.tagName.toLowerCase();
    }

    return { browsing, editing, back, landed, savedDoc: String(window.__doc) };
  })()`, true);

  ok('보기 모드에서는 빈 칸이 접혀 있음',
    !r.browsing.style && r.browsing.height === 0, JSON.stringify(r.browsing));
  ok('편집 모드에서 빈 칸이 자리를 얻음',
    r.editing.style && r.editing.height > 0, JSON.stringify(r.editing));
  ok('편집을 나가면 다시 접힘',
    !r.back.style && r.back.height === 0, JSON.stringify(r.back));
  ok('빈 칸에 커서가 닿음', r.landed === '빈칸', r.landed);
  ok('주입한 스타일이 파일에 닿지 않음',
    !r.savedDoc.includes('csfreenote-edit-style') && !r.savedDoc.includes('min-height'),
    r.savedDoc.slice(0, 120));
}

/**
 * Making a table.
 *
 * A table used to arrive only by pasting, or by being typed into the source
 * tab. The shape has to match what notes already use, every cell has to be
 * reachable, and it has to survive the
 * trip to the file — a table that the loss guard then refuses to save would be
 * worse than no button at all.
 */
async function makeTable(win) {
  console.log('\n■ 표 만들기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    pick('edit').click();
    await wait(300);

    const d = document.getElementById('noteFrame').contentDocument;
    const before = d.body.querySelectorAll('table').length;

    // Put the caret in the note, then press the toolbar button.
    const first = d.body.querySelector('p');
    const range = d.createRange();
    range.setStart(first.firstChild, first.firstChild.length);
    range.collapse(true);
    const sel = d.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    document.querySelector('[data-cmd="table"]').click();
    await wait(200);
    const grid = document.getElementById('tableGrid');
    const opened = !grid.classList.contains('hidden');

    // Sweep to 2 x 3, the way a pointer does, then click it.
    const target = grid.querySelector('span[data-row="2"][data-col="3"]');
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await wait(60);
    const lit = grid.querySelectorAll('span.on').length;
    const label = document.getElementById('tableGridLabel').textContent;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(400);
    const closed = grid.classList.contains('hidden');

    const tables = d.body.querySelectorAll('table');
    const made = tables[tables.length - 1];
    const cells = made ? made.querySelectorAll('td') : [];
    const flat = [...cells].filter((td) => td.getBoundingClientRect().height === 0).length;

    // Filling one cell must not squeeze the others.
    const widthsOf = () => [...made.querySelectorAll('tr:first-child td')]
      .map((td) => Math.round(td.getBoundingClientRect().width));
    const widthsBefore = widthsOf();
    cells[0].textContent = '아주 긴 내용을 이 칸에 계속 적어 넣습니다';
    const widthsAfter = widthsOf();

    await wait(900);   // let the autosave land
    return {
      opened,
      closed,
      lit,
      label,
      grew: tables.length === before + 1,
      rows: made ? made.querySelectorAll('tr').length : 0,
      cols: made ? made.querySelectorAll('tr')[0].querySelectorAll('td').length : 0,
      attrs: made ? made.outerHTML.slice(0, 90) : '',
      flatCells: flat,
      widths: [widthsBefore, widthsAfter],
      widthsHeld: widthsBefore.every((w, i) => Math.abs(w - widthsAfter[i]) <= 2),
      savedDoc: String(window.__doc),
    };
  })()`, true);

  ok('격자가 열림', r.opened);
  ok('짚은 만큼 칸이 켜짐', r.lit === 6, `${r.lit}칸`);
  ok('고른 크기를 보여줌', r.label === '2 × 3', r.label);
  ok('고르면 격자가 닫힘', r.closed);
  ok('표가 하나 생김', r.grew);
  ok('요청한 크기대로', r.rows === 2 && r.cols === 3, `${r.rows}행 ${r.cols}열`);
  ok('옛 노트와 같은 규격',
    r.attrs.includes('cellpadding="2"') && r.attrs.includes('border="1"'), r.attrs);
  ok('글자를 넣어도 칸 폭이 흔들리지 않음', r.widthsHeld, JSON.stringify(r.widths));
  ok('빈 칸도 클릭할 수 있음', r.flatCells === 0, `높이 0인 칸 ${r.flatCells}개`);
  ok('파일에 저장됨', /<table[^>]*border="1"/.test(r.savedDoc), r.savedDoc.slice(-160));
}

/**
 * A note that names its own text colour must still be readable in dark mode.
 *
 * The dark rules used to be injected at the start of <head>, so a note's own
 * `td { color: #222 }` — same specificity, written later — won, and the text
 * stayed dark on a dark background. Every note this app creates had exactly
 * that rule, which made its own new notes the ones that broke.
 *
 * Rules the note went out of its way to name, by class or by attribute, still
 * keep their colour.
 */
async function darkBeatsNoteStylesheet(win) {
  console.log('\n■ 노트 자체 스타일시트보다 밤 모드가 이긴다');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    // Put the document back afterwards; the checks that follow rely on it.
    const original = window.__doc;
    window.__doc = [
      '<html><head><title>t</title>',
      '<style>body, td { color: #222; } .name { color: #4070aa; }</style>',
      '</head><body>',
      '<table><tr><td id="cell">셀 안 글자</td></tr></table>',
      '<p id="plain">문단 글자</p>',
      '<p class="name" id="named">이름 붙은 글자</p>',
      '<p><font color="#ff0000" id="red">붉은 글자</font></p>',
      '</body></html>',
    ].join('');
    window.__mtime += 1;

    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const at = (id) => {
      const el = d.getElementById(id);
      return el ? getComputedStyle(el).color : '없음';
    };
    const style = d.getElementById('csfreenote-view-style');
    const result = {
      주입위치: style ? [...style.parentElement.children].indexOf(style) === style.parentElement.children.length - 1 : null,
      셀: at('cell'),
      문단: at('plain'),
      이름붙은: at('named'),
      붉은: at('red'),
      배경: getComputedStyle(d.body).backgroundColor,
    };

    await wait(1200);
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return result;
  })()`, true);

  const theme = 'rgb(217, 221, 228)';
  ok('밤 모드 규칙이 노트 스타일 뒤에 놓임', r.주입위치 === true, String(r.주입위치));
  ok('배경이 어두움', r.배경 === 'rgb(22, 24, 29)', r.배경);
  ok('셀 안 글자가 밝아짐', r.셀 === theme, r.셀);
  ok('문단 글자가 밝아짐', r.문단 === theme, r.문단);
  ok('class 로 지정한 색은 지켜짐', r.이름붙은 !== theme && r.이름붙은 !== 'rgb(34, 34, 34)', r.이름붙은);
  ok('font color 는 옮겨진 색을 씀', r.붉은 !== theme && r.붉은 !== 'rgb(255, 0, 0)', r.붉은);
}

/**
 * Changing a table by pointing at its edge.
 *
 * A toolbar button had to guess which table was meant, and the caret answered
 * badly: 노트 양식 keeps the whole note inside a layout table, so the buttons
 * were always lit and a stray click took a row out of the note's own frame.
 * The handles appear at the edge under the pointer, so the table, the row and
 * the side are all named by where you point.
 *
 * Each edit still goes in through execCommand, so Ctrl-Z takes it back, and a
 * table with merged cells is refused rather than sheared.
 */
async function tableEdgeHandles(win) {
  console.log('\n■ 표 경계에서 행·열 고치기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    // Row and column editing is off unless asked for; these checks are about
    // what it does once it is on.
    const useTableEditing = async (on) => {
      const box = document.getElementById('setTableEditing');
      if (box.checked === on) return;
      box.checked = on;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
    };
    await useTableEditing(true);

    const frame = document.getElementById('noteFrame');
    const shown = (id) => document.getElementById(id).classList.contains('on');

    const load = async (html) => {
      await wait(1200);           // let any pending autosave land first
      window.__doc = html;
      window.__mtime += 1;
      pick('browse').click();
      await wait(200);
      document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
      await wait(200);
      document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
      await wait(300);
      pick('edit').click();
      await wait(300);
      return frame.contentDocument;
    };

    // Point at a spot inside the note, in window coordinates.
    const pointAt = (doc, node, fx, fy) => {
      const box = node.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const x = box.left + box.width * fx;
      const y = box.top + box.height * fy;
      doc.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: x, clientY: y,
      }));
      return { x: x + f.left, y: y + f.top };
    };

    const original = window.__doc;
    const d = await load('<html><head><title>t</title></head><body><p>앞</p>'
      + '<table border="1" cellpadding="10"><tr><td id="a">가</td><td>나</td></tr>'
      + '<tr><td>다</td><td id="far">라</td></tr></table></body></html>');

    const size = () => {
      const t = d.querySelector('table');
      return t ? [t.rows.length, t.rows[0].cells.length] : [0, 0];
    };

    // Outside any table the handles stay away.
    pointAt(d, d.querySelector('p'), 0.5, 0.5);
    await wait(120);
    const hiddenOutside = !shown('rowInsert') && !shown('rowRemove');

    // Inside a table but away from its margin — still nothing, or the controls
    // would hang over every line of a note written inside a layout table.
    pointAt(d, d.getElementById('far'), 0.5, 0.5);
    await wait(120);
    const hiddenMidCell = !shown('rowInsert') && !shown('colInsert');

    // At the left margin, lower half — a new row belongs below this one.
    const spot = pointAt(d, d.getElementById('a'), 0.05, 0.8);
    await wait(120);
    const shownInside = shown('rowInsert') && shown('rowRemove');

    // The column controls sit on the top edge; measure those too.
    const colSpot = pointAt(d, d.getElementById('a'), 0.8, 0.05);
    await wait(120);
    const colReach = ['colInsert', 'colRemove'].map((id) => {
      const b = document.getElementById(id).getBoundingClientRect();
      return Math.round(Math.hypot(
        b.left + b.width / 2 - colSpot.x, b.top + b.height / 2 - colSpot.y));
    });
    pointAt(d, d.getElementById('a'), 0.05, 0.8);
    await wait(120);

    // Reaching for a control means leaving the note, and the controls live
    // outside it — they have to survive the trip, and be close enough to make.
    const distanceTo = (id) => {
      const b = document.getElementById(id).getBoundingClientRect();
      return Math.round(Math.hypot(
        b.left + b.width / 2 - spot.x, b.top + b.height / 2 - spot.y));
    };
    const reach = { rowInsert: distanceTo('rowInsert'), rowRemove: distanceTo('rowRemove') };
    d.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    document.getElementById('rowInsert')
      .dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await wait(500);
    const survived = shown('rowInsert');
    const start = size();
    document.getElementById('rowInsert').click();
    await wait(300);
    const afterRow = size();

    // Right half of a cell — a new column belongs to its right.
    pointAt(d, d.querySelector('td'), 0.8, 0.05);
    await wait(120);
    document.getElementById('colInsert').click();
    await wait(300);
    const afterCol = size();

    pointAt(d, d.querySelector('td'), 0.05, 0.5);
    await wait(120);
    document.getElementById('rowRemove').click();
    await wait(300);
    const afterRowRemove = size();

    pointAt(d, d.querySelector('td'), 0.5, 0.05);
    await wait(120);
    document.getElementById('colRemove').click();
    await wait(300);
    const afterColRemove = size();

    frame.contentDocument.execCommand('undo');
    await wait(250);
    const afterUndo = size();

    // A merged table is refused, not sheared.
    const d2 = await load('<html><head><title>t</title></head><body>'
      + '<table border="1"><tr><td id="m" colspan="2">넓은 칸</td></tr>'
      + '<tr><td>다</td><td>라</td></tr></table></body></html>');
    const mergedBefore = d2.querySelector('table').outerHTML;
    pointAt(d2, d2.getElementById('m'), 0.02, 0.8);
    await wait(120);
    document.getElementById('rowInsert').click();
    await wait(300);
    const mergedAfter = d2.querySelector('table').outerHTML;

    await load(original);
    pick('browse').click();
    await wait(200);

    await useTableEditing(false);

    return {
      hiddenOutside, hiddenMidCell, shownInside, reach, colReach, survived, start, afterRow, afterCol,
      afterRowRemove, afterColRemove, afterUndo,
      mergedUntouched: mergedBefore === mergedAfter,
    };
  })()`, true);

  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  ok('표 밖을 가리키면 손잡이가 없음', r.hiddenOutside);
  ok('칸 한가운데에서는 안 나옴', r.hiddenMidCell);
  ok('표 가장자리를 가리키면 나옴', r.shownInside);
  const far = [r.reach.rowInsert, r.reach.rowRemove, ...r.colReach].filter((d) => d > 40);
  ok('+ 와 − 넷 다 손 닿는 거리',
    far.length === 0,
    `행 +${r.reach.rowInsert} −${r.reach.rowRemove} / 열 +${r.colReach[0]} −${r.colReach[1]} px`);
  ok('손잡이로 옮겨가는 동안 사라지지 않음', r.survived);
  ok('행이 늘어남', same(r.afterRow, [3, 2]), JSON.stringify(r.afterRow));
  ok('열이 늘어남', same(r.afterCol, [3, 3]), JSON.stringify(r.afterCol));
  ok('행이 줄어듦', same(r.afterRowRemove, [2, 3]), JSON.stringify(r.afterRowRemove));
  ok('열이 줄어듦', same(r.afterColRemove, [2, 2]), JSON.stringify(r.afterColRemove));
  ok('되돌리기로 되살아남', !same(r.afterUndo, r.afterColRemove), JSON.stringify(r.afterUndo));
  ok('병합된 표는 건드리지 않음', r.mergedUntouched);
}

/**
 * Dragging a column boundary.
 *
 * The grip has to keep out of the way of the insert and delete controls: a new
 * column goes in exactly where an existing one ends, so both would otherwise
 * want the same point. The gutter along the top belongs to the controls, and
 * the grip only offers itself below it.
 *
 * It also only offers itself on a table laid out fixed, which is what this app
 * makes. An auto table re-divides its columns from their content, so pinning
 * one down means redrawing a note that already exists.
 */
async function dragColumnWidth(win) {
  console.log('\n■ 열 너비 끌기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    // Row and column editing is off unless asked for; these checks are about
    // what it does once it is on.
    const useTableEditing = async (on) => {
      const box = document.getElementById('setTableEditing');
      if (box.checked === on) return;
      box.checked = on;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
    };
    await useTableEditing(true);

    const frame = document.getElementById('noteFrame');
    const grip = document.getElementById('colGrip');
    const shown = (id) => document.getElementById(id).classList.contains('on');

    const load = async (html) => {
      await wait(1200);
      window.__doc = html;
      window.__mtime += 1;
      pick('browse').click();
      await wait(200);
      document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
      await wait(200);
      document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
      await wait(300);
      pick('edit').click();
      await wait(300);
      return frame.contentDocument;
    };
    const point = (doc, x, y) => doc.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

    const original = window.__doc;
    const fixed = '<table border="1" cellpadding="10" style="table-layout: fixed" width="600">'
      + '<tr><td>가</td><td>나</td><td>다</td></tr>'
      + '<tr><td>라</td><td>마</td><td>바</td></tr></table>';
    const d = await load('<html><head><title>t</title></head><body>' + fixed + '</body></html>');

    const table = d.querySelector('table');
    const f = frame.getBoundingClientRect();
    const box = table.getBoundingClientRect();
    const cellOne = table.rows[0].cells[0].getBoundingClientRect();
    const boundary = cellOne.right;

    // In the gutter the controls own the boundary, so no grip there.
    point(d, boundary, box.top + 6);
    await wait(120);
    const gripInGutter = shown('colGrip');
    const controlsInGutter = shown('colInsert');

    // Below the gutter the grip appears, and the controls stand down.
    point(d, boundary, box.top + 60);
    await wait(120);
    const gripBelow = shown('colGrip');
    const controlsBelow = shown('colInsert');

    const widthsOf = () => [...table.rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));
    const before = widthsOf();

    grip.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: boundary + f.left, clientY: box.top + f.top + 60,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: boundary + f.left + 60, clientY: box.top + f.top + 60,
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await wait(400);
    const after = [...frame.contentDocument.querySelector('table').rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));

    frame.contentDocument.execCommand('undo');
    await wait(250);
    const undone = [...frame.contentDocument.querySelector('table').rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));

    // A press that never travels is a click, not a drag.
    const t3 = frame.contentDocument.querySelector('table');
    const b3 = t3.getBoundingClientRect();
    const e3 = t3.rows[0].cells[0].getBoundingClientRect().right;
    point(frame.contentDocument, e3, b3.top + 60);
    await wait(120);
    const beforeClick = [...t3.rows[0].cells].map((td) => Math.round(td.getBoundingClientRect().width));
    grip.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: e3 + f.left, clientY: b3.top + f.top + 60,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: e3 + f.left + 1, clientY: b3.top + f.top + 60,
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await wait(350);
    const afterClick = [...frame.contentDocument.querySelector('table').rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));

    // Letting go inside the note is a release the window never hears. The drag
    // has to end anyway, or the boundary jumps the next time the pointer moves.
    const t4 = frame.contentDocument.querySelector('table');
    const b4 = t4.getBoundingClientRect();
    const e4 = t4.rows[0].cells[0].getBoundingClientRect().right;
    point(frame.contentDocument, e4, b4.top + 60);
    await wait(120);
    grip.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: e4 + f.left, clientY: b4.top + f.top + 60,
    }));
    frame.contentDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    grip.dispatchEvent(new MouseEvent('lostpointercapture', { bubbles: true }));
    await wait(200);
    const strandedBefore = [...frame.contentDocument.querySelector('table').rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));
    for (let i = 1; i <= 4; i += 1) {
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: e4 + f.left + i * 25, clientY: b4.top + f.top + 60,
      }));
      await wait(60);
    }
    const strandedAfter = [...frame.contentDocument.querySelector('table').rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));

    // An old note's table is laid out automatically; leave it alone.
    const d2 = await load('<html><head><title>t</title></head><body>'
      + '<table border="1" cellpadding="10"><tr><td>가</td><td>나</td></tr>'
      + '<tr><td>다</td><td>라</td></tr></table></body></html>');
    const t2 = d2.querySelector('table');
    const b2 = t2.getBoundingClientRect();
    point(d2, t2.rows[0].cells[0].getBoundingClientRect().right, b2.top + 60);
    await wait(150);
    const gripOnAuto = shown('colGrip');

    await load(original);
    pick('browse').click();
    await wait(200);

    await useTableEditing(false);

    return {
      gripInGutter, controlsInGutter, gripBelow, controlsBelow,
      before, after, undone, gripOnAuto,
      beforeClick, afterClick, strandedBefore, strandedAfter,
    };
  })()`, true);

  ok('여백에서는 그립이 안 나옴', !r.gripInGutter);
  ok('여백은 넣기·빼기 차지', r.controlsInGutter);
  ok('여백 아래에서 그립이 나옴', r.gripBelow);
  ok('그때 넣기·빼기는 물러남', !r.controlsBelow);
  ok('끌면 왼쪽 열이 넓어짐', r.after[0] > r.before[0] + 30,
    `${r.before[0]} → ${r.after[0]}`);
  ok('오른쪽 열이 그만큼 좁아짐', r.after[1] < r.before[1] - 30,
    `${r.before[1]} → ${r.after[1]}`);
  ok('표 전체 너비는 그대로',
    Math.abs(r.after.reduce((a, b) => a + b, 0) - r.before.reduce((a, b) => a + b, 0)) <= 4,
    `${r.before} → ${r.after}`);
  ok('되돌리기로 돌아옴', Math.abs(r.undone[0] - r.before[0]) <= 4,
    `${r.after[0]} → ${r.undone[0]}`);
  ok('눌렀다 떼기만 하면 그대로',
    JSON.stringify(r.beforeClick) === JSON.stringify(r.afterClick),
    `${r.beforeClick} → ${r.afterClick}`);
  ok('노트 안에서 손을 떼도 끌기가 끝남',
    JSON.stringify(r.strandedBefore) === JSON.stringify(r.strandedAfter),
    `${r.strandedBefore} → ${r.strandedAfter}`);
  ok('자동 배치 표에는 그립이 안 나옴', !r.gripOnAuto);
}

/**
 * The table's own width has to survive being worked on.
 *
 * Two ways it did not. A cell's measured width is its border box, but
 * style.width sets the content box, so every drag added the padding back and
 * the table crept wider whichever way the boundary went. And with table-layout
 * fixed the widths named on the first row are honoured first — once they
 * accounted for the whole table, a new column was handed nothing and simply did
 * not appear, until a later delete freed some room and it turned up.
 */
async function tableKeepsItsWidth(win) {
  console.log('\n■ 표 너비가 제멋대로 자라지 않는다');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    // Row and column editing is off unless asked for; these checks are about
    // what it does once it is on.
    const useTableEditing = async (on) => {
      const box = document.getElementById('setTableEditing');
      if (box.checked === on) return;
      box.checked = on;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
    };
    await useTableEditing(true);

    const frame = document.getElementById('noteFrame');
    const grip = document.getElementById('colGrip');

    await wait(1200);
    const original = window.__doc;
    window.__doc = '<html><head><title>t</title></head><body>'
      + '<table border="1" cellpadding="10" style="table-layout: fixed" width="600">'
      + '<tr><td>가</td><td>나</td><td>다</td></tr>'
      + '<tr><td>라</td><td>마</td><td>바</td></tr></table></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    pick('edit').click();
    await wait(300);

    const table = () => frame.contentDocument.querySelector('table');
    const tableWidth = () => Math.round(table().getBoundingClientRect().width);
    const widths = () => [...table().rows[0].cells]
      .map((td) => Math.round(td.getBoundingClientRect().width));

    const startWidth = tableWidth();

    // Pull the same boundary back and forth several times.
    const drag = async (by) => {
      const t = table();
      const f = frame.getBoundingClientRect();
      const b = t.getBoundingClientRect();
      const edge = t.rows[0].cells[0].getBoundingClientRect().right;
      frame.contentDocument.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: edge, clientY: b.top + 60,
      }));
      await wait(120);
      grip.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, clientX: edge + f.left, clientY: b.top + f.top + 60,
      }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: edge + f.left + by, clientY: b.top + f.top + 60,
      }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await wait(350);
    };
    for (const by of [40, -30, 25, -35]) await drag(by);
    const afterDrags = tableWidth();


    // Now add a column while the widths already account for the whole table.
    const pointInside = async () => {
      const t = table();
      const b = t.getBoundingClientRect();
      frame.contentDocument.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: t.rows[0].cells[0].getBoundingClientRect().left + 6,
        clientY: b.top + 6,
      }));
      await wait(120);
    };
    await pointInside();
    document.getElementById('colInsert').click();
    await wait(350);
    const afterInsert = widths();
    const insertWidth = tableWidth();

    await pointInside();
    document.getElementById('colRemove').click();
    await wait(350);
    const afterRemove = widths();
    const removeWidth = tableWidth();

    // Interleave the two, the way a person exploring them does.
    const trail = [];
    for (const step of ['colInsert', 'colRemove', 'colInsert', 'colInsert',
      'colRemove', 'colRemove', 'colInsert']) {
      await pointInside();
      document.getElementById(step).click();
      await wait(320);
      trail.push({ step, cols: widths(), table: tableWidth() });
    }

    // Put the document back; the checks that follow rely on it.
    await wait(1200);
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    await useTableEditing(false);

    return {
      startWidth, afterDrags, afterInsert, insertWidth, afterRemove, removeWidth, trail,
    };
  })()`, true);

  ok('여러 번 끌어도 표가 넓어지지 않음',
    Math.abs(r.afterDrags - r.startWidth) <= 6, `${r.startWidth} → ${r.afterDrags}`);
  ok('열을 넣어도 표 너비는 그대로',
    Math.abs(r.insertWidth - r.startWidth) <= 8, `${r.startWidth} → ${r.insertWidth}`);
  ok('새 열이 보이는 너비를 받음',
    r.afterInsert.every((w) => w >= 20), JSON.stringify(r.afterInsert));
  ok('열을 빼도 표 너비는 그대로',
    Math.abs(r.removeWidth - r.startWidth) <= 8, `${r.startWidth} → ${r.removeWidth}`);
  ok('남은 열이 모두 보임',
    r.afterRemove.every((w) => w >= 20), JSON.stringify(r.afterRemove));

  const hidden = r.trail.filter((s) => s.cols.some((w) => w < 20));
  ok('넣기와 빼기를 섞어도 숨는 열이 없음', hidden.length === 0,
    hidden.map((s) => `${s.step} ${JSON.stringify(s.cols)}`).join(' / '));
  const grew = r.trail.filter((s) => Math.abs(s.table - r.startWidth) > 10);
  ok('섞어 써도 표 너비가 유지됨', grew.length === 0,
    grew.map((s) => `${s.step} ${s.table}`).join(' / '));
  const counts = r.trail.map((s) => s.cols.length);
  ok('열 수가 누른 대로 따라옴', JSON.stringify(counts) === JSON.stringify([4, 3, 4, 5, 4, 3, 4]),
    JSON.stringify(counts));
}

/**
 * Up and down inside a table follow the column.
 *
 * Chromium moves the caret by line, and a cell holding a single line has no
 * next line — so Down out of the middle of a table lands in the cell to the
 * right, then wraps to the start of the row below. It walks the document, not
 * the grid.
 */
async function arrowsFollowTheColumn(win) {
  console.log('\n■ 표에서 위아래 이동');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    await wait(1200);
    const original = window.__doc;
    window.__doc = '<html><head><title>t</title><style>p{margin:0}</style></head><body>'
      + '<table border="1" cellpadding="6">'
      + '<tr><td id="r1c1">A1</td><td id="r1c2">B1</td></tr>'
      + '<tr><td id="r2c1">A2</td><td id="r2c2">B2</td></tr>'
      + '</table><p id="tail">뒤 문단</p></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    pick('edit').click();
    await wait(300);

    const d = document.getElementById('noteFrame').contentDocument;
    const at = () => {
      const s = d.getSelection();
      if (!s.rangeCount) return '없음';
      const n = s.getRangeAt(0).startContainer;
      const el = n.nodeType === 1 ? n : n.parentElement;
      const box = el.closest ? (el.closest('td') || el.closest('p')) : null;
      return box ? (box.id || box.tagName) : (el.tagName || '?');
    };
    const put = (id) => {
      const cell = d.getElementById(id);
      const range = d.createRange();
      range.setStart(cell.firstChild, 1);
      range.collapse(true);
      const s = d.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    };
    const arrow = (key) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      d.dispatchEvent(event);
      return { moved: event.defaultPrevented, where: at() };
    };

    put('r1c1');
    const down1 = arrow('ArrowDown');
    const down2 = arrow('ArrowDown');
    put('r2c2');
    const up1 = arrow('ArrowUp');

    // From outside the table, going back in has to land in the same column —
    // not in whichever cell the document happens to end with.
    const tail = d.getElementById('tail');
    const middle = d.getElementById('r1c2').getBoundingClientRect();
    const x = middle.left + middle.width / 2;
    const y = tail.getBoundingClientRect().top + 4;
    const hit = d.caretRangeFromPoint(x, y);
    if (hit) {
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(hit);
    }
    // 이 검사가 어긋났을 때 무엇을 보고 판단했는지 남긴다. "가로채지 않았다"
    // 만으로는 칸을 잘못 짚은 것인지, 캐럿이 엉뚱한 데 있었는지 알 수 없다.
    const before = at();
    const back = arrow('ArrowUp');
    back.why = {
      캐럿찍기: hit ? '됨' : '안됨',
      누르기전: before,
      r1c2: [Math.round(middle.left), Math.round(middle.width)],
      찍은자리: [Math.round(x), Math.round(y)],
      화면: [d.documentElement.clientWidth, d.documentElement.clientHeight],
    };

    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    return { down1, down2, up1, back };
  })()`, true);

  ok('아래로 가면 같은 열의 아래 칸', r.down1.moved && r.down1.where === 'r2c1',
    `${r.down1.where} (가로챔 ${r.down1.moved})`);
  ok('마지막 행에서는 표 밖으로', r.down2.moved && r.down2.where === 'tail',
    `${r.down2.where} (가로챔 ${r.down2.moved})`);
  ok('위로 가면 같은 열의 위 칸', r.up1.moved && r.up1.where === 'r1c2',
    `${r.up1.where} (가로챔 ${r.up1.moved})`);
  ok('표 밖에서 들어올 때도 같은 열', r.back.moved && r.back.where === 'r2c2',
    `${r.back.where} (가로챔 ${r.back.moved}) ${JSON.stringify(r.back.why)}`);
}

/**
 * Row and column editing is something to switch on.
 *
 * 노트 양식 keeps the whole note inside a layout table, so its cells are where
 * the writing happens — and a delete marker hovering over ordinary text is a
 * mistake waiting to be made. Off by default, and off still leaves the two
 * halves that cannot lose anything: making a table, and setting column widths.
 */
async function tableEditingIsOptional(win) {
  console.log('\n■ 표 편집 모드는 선택');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    const frame = document.getElementById('noteFrame');
    const shown = (id) => document.getElementById(id).classList.contains('on');

    await wait(1200);
    const original = window.__doc;
    window.__doc = '<html><head><title>t</title></head><body>'
      + '<table border="1" cellpadding="10" style="table-layout: fixed" width="600">'
      + '<tr><td id="a">가</td><td>나</td><td>다</td></tr>'
      + '<tr><td>라</td><td>마</td><td>바</td></tr></table></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    pick('edit').click();
    await wait(300);

    const d = frame.contentDocument;
    const table = d.querySelector('table');
    const box = table.getBoundingClientRect();
    const edge = table.rows[0].cells[0].getBoundingClientRect().right;
    const atMargin = () => {
      d.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: box.left + 6, clientY: box.top + 6,
      }));
    };
    const atBoundary = () => {
      d.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: edge, clientY: box.top + 60,
      }));
    };

    const box2 = document.getElementById('setTableEditing');
    const startsOff = !box2.checked;

    atMargin(); await wait(150);
    const handlesWhenOff = shown('rowInsert') || shown('rowRemove')
      || shown('colInsert') || shown('colRemove');
    atBoundary(); await wait(150);
    const gripWhenOff = shown('colGrip');
    const makerWhenOff = !!document.querySelector('[data-cmd="table"]');

    box2.checked = true;
    box2.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
    atMargin(); await wait(150);
    const handlesWhenOn = shown('rowInsert') && shown('rowRemove');

    box2.checked = false;
    box2.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
    atMargin(); await wait(150);
    const handlesOffAgain = shown('rowInsert') || shown('rowRemove');

    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    return { startsOff, handlesWhenOff, gripWhenOff, makerWhenOff, handlesWhenOn, handlesOffAgain };
  })()`, true);

  ok('기본은 꺼짐', r.startsOff);
  ok('꺼두면 행·열 단추가 안 나옴', !r.handlesWhenOff);
  ok('꺼도 열 너비는 조정됨', r.gripWhenOff);
  ok('꺼도 표 만들기는 남음', r.makerWhenOff);
  ok('켜면 행·열 단추가 나옴', r.handlesWhenOn);
  ok('다시 끄면 사라짐', !r.handlesOffAgain);
}

/**
 * Find inside the note — Ctrl-F.
 *
 * Three things went wrong here and each was invisible from the outside. The
 * count climbed while the page sat still, because a textarea only scrolls to
 * its selection while it holds the focus, and the focus has to go back to the
 * find box. The focus not going back deleted a character of a note: a backspace
 * meant for the search word landed in the source. And Chromium answers a fresh
 * search — findNext false — with no event at all, so every new word waited for
 * a timeout before saying "없음".
 */
async function undoAfterTypingAndCopying(win) {
  console.log('\n■ 입력과 복사·붙여넣기를 섞은 뒤 되돌리기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    window.__doc = '<html><head><title>t</title>'
      + '<style>body, td { font-size: 9pt; color: rgb(0, 0, 0); }</style></head><body>'
      + '<p id="가">가나다라마바사</p><p id="나">아자차카타파하</p>'
      + '<p id="다">ABCDEFG</p></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const shape = () => d.body.textContent.replace(/\s+/g, ' ').trim();
    const caretIn = (id, at) => {
      const node = d.getElementById(id).firstChild;
      const range = d.createRange();
      range.setStart(node, at);
      range.collapse(true);
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const type = async (text) => { d.execCommand('insertText', false, text); await wait(150); };
    // Copy a stretch of the note itself. Chromium does not hand the clipboard
    // the bare markup — it writes the source's computed appearance inline, so
    // the copy looks the same wherever it lands. That wrapper is what the paste
    // path has to deal with, and leaving it out was why this passed before.
    const copyFrom = (id, from, to) => {
      const node = d.getElementById(id).firstChild;
      const range = d.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const box = d.createElement('div');
      box.appendChild(range.cloneContents());
      return '<meta charset="utf-8"><span style="font-size: 9pt; '
        + 'font-family: &quot;Malgun Gothic&quot;, sans-serif; color: rgb(0, 0, 0); '
        + 'font-weight: 400; font-style: normal;">' + box.innerHTML + '</span>';
    };
    const pasteAt = async (id, at, html) => {
      caretIn(id, at);
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', html.replace(/<[^>]*>/g, ''));
      d.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true }));
      await wait(250);
    };

    const marks = [];
    marks.push(shape());
    caretIn('가', 7); await type('첫 입력');    marks.push(shape());
    caretIn('나', 7); await type('둘째 입력');  marks.push(shape());
    await pasteAt('다', 3, copyFrom('가', 0, 3));  marks.push(shape());
    await pasteAt('나', 2, copyFrom('다', 0, 3));  marks.push(shape());

    const back = [];
    for (let i = 0; i < 4; i += 1) {
      d.execCommand('undo');
      await wait(200);
      back.push(shape());
    }

    await wait(1400);
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { marks, back, restored: window.__doc === original };
  })()`, true);

  ok('뒤의 검사를 위해 노트를 되돌려 놓음', r.restored);
  // Each undo should land on the step before it, in order.
  const want = [r.marks[3], r.marks[2], r.marks[1], r.marks[0]];
  for (let i = 0; i < 4; i += 1) {
    ok(`되돌리기 ${i + 1}번째가 한 걸음 앞으로`, r.back[i] === want[i],
      `${r.back[i]}\n        기대: ${want[i]}`);
  }
}

async function undoWalksBackThroughPastes(win) {
  console.log('\n■ 여러 번 붙여넣은 뒤 되돌리기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    window.__doc = '<html><head><title>t</title>'
      + '<style>body { color: rgb(0, 0, 0); }</style></head><body>'
      + '<p id="여기">시작</p></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const shape = () => d.body.textContent.replace(/\s+/g, ' ').trim();
    const caretEnd = () => {
      const range = d.createRange();
      range.selectNodeContents(d.body);
      range.collapse(false);
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const paste = async (html, text) => {
      caretEnd();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', text);
      d.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true }));
      await wait(250);
    };

    const start = shape();
    // A span that says only what it would inherit — the kind the editor trims.
    await paste('<p><span style="color: rgb(0, 0, 0)">첫째 조각</span></p>', '첫째 조각');
    const one = shape();
    await paste('<p><span style="color: rgb(0, 0, 0)">둘째 조각</span></p>', '둘째 조각');
    const two = shape();

    d.execCommand('undo');
    await wait(200);
    const back1 = shape();
    d.execCommand('undo');
    await wait(200);
    const back2 = shape();

    await wait(1400);
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { start, one, two, back1, back2, restored: window.__doc === original };
  })()`, true);

  ok('뒤의 검사를 위해 노트를 되돌려 놓음', r.restored);
  ok('두 번 붙여넣으면 둘 다 들어감',
    /첫째 조각/.test(r.two) && /둘째 조각/.test(r.two), r.two);
  ok('되돌리기 한 번이면 두 번째 붙여넣기 직전으로', r.back1 === r.one,
    `${r.back1}   (기대: ${r.one})`);
  ok('되돌리기 두 번이면 처음으로', r.back2 === r.start,
    `${r.back2}   (기대: ${r.start})`);
}

async function pasteKeepsMeaningNotLooks(win) {
  console.log('\n■ 붙여넣기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    window.__doc = '<html><head><title>t</title></head><body><p id="여기">시작</p></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const caretTo = (id) => {
      const range = d.createRange();
      range.selectNodeContents(d.getElementById(id));
      range.collapse(false);
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const paste = async (html, text) => {
      const dt = new DataTransfer();
      if (html) dt.setData('text/html', html);
      dt.setData('text/plain', text);
      d.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true }));
      await wait(200);
    };

    // What a page or a Word document brings with it.
    const dirty = '<div class="WordSection1" style="mso-padding: 3pt">'
      + '<p style="font-family: Verdana; font-size: 14pt; margin: 12pt">'
      + '<span style="font-family: 굴림; font-size: 20pt; color: rgb(0, 0, 255)">파란 글씨</span>'
      + ' 그리고 <b>굵게</b> <font face="Arial" size="5" color="#ff0000">붉은</font></p>'
      + '<table width="900" bgcolor="#eeeeee"><tr><td style="font-size: 18pt">칸</td></tr></table>'
      + '<p><a href="https://example.com" class="x">링크</a>'
      + ' <a href="javascript:alert(1)">나쁜 링크</a></p>'
      + '<o:p></o:p><script>window.x=1<\/script></div>';

    caretTo('여기');
    await paste(dirty, '파란 글씨 그리고 굵게 붉은 칸 링크 나쁜 링크');
    const body = d.body;
    const after = {
      words: body.textContent.replace(/\s+/g, ' ').trim(),
      fontFamily: /font-family/.test(body.innerHTML),
      fontSize: /font-size/.test(body.innerHTML),
      klass: /class=/.test(body.innerHTML),
      mso: /mso-|<o:p|<script/i.test(body.innerHTML),
      // Plain text search: a regex written here would have its backslashes
      // eaten by the template literal, and 'rgb(0, 0, 255)' would quietly
      // become a group that matches nothing.
      colour: body.innerHTML.includes('color: rgb(0, 0, 255)') || body.innerHTML.includes('color: blue'),
      red: body.innerHTML.includes('color: rgb(255, 0, 0)') || body.innerHTML.toLowerCase().includes('#ff0000'),
      bold: !!body.querySelector('b, strong'),
      table: !!body.querySelector('table td'),
      link: !!body.querySelector('a[href^="https://example.com"]'),
      bad: /javascript:/i.test(body.innerHTML),
      tableWidth: /width="900"|bgcolor/i.test(body.innerHTML),
    };

    // Ctrl+Shift+V: the words alone.
    d.getElementById('여기') || body.insertAdjacentHTML('beforeend', '<p id="여기2">둘째</p>');
    body.insertAdjacentHTML('beforeend', '<p id="맨끝">끝</p>');
    caretTo('맨끝');
    d.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await paste('<p style="color: red"><b>서식 있는</b> 글</p>', '서식 있는 글');
    const tail = d.getElementById('맨끝');
    const plain = { html: tail.innerHTML, words: tail.textContent };

    // The pastes scheduled a save; let it land before putting the note back,
    // or it writes this test's document over the restored one.
    await wait(1400);
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { after, plain, restored: window.__doc === original };
  })()`, true);

  ok('뒤의 검사를 위해 노트를 되돌려 놓음', r.restored);
  ok('글자가 모두 들어옴', /파란 글씨 그리고 굵게 붉은/.test(r.after.words), r.after.words);
  ok('글꼴은 따라오지 않음', !r.after.fontFamily);
  ok('글자 크기도 따라오지 않음', !r.after.fontSize);
  ok('class 와 Word 잔재는 버려짐', !r.after.klass && !r.after.mso);
  ok('색은 남음 (파랑·빨강)', r.after.colour && r.after.red);
  ok('굵게는 남음', r.after.bold);
  ok('표와 링크는 남음', r.after.table && r.after.link);
  ok('표의 겉모습 속성은 버려짐', !r.after.tableWidth);
  ok('javascript: 링크는 걷어냄', !r.after.bad);
  ok('Ctrl+Shift+V 는 글자만', !/<b|color/.test(r.plain.html) && /서식 있는 글/.test(r.plain.words),
    r.plain.html);
}

async function blankLinesAreNotTheCellTop(win) {
  console.log('\n■ 빈 줄에서 위로');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    // A table of the author's own — two cells to a row, so the frame rule does
    // not apply — with a blank line in the middle of the lower cell.
    window.__doc = '<html><head><title>t</title>'
      + '<style>body, td { font-size: 9pt; line-height: 1.2; } p { margin: 0; }</style></head><body>'
      + '<table border="1" cellpadding="4">'
      + '<tr><td id="위칸">위</td><td>ㅁ</td></tr>'
      + '<tr><td id="가운데칸"><p>첫 줄</p><p id="빈줄"><br></p><p id="끝빈줄"><br></p></td><td>ㄴ</td></tr>'
      + '<tr><td id="아래칸">아래</td><td>ㄷ</td></tr>'
      + '</table></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const range = d.createRange();
    range.selectNodeContents(d.getElementById('빈줄'));
    range.collapse(true);
    const sel = d.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const cellNow = () => {
      const n = d.getSelection().anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      const cell = el && el.closest('td');
      return cell ? cell.id : '(칸 밖)';
    };
    const from = cellNow();
    d.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await wait(150);
    const landed = cellNow();

    // And the other way: a blank line at the foot of a cell is the cell's
    // bottom edge, so Down belongs to the column, not to the browser's walk
    // along the document — which goes sideways into the next cell.
    const tail = d.createRange();
    tail.selectNodeContents(d.getElementById('끝빈줄'));
    tail.collapse(true);
    sel.removeAllRanges();
    sel.addRange(tail);
    const fromFoot = cellNow();
    d.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await wait(150);
    const below = cellNow();

    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { from, landed, fromFoot, below, restored: window.__doc === original };
  })()`, true);

  ok('뒤의 검사를 위해 노트를 되돌려 놓음', r.restored);
  // The blank line is not the top of its cell. Measured against the cell it
  // looked like it was, and Up left the cell from the middle of it.
  ok('칸 가운데 빈 줄에서 위로 눌러도 칸을 벗어나지 않음',
    r.from === '가운데칸' && r.landed === '가운데칸', `${r.from} → ${r.landed}`);
  ok('칸 끝 빈 줄에서 아래로 누르면 같은 열의 아래 칸으로',
    r.fromFoot === '가운데칸' && r.below === '아래칸', `${r.fromFoot} → ${r.below}`);
}

async function theTitleIsTheRowAbove(win) {
  console.log('\n■ 본문 첫 줄에서 위로');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    // The note template's shape: a frame table straight in the body, its first
    // row the coloured title, and a content table inside the cell.
    window.__doc = '<html><head><title>t</title>'
      + '<style>body, td { font-size: 9pt; line-height: 1.2; } p { margin: 0; }</style></head><body>'
      + '<table cellpadding="4" bgcolor="#3c62c6"><tr><td id="제목"><div>▶ 제목</div></td></tr>'
      + '<tr bgcolor="#ffffff"><td id="본문">'
      + '<p id="첫줄">첫째 줄</p><p>둘째 줄</p>'
      + '<table border="1"><tr><td id="속표1">가</td></tr><tr><td id="속표2">나</td></tr></table>'
      + '</td></tr></table></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const put = (id) => {
      const el = d.getElementById(id);
      const range = d.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const cellNow = () => {
      const n = d.getSelection().anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      const cell = el && el.closest('td');
      return cell ? cell.id : '(칸 밖)';
    };
    const up = async () => {
      d.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await wait(120);
    };

    // From the note's first line, Up must not reach the title row.
    put('첫줄');
    const from = cellNow();
    await up();
    const stayed = cellNow();

    // But a table inside the note still walks its own rows.
    put('속표2');
    const inner = cellNow();
    await up();
    const walked = cellNow();

    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { from, stayed, inner, walked, restored: window.__doc === original };
  })()`, true);

  ok('뒤의 검사를 위해 노트를 되돌려 놓음', r.restored);
  // The title row is the row above, and reaching it from the note's first line
  // is the column move working. What used to happen — and what a blocking rule
  // was briefly written for — was landing there from a blank line in the middle
  // of the note, which was a mismeasured caret, fixed above.
  ok('본문 첫 줄에서 위로 누르면 제목줄로',
    r.from === '본문' && r.stayed === '제목', `${r.from} → ${r.stayed}`);
  ok('노트 안쪽 표에서는 위로 이동이 그대로',
    r.inner === '속표2' && r.walked === '속표1', `${r.inner} → ${r.walked}`);
}

async function f2RenamesWhateverIsSelected(win) {
  console.log('\n■ F2 는 고른 것의 이름을 바꾼다');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const press = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'F2', bubbles: true, cancelable: true }));
      await wait(250);
    };
    // Renaming asks through the shared modal: a title and a filled-in box.
    const asking = () => {
      const modal = document.getElementById('modal');
      if (!modal || modal.classList.contains('hidden')) return null;
      return {
        title: document.getElementById('modalTitle').textContent,
        value: document.getElementById('modalInput').value,
      };
    };
    const escape = async () => {
      const cancel = document.getElementById('modalCancel');
      if (cancel) cancel.click();
      await wait(200);
    };

    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    await press();
    const onNote = asking();
    await escape();

    document.querySelector('[data-path="폴더A"] > .tree-row').click();
    await wait(500);
    await press();
    const onFolder = asking();
    await escape();

    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { onNote, onFolder };
  })()`, true);

  ok('노트에서 F2 로 이름 바꾸기가 열림', r.onNote !== null, JSON.stringify(r.onNote));
  ok('노트 이름이 채워져 있음', r.onNote && r.onNote.value === '루트노트',
    JSON.stringify(r.onNote));
  ok('폴더에서도 F2 로 이름 바꾸기가 열림', r.onFolder !== null, JSON.stringify(r.onFolder));
  ok('폴더 이름이 채워져 있음', r.onFolder && r.onFolder.value === '폴더A',
    JSON.stringify(r.onFolder));
}

async function idleSpansLeaveTheFileNotTheEditor(win) {
  console.log('\n■ 하는 일 없는 서식 span 은 파일에만 안 남는다');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    window.__doc = '<html><head><title>t</title>'
      + '<style>body, td { font-size: 9pt; }</style></head><body><table><tbody><tr><td>'
      + '<p id="말하나마나">앞 줄</p><p id="진짜">앞 줄</p>'
      + '</td></tr></tbody></table></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const idle = d.getElementById('말하나마나');
    const real = d.getElementById('진짜');
    // One that only repeats the inherited size, one that really changes it.
    idle.innerHTML = '<span style="font-size: 9pt;">타이핑한 줄</span>';
    real.innerHTML = '<span style="font-size: 20pt;">타이핑한 줄</span>';

    const text = idle.querySelector('span').firstChild;
    const range = d.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const sel = d.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const before = window.__calls.filter((c) => c.name === 'writeNote').length;
    d.dispatchEvent(new Event('input', { bubbles: true }));
    // The save is on a 700ms delay; it is the file that gets trimmed.
    await wait(1400);
    const writes = window.__calls.filter((c) => c.name === 'writeNote');
    const saved = writes.length > before ? String(writes[writes.length - 1].payload.body) : '';

    const out = {
      wrote: writes.length > before,
      savedIdle: /9pt/.test(saved),
      savedReal: /20pt/.test(saved),
      savedWords: /타이핑한 줄/.test(saved),
      // The editor's own document keeps what the browser put there — touching
      // it behind the browser's back is what broke undo.
      liveIdle: /9pt/.test(idle.innerHTML),
      caretNode: d.getSelection().anchorNode === text,
      caretAt: d.getSelection().anchorOffset,
    };

    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    out.restored = window.__doc === original;
    return out;
  })()`, true);

  ok('뒤의 검사를 위해 노트를 되돌려 놓음', r.restored);
  ok('저장이 일어남', r.wrote);
  ok('파일에는 말하나마나 한 span 이 없음', !r.savedIdle);
  ok('파일에도 진짜 서식은 남음', r.savedReal);
  ok('파일에 글자는 그대로', r.savedWords);
  ok('편집 중 문서는 건드리지 않음', r.liveIdle);
  ok('커서도 그대로', r.caretNode && r.caretAt === 3, `node=${r.caretNode} offset=${r.caretAt}`);
}

async function findInNote(win) {
  console.log('\n■ 이 노트에서 찾기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    await wait(1200);
    const original = window.__doc;
    const line = (n) => '<p>라벨 ' + n + ' 줄입니다. 길게 적어 두어 줄이 넘어가게 합니다.</p>';
    window.__doc = '<html><head><title>t</title></head><body>'
      + Array.from({ length: 40 }, (_, i) => line(i + 1)).join('')
      + '<p>다른 낱말</p></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('source').click();
    await wait(400);

    const bar = document.getElementById('findBar');
    const input = document.getElementById('findInput');
    const editor = document.getElementById('sourceEditor');
    const count = () => document.getElementById('findCount').textContent;
    const press = async (key, shift) => {
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key, shiftKey: !!shift, bubbles: true, cancelable: true }));
      await wait(250);
    };

    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    const opened = !bar.classList.contains('hidden');

    input.value = '라벨';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    const beforeEnter = count();

    const walk = [];
    for (let i = 0; i < 3; i += 1) {
      await press('Enter');
      walk.push({ count: count(), at: editor.selectionStart, scroll: Math.round(editor.scrollTop) });
    }
    await press('Enter', true);
    const back = { count: count(), at: editor.selectionStart };

    // The note must not take a keystroke meant for the search.
    const noteBefore = editor.value;
    const focusOnBox = document.activeElement === input;
    input.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Backspace', bubbles: true, cancelable: true }));
    await wait(150);
    // Read it now: the tidy-up below leaves source mode, which empties the box.
    const noteUntouched = noteBefore === editor.value;

    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    return { opened, beforeEnter, walk, back, focusOnBox, noteUntouched };
  })()`, true);

  ok('Ctrl-F 로 열림', r.opened);
  ok('타이핑만으로는 찾지 않음', r.beforeEnter === 'Enter로 찾기', r.beforeEnter);
  ok('Enter 마다 다음으로', r.walk.map((w) => w.count).join(' ') === '1 / 40 2 / 40 3 / 40',
    r.walk.map((w) => w.count).join(' '));
  // Not checked here: whether the view scrolls to each match. The offscreen
  // window does lay the page out — the check below proves it, by giving the
  // textarea a height and watching it scroll — but the panes come up with no
  // height of their own, so scrollTop stays 0 whatever the code does unless a
  // height is forced. Measured by hand instead: 418 → 478 → 942 → 1083.
  ok('Shift+Enter 는 이전으로', r.back.count === '2 / 40', r.back.count);
  ok('포커스가 찾기 상자에 머무름', r.focusOnBox);
  ok('백스페이스가 노트를 건드리지 않음', r.noteUntouched);

  // The mark over the current match is positioned fixed, so it has to be put
  // back whenever the text slides under it. The pane's own height is not to be
  // relied on here, so the textarea is given one that certainly scrolls.
  const follow = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    const original = window.__doc;
    const line = (n) => '<p>라벨 ' + n + ' 줄입니다. 길게 적어 두어 줄이 넘어가게 합니다.</p>';
    window.__doc = '<html><head><title>t</title></head><body>'
      + Array.from({ length: 40 }, (_, i) => line(i + 1)).join('') + '</body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('source').click();
    await wait(400);

    const editor = document.getElementById('sourceEditor');
    const mark = document.getElementById('sourceMark');
    const input = document.getElementById('findInput');
    editor.style.height = '60px';
    await wait(100);

    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(150);
    input.value = '라벨';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(300);

    const scrollable = editor.scrollHeight - editor.clientHeight;
    const first = parseFloat(mark.style.top);
    editor.scrollTop = 120;
    editor.dispatchEvent(new Event('scroll', { bubbles: true }));
    await wait(150);
    const moved = parseFloat(mark.style.top);
    const by = Math.round(editor.scrollTop);

    editor.style.height = '';
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    return { scrollable, first, moved, by };
  })()`, true);

  // Only meaningful if the textarea really scrolled; say so rather than pass by
  // default.
  ok('소스 창이 스크롤됨 (아래 검사의 전제)', follow.scrollable > 120,
    'scrollable=' + follow.scrollable);
  ok('표시가 스크롤을 따라 내려감', Math.abs((follow.first - follow.moved) - follow.by) <= 1,
    `${follow.first} → ${follow.moved} (스크롤 ${follow.by})`);

  // Browse mode goes out to Chromium's own search. It answers a fresh find —
  // findNext false — with no event at all, so a new word used to wait for a
  // timeout and come back "없음".
  const browse = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    await wait(800);
    const original = window.__doc;
    const line = (n) => '<p>' + n + ' 줄 ' + (n % 20 === 0 ? '라벨' : '보통') + ' 내용입니다.</p>';
    window.__doc = '<html><head><title>t</title></head><body>'
      + Array.from({ length: 200 }, (_, i) => line(i + 1)).join('') + '</body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(600);

    const frame = document.getElementById('noteFrame');
    const top = () => Math.round(frame.contentDocument.documentElement.scrollTop);
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    const input = document.getElementById('findInput');
    input.value = '라벨';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);

    const steps = [];
    for (let i = 0; i < 3; i += 1) {
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      await wait(500);
      steps.push({ count: document.getElementById('findCount').textContent, top: top() });
    }

    // A different word has to answer at once, not after a timeout.
    input.value = '보통';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
    const started = Date.now();
    input.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
    // Wait for an answer rather than a fixed moment, and record how long it took.
    let swapCount = document.getElementById('findCount').textContent;
    for (let i = 0; i < 30 && !/\\d+ \\/ \\d+|없음/.test(swapCount); i += 1) {
      await wait(100);
      swapCount = document.getElementById('findCount').textContent;
    }
    const swap = { count: swapCount, ms: Date.now() - started };

    document.getElementById('findClose').click();
    window.__doc = original;
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    return { steps, swap };
  })()`, true);

  // Ten in the note. The count used to be higher because Chromium's own find
  // reads the whole window — the tree's note names, the title bar.
  ok('노트 안의 것만 셀', browse.steps[0].count === '1 / 10', browse.steps[0].count);
  ok('보기 모드에서 화면이 따라감',
    browse.steps[1].top > browse.steps[0].top && browse.steps[2].top > browse.steps[1].top,
    browse.steps.map((s) => s.top).join(' → '));
  ok('다른 낱말도 곧바로 찾음',
    /^\d+ \/ \d+$/.test(browse.swap.count) && browse.swap.ms < 1200,
    `${browse.swap.count} · ${browse.swap.ms}ms`);
}

/**
 * Find and replace, in the note and in the source.
 *
 * Every replacement goes through execCommand('insertText'). The reason is the
 * undo stack: editing the document directly is what once made Ctrl+Z put words
 * back in the wrong places, so what matters here is not only that the text
 * changes but that undoing walks back through it.
 *
 * 모두 바꾸기 runs from the last match to the first. Forwards, a replacement
 * containing the search term feeds itself a new match forever, which is checked
 * below by replacing 가 with 가가.
 */
async function replaceInNote(win) {
  console.log('\n■ 찾아바꾸기');

  // 뒤따르는 검사는 여기 남은 문서에 의지한다 (표와 <font> 가 있는 것).
  // 세 번 갈아치우므로 붙잡아 두었다가 나갈 때 돌려놓는다.
  const original = await win.webContents.executeJavaScript('window.__doc', true);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    const text = () => document.getElementById('noteFrame').contentDocument.body.textContent;

    window.__doc = '<html><head><title>t</title></head><body>'
      + '<p>사과 하나 사과 둘</p><p>배 하나 사과 셋</p></body></html>';
    window.__mtime += 1;
    pick('browse').click();
    await wait(200);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);

    const bar = document.getElementById('findBar');
    const find = document.getElementById('findInput');
    const swap = document.getElementById('replaceInput');
    const one = document.getElementById('replaceOne');
    const all = document.getElementById('replaceAll');
    const count = () => document.getElementById('findCount').textContent;
    const shown = (node) => !node.classList.contains('hidden');

    // 보기 모드에서는 바꾸기를 내주지 않는다
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    const browseHides = !shown(swap) && !shown(one) && !shown(all);
    const barOpen = !bar.classList.contains('hidden');

    // 편집 모드로 가면 그대로 나타난다
    pick('edit').click();
    await wait(300);
    const editShows = shown(swap) && shown(one) && shown(all);

    // 한 자리만 바꾼다
    find.value = '사과';
    find.dispatchEvent(new Event('input', { bubbles: true }));
    find.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(250);
    const foundThree = count();

    swap.value = '포도';
    one.click();
    await wait(350);
    const afterOne = text();

    // 남은 것을 모두 바꾼다
    all.click();
    await wait(500);
    const afterAll = text();
    const allCount = count();

    // 되돌리기가 바꾼 것을 거꾸로 밟는다
    const d = document.getElementById('noteFrame').contentDocument;
    d.body.focus();
    d.execCommand('undo');
    await wait(200);
    const afterUndo = text();

    return {
      barOpen, browseHides, editShows, foundThree,
      afterOne, afterAll, allCount, afterUndo,
    };
  })()`, true);

  ok('보기 모드에서도 Ctrl-H 로 찾기는 열림', r.barOpen);
  ok('보기 모드에서는 바꾸기를 내주지 않음', r.browseHides);
  ok('편집 모드에서는 바꾸기가 나타남', r.editShows);
  ok('세 자리를 찾음', r.foundThree === '1 / 3', r.foundThree);
  ok('바꾸기가 한 자리만 바꿈',
    (r.afterOne.match(/포도/g) || []).length === 1
    && (r.afterOne.match(/사과/g) || []).length === 2, r.afterOne);
  ok('모두가 남은 자리를 다 바꿈', !r.afterAll.includes('사과'), r.afterAll);
  ok('바꾼 개수를 알려줌', r.allCount === '2곳 바꿈', r.allCount);
  ok('다른 글자는 그대로', r.afterAll.includes('배 하나'), r.afterAll);
  ok('되돌리기가 한 걸음 물러남',
    r.afterUndo !== r.afterAll && r.afterUndo.includes('사과'), r.afterUndo);

  // 바꿀 말이 찾는 말을 품고 있어도 끝난다 — 앞에서 뒤로 돌면 영원히 돈다
  const grow = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    const text = () => document.getElementById('noteFrame').contentDocument.body.textContent;

    pick('browse').click();
    // 앞 검사가 남긴 저장이 __doc 을 덮은 뒤에 새 문서를 놓는다
    await wait(700);
    window.__doc = '<html><head><title>t</title></head><body><p>가 나 가 다 가</p></body></html>';
    window.__mtime += 1;
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('edit').click();
    await wait(300);

    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    document.getElementById('findInput').value = '가';
    document.getElementById('replaceInput').value = '가가';

    const started = Date.now();
    document.getElementById('replaceAll').click();
    await wait(700);
    return { ms: Date.now() - started, out: text(),
      count: document.getElementById('findCount').textContent };
  })()`, true);

  ok('바꿀 말이 찾는 말을 품어도 끝난다', grow.ms < 700 * 3, `${grow.ms}ms`);
  ok('세 자리가 각각 한 번만 늘어남',
    grow.out.replace(/\s/g, '') === '가가나가가다가가', grow.out);
  ok('세 곳으로 셈', grow.count === '3곳 바꿈', grow.count);

  // 소스 모드에서도 바꾸고, 그것이 파일에 남는다
  const source = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);

    pick('browse').click();
    // 앞 검사가 남긴 저장이 __doc 을 덮은 뒤에 새 문서를 놓는다
    await wait(700);
    window.__doc = '<html><head><title>t</title></head><body><p>낡은 말</p></body></html>';
    window.__mtime += 1;
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    pick('source').click();
    await wait(400);

    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    const shownHere = !document.getElementById('replaceInput').classList.contains('hidden');

    document.getElementById('findInput').value = '낡은';
    document.getElementById('replaceInput').value = '새로운';
    document.getElementById('replaceAll').click();
    await wait(1400);

    return {
      shownHere,
      editor: document.getElementById('sourceEditor').value,
      saved: String(window.__doc),
    };
  })()`, true);

  ok('소스 모드에서도 바꾸기가 나타남', source.shownHere);
  ok('소스 편집기의 글자가 바뀜',
    source.editor.includes('새로운 말') && !source.editor.includes('낡은'), source.editor);
  ok('바꾼 것이 파일에 남음',
    source.saved.includes('새로운 말') && !source.saved.includes('낡은'),
    source.saved.slice(0, 120));
  ok('문서 나머지는 그대로', source.saved.includes('<title>t</title>'));

  // 뒷정리. 고친 노트를 소스 모드에 그대로 두고 나가면, 다음 검사가 놓아둔
  // window.__doc 을 이 노트의 저장이 덮어써서 엉뚱한 문서를 보게 된다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.mode-btn')]
      .find(b => b.dataset.mode === 'browse').click();
    await wait(900);
    window.__doc = ${JSON.stringify(original)};
    window.__mtime += 1;
  })()`, true);
}

/**
 * A picture has to be removable with the mouse.
 *
 * Chromium puts a collapsed caret in the text beside an image when you click
 * it, so Delete had nothing to act on: a picture could be inserted and then
 * only reached by editing the source. The fix is to select it on click and let
 * the browser do the deleting, which is also what keeps it in the undo stack.
 *
 * The key press itself needs trusted input, which this harness cannot send —
 * that was measured separately. What is checked here is the selection the
 * click leaves behind, and that the delete command acting on that selection
 * takes the picture out. Those are the two halves the key press joins.
 */
async function clickingAPictureSelectsIt(win) {
  console.log('\n■ 그림을 클릭하면 선택된다');

  const original = await win.webContents.executeJavaScript('window.__doc', true);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    const GIF = 'data:image/gif;base64,'
      + 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    pick('browse').click();
    await wait(700);
    window.__doc = '<html><head><title>t</title></head><body>'
      + '<p>앞 글자</p><p><img id="pic" width="80" height="60" src="' + GIF + '"></p>'
      + '<p>뒤 글자</p></body></html>';
    window.__mtime += 1;
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);

    const d = document.getElementById('noteFrame').contentDocument;
    const view = d.defaultView;
    const held = () => {
      const sel = view.getSelection();
      if (!sel.rangeCount) return false;
      const r = sel.getRangeAt(0);
      return [...r.cloneContents().childNodes].some(n => n.nodeName === 'IMG');
    };
    const clickPic = () => {
      const pic = d.getElementById('pic');
      pic.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }));
    };

    // 보기 모드에서는 고르지 않는다 — 지울 수 없는 자리에서 선택은 뜻이 없다
    pick('browse').click();
    await wait(250);
    clickPic();
    await wait(100);
    const inBrowse = held();

    pick('edit').click();
    await wait(350);
    clickPic();
    await wait(120);
    const inEdit = held();
    const collapsed = view.getSelection().isCollapsed;

    // 그 선택을 두고 지우면 그림이 나간다 — 키가 하는 일과 같은 길이다
    d.body.focus();
    const before = d.body.innerHTML;
    d.execCommand('delete');
    await wait(150);
    const gone = !d.getElementById('pic');

    // 되돌리기로 다시 돌아온다
    d.execCommand('undo');
    await wait(150);
    const back = !!d.getElementById('pic');

    // 글자를 클릭해도 그림을 잡지는 않는다. 합성 클릭은 캐럿을 옮기지 못하니
    // 먼저 선택을 접어 두고, 그 상태가 그대로인지를 본다 — 우리 핸들러가
    // 아무것도 새로 잡지 않는다는 뜻이다.
    const sel = view.getSelection();
    sel.removeAllRanges();
    const flat = d.createRange();
    flat.setStart(d.querySelectorAll('p')[0], 0);
    flat.collapse(true);
    sel.addRange(flat);
    const para = d.querySelectorAll('p')[0];
    para.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    const onText = held();

    return { inBrowse, inEdit, collapsed, gone, back, onText, hadPic: before.includes('id="pic"') };
  })()`, true);

  ok('편집 모드에서 그림을 클릭하면 선택된다', r.inEdit, JSON.stringify(r));
  ok('선택이 접혀 있지 않다', r.collapsed === false);
  ok('보기 모드에서는 선택하지 않는다', r.inBrowse === false);
  ok('글자를 클릭하면 그림을 잡지 않는다', r.onText === false);
  ok('그 선택으로 지우면 그림이 나간다', r.hadPic && r.gone);
  ok('되돌리기로 다시 돌아온다', r.back);

  // 뒤따르는 검사가 이 문서에 의지한다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.mode-btn')]
      .find(b => b.dataset.mode === 'browse').click();
    await wait(900);
    window.__doc = ${JSON.stringify(original)};
    window.__mtime += 1;
  })()`, true);
}

/**
 * Ctrl+P and the toolbar button have to reach the main process.
 *
 * Both are wired in the renderer, but wired is not the same as reached: a
 * shortcut can be swallowed by an earlier branch, and a button can be bound
 * before the element exists. What is checked here is that the ask arrives,
 * carrying the note the user is looking at.
 */
async function printingReachesTheMainProcess(win) {
  console.log('\n■ 인쇄');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pick = (m) => [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === m);
    const asks = () => window.__calls.filter(c => c.name === 'saveNotePdf');

    pick('browse').click();
    await wait(500);
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);

    const button = document.getElementById('btnPrint');
    const hasButton = !!button;
    window.__calls.length = 0;

    button.click();
    await wait(400);
    const afterClick = asks().length;
    const asked = asks()[0] || null;

    window.__calls.length = 0;
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(400);
    const afterKey = asks().length;

    // 프레임 안에 포커스가 있을 때도 닿아야 한다 — 편집하다 누르는 자리다
    pick('edit').click();
    await wait(350);
    window.__calls.length = 0;
    const d = document.getElementById('noteFrame').contentDocument;
    d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',
      { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(400);
    const afterFrameKey = asks().length;

    pick('browse').click();
    await wait(400);
    return { hasButton, afterClick, afterKey, afterFrameKey, asked };
  })()`, true);

  ok('인쇄 단추가 있다', r.hasButton);
  ok('단추를 누르면 PDF 저장을 부른다', r.afterClick === 1, String(r.afterClick));
  ok('보고 있는 노트를 넘긴다',
    r.asked && r.asked.payload && r.asked.payload.relativePath === '루트노트.html',
    JSON.stringify(r.asked && r.asked.payload));
  ok('Ctrl-P 로도 부른다', r.afterKey === 1, String(r.afterKey));
  ok('노트 안에서 눌러도 부른다', r.afterFrameKey === 1, String(r.afterFrameKey));
}

/**
 * The dark rendering must map the note's own colours, follow the single theme
 * control, and never reach the file.
 */
async function darkNoteSurface(win) {
  console.log('\n■ 노트 어둡게 보기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const styleId = 'csfreenote-view-style';
    const frame = document.getElementById('noteFrame');
    const has = () => !!frame.contentDocument.getElementById(styleId);

    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'browse').click();
    await wait(250);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);

    const d = frame.contentDocument;
    const initial = has();
    const table = d.querySelector('[bgcolor]');
    const headerBg = table ? getComputedStyle(table).backgroundColor : '';
    const caption = d.querySelector('font[color]');
    const captionColor = caption ? getComputedStyle(caption).color : '';
    const bodyBg = getComputedStyle(d.body).backgroundColor;
    const inHead = initial && d.getElementById(styleId).parentElement.tagName === 'HEAD';

    // one control: the theme button drives the note too
    document.getElementById('btnTheme').click();
    await wait(250);
    const afterLight = has();
    const lightTableBg = table ? getComputedStyle(table).backgroundColor : '';
    document.getElementById('btnTheme').click();
    await wait(250);
    const afterDark = has();

    // edit with the dark rendering on, then save
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'edit').click();
    await wait(250);
    frame.contentDocument.body.insertAdjacentHTML('beforeend', '<p>어둡게 보며 쓴 문단</p>');
    frame.contentDocument.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'browse').click();
    await wait(600);

    return {
      initial, inHead, headerBg, captionColor, bodyBg,
      afterLight, lightTableBg, afterDark,
      hasSurfaceButton: !!document.getElementById('btnSurface'),
      savedDoc: window.__doc,
    };
  })()`, true);

  ok('별도 버튼 없이 테마 하나로 관리', r.hasSurfaceButton === false);
  ok('어두운 테마에서 켜짐', r.initial === true);
  ok('스타일이 <head> 에 들어감', r.inHead === true);
  ok('표 머리 #3c62c6 이 어두운 남색으로', r.headerBg === 'rgb(31, 42, 71)', r.headerBg);
  ok('머리글 흰 글씨는 밝게 유지', r.captionColor === 'rgb(235, 235, 235)', r.captionColor);
  ok('본문 배경이 어두워짐', r.bodyBg === 'rgb(22, 24, 29)', r.bodyBg);
  ok('테마를 밝게 하면 노트도 원래 색', r.afterLight === false && r.lightTableBg === 'rgb(60, 98, 198)',
    `${r.afterLight} / ${r.lightTableBg}`);
  ok('다시 어둡게 하면 되돌아옴', r.afterDark === true);
  ok('편집 내용은 저장됨', String(r.savedDoc).includes('어둡게 보며 쓴 문단'));
  ok('주입한 스타일은 파일에 없음',
    !String(r.savedDoc).includes('csfreenote-view-style')
    && !String(r.savedDoc).includes('1f2a47'));
}


/** The status bar answers "which file am I looking at, and what is it". */
async function statusBar(win) {
  console.log('\n■ 상태바');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const read = () => ({
      path: document.getElementById('statusPath').textContent,
      title: document.getElementById('statusPath').title,
      meta: document.getElementById('statusMeta').textContent,
      // No encoding badge: notes are UTF-8, and one that is not is refused
      // rather than opened, so the label could only ever say one thing.
      badge: !!document.getElementById('statusEncoding'),
    });

    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    const utf8 = read();

    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(300);
    const euckr = read();

    return { utf8, euckr };
  })()`, true);

  ok('열린 노트 경로를 보여줌', r.utf8.path === '루트노트.html', r.utf8.path);
  ok('수정 시각과 크기를 보여줌',
    /\d/.test(r.utf8.meta) && /B|KB|MB/.test(r.utf8.meta), r.utf8.meta);
  ok('인코딩 표시는 없음', r.utf8.badge === false);
  ok('노트를 바꾸면 따라감', r.euckr.path === '폴더A/안쪽노트.html', r.euckr.path);
  ok('전체 경로를 툴팁으로', r.euckr.title === '폴더A/안쪽노트.html', r.euckr.title);
}


/** Typing in the search box should reach the main process and list hits. */
async function searchPanel(win) {
  console.log('\n■ 검색');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;

    document.getElementById('btnSearch').click();
    await wait(80);
    const opened = !document.getElementById('searchPanel').classList.contains('hidden');

    const input = document.getElementById('searchInput');
    input.value = '모듈';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(500);

    const hits = [...document.querySelectorAll('.search-hit')].map(b => b.textContent);
    const calls = window.__calls.filter(c => c.name === 'searchNotes');

    // clicking a hit opens that note
    const first = document.querySelector('.search-hit');
    if (first) first.click();
    await wait(300);
    const openedPath = document.getElementById('notePath').textContent;

    return { opened, hits, calls, openedPath };
  })()`, true);

  ok('검색 패널이 열림', r.opened === true);
  ok('입력이 메인 프로세스로 전달됨', r.calls.length >= 1, JSON.stringify(r.calls));
  ok('검색어가 그대로 전달됨', r.calls.some((c) => c.payload.query === '모듈'),
    JSON.stringify(r.calls.map((c) => c.payload)));
  ok('결과가 목록으로 표시됨', r.hits.length === 2, JSON.stringify(r.hits));
  ok('결과에 발췌가 보임', r.hits.every((h) => h.includes('모듈')), JSON.stringify(r.hits));
  ok('결과를 누르면 그 노트가 열림', r.openedPath === '루트노트.html', r.openedPath);
}


/** A stray drag has to be reversible from the message it produces. */
async function undoAMove(win) {
  console.log('\n■ 이동 되돌리기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;

    const rowFor = (rel) => document.querySelector('[data-path="' + CSS.escape(rel) + '"] > .tree-row');
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));

    fire(rowFor('폴더A/안쪽노트.html'), 'dragstart');
    fire(rowFor('폴더B'), 'dragover');
    fire(rowFor('폴더B'), 'drop');
    await wait(300);

    const toast = document.getElementById('toast');
    const button = toast && toast.querySelector('.toast-action');
    const label = button ? button.textContent : '';
    if (button) button.click();
    await wait(300);

    return {
      label,
      calls: window.__calls.filter(c => c.name === 'moveItem').map(c => c.payload),
      toastGone: !toast || toast.classList.contains('hidden'),
    };
  })()`, true);

  ok('되돌리기 버튼이 제공됨', r.label === '되돌리기', r.label);
  ok('이동과 되돌리기 두 번 호출됨', r.calls.length === 2, JSON.stringify(r.calls));
  if (r.calls.length === 2) {
    ok('처음 이동은 폴더B 로', r.calls[0].targetFolder === '폴더B', JSON.stringify(r.calls[0]));
    ok('되돌리기는 원래 폴더로', r.calls[1].targetFolder === '폴더A', JSON.stringify(r.calls[1]));
    ok('되돌리기는 이동이지 복사가 아님', !r.calls[1].copy);
  }
  ok('되돌린 뒤 메시지가 사라짐', r.toastGone === true);
}


/** The settings dialog lists books and lets one be opened. */
async function settingsDialog(win) {
  console.log('\n■ 환경설정');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;

    document.getElementById('btnSettings').click();
    await wait(250);

    const dialog = document.getElementById('settings');
    const rows = [...document.querySelectorAll('.book-row')];
    const opened = !dialog.classList.contains('hidden');
    const names = rows.map(r => r.querySelector('span').textContent);
    const openBadge = rows.filter(r => r.querySelector('.book-badge.open')).length;
    const missingBadge = rows.filter(r => r.querySelector('.book-badge.missing')).length;
    const autosave = document.getElementById('setAutosave').value;
    const startMode = document.getElementById('setStartMode').value;

    // selecting the third row: it is missing, so opening it should be refused
    rows[2].click();
    await wait(60);
    rows[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(200);
    const refusedStillOpen = !dialog.classList.contains('hidden');
    const selectCalls = window.__calls.filter(c => c.name === 'selectBook').length;

    // a real one opens and closes the dialog
    rows[1].click();
    rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(400);
    const closedAfterOpen = dialog.classList.contains('hidden');

    document.getElementById('btnSettings').click();
    await wait(200);
    document.getElementById('setAutosave').value = '2.5';
    document.getElementById('setAutosave').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);
    const saved = window.__calls.filter(c => c.name === 'saveSettings').map(c => c.payload);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(150);
    const closedByEscape = document.getElementById('settings').classList.contains('hidden');

    return {
      opened, names, openBadge, missingBadge, autosave, startMode,
      refusedStillOpen, selectCalls, closedAfterOpen, saved, closedByEscape,
    };
  })()`, true);

  ok('설정 창이 열림', r.opened === true);
  ok('등록된 폴더가 모두 보임', r.names.length === 3, JSON.stringify(r.names));
  ok('현재 열린 폴더를 표시', r.openBadge === 1, String(r.openBadge));
  ok('경로 없는 폴더를 표시', r.missingBadge === 1, String(r.missingBadge));
  ok('자동저장 간격이 초 단위로 보임', r.autosave === '0.7', r.autosave);
  ok('시작 모드가 보임', r.startMode === 'browse', r.startMode);
  ok('경로 없는 폴더는 열지 않음', r.refusedStillOpen === true && r.selectCalls === 0,
    `open=${r.refusedStillOpen} calls=${r.selectCalls}`);
  ok('폴더를 열면 창이 닫힘', r.closedAfterOpen === true);
  ok('자동저장 간격이 저장됨',
    r.saved.some((p) => p.editor && p.editor.autosaveMs === 2500), JSON.stringify(r.saved));
  ok('Esc 로 닫힘', r.closedByEscape === true);
}


/** Ctrl-1..9 apply a saved format to the selection, and only what it names. */
async function formatPresets(win) {
  console.log('\n■ 텍스트 서식');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;

    // the editor rows show up in settings
    document.getElementById('btnSettings').click();
    await wait(250);
    const rows = [...document.querySelectorAll('.format-row')];
    const keys = rows.map(r => r.querySelector('.format-key').textContent);
    const labels = rows.map(r => r.querySelector('input[type=text]').value);
    const toggleStates = [...rows[0].querySelectorAll('.format-toggle')].map(b => b.dataset.state);
    // colour left blank looks different from a colour set to black
    const unsetSwatches = rows[1].querySelectorAll('.format-swatch.unset').length;

    // cycling a toggle saves
    rows[1].querySelectorAll('.format-toggle')[0].click();
    await wait(200);
    const afterToggle = window.__formats[1].bold;

    document.getElementById('settingsClose').click();
    await wait(150);

    // now apply one to a real selection
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'edit').click();
    await wait(300);

    const d = document.getElementById('noteFrame').contentDocument;
    d.body.insertAdjacentHTML('beforeend', '<p id="target">서식 적용 대상</p>');
    const target = d.getElementById('target');
    const range = d.createRange();
    range.selectNodeContents(target);
    const sel = d.getSelection();
    sel.removeAllRanges(); sel.addRange(range);

    // Ctrl-5 is 파랑 강조: colour + bold, and nothing else
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', ctrlKey: true, bubbles: true }));
    await wait(250);
    const html = target.innerHTML;

    // with nothing selected it should say so rather than act
    sel.removeAllRanges();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', ctrlKey: true, bubbles: true }));
    await wait(200);
    const toast = document.getElementById('toast');
    const warned = toast && !toast.classList.contains('hidden') ? toast.textContent : '';

    return { keys, labels, toggleStates, unsetSwatches, afterToggle, html, warned };
  })()`, true);

  ok('아홉 개 슬롯이 보임', r.keys.length === 9 && r.keys[8] === 'Ctrl-9', JSON.stringify(r.keys));
  ok('기본 이름이 들어 있음', r.labels[0] === '본문' && r.labels[4] === '파랑 강조',
    JSON.stringify(r.labels));
  ok('토글이 세 가지 상태를 씀',
    r.toggleStates[0] === 'off' && r.toggleStates[1] === 'off-unset',
    JSON.stringify(r.toggleStates));
  ok('지정 안 한 색은 흐리게 표시', r.unsetSwatches === 2, String(r.unsetSwatches));
  ok('토글을 누르면 저장됨', r.afterToggle === true, String(r.afterToggle));
  ok('선택한 글에 색이 적용됨', /#3c62c6|rgb\(60, ?98, ?198\)/i.test(r.html), r.html);
  ok('굵게도 함께 적용됨', /<b>|font-weight/i.test(r.html), r.html);
  ok('지정하지 않은 형광펜은 건드리지 않음', !/background/i.test(r.html), r.html);
  ok('선택 없이 누르면 알려줌', r.warned.includes('선택'), r.warned);
}


/**
 * One confirmation must produce one delete.
 *
 * Two dialogs could stack, each listening for Enter, so a single keypress
 * answered both and the second delete hit a note that was already gone.
 */
async function singleDelete(win) {
  console.log('\n■ 삭제는 한 번만');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;

    const row = document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row');
    // ask twice in a row, the way an impatient second keypress would
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    await wait(60);
    const first = [...document.querySelectorAll('.context-item')].find(b => b.textContent.startsWith('삭제'));
    first.click();
    await wait(60);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    await wait(60);
    const second = [...document.querySelectorAll('.context-item')].find(b => b.textContent.startsWith('삭제'));
    const secondOffered = !!second;
    if (second) second.click();
    await wait(80);

    const dialogs = document.querySelectorAll('#modal:not(.hidden)').length;

    // one Enter to confirm
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(400);

    return {
      secondOffered,
      dialogs,
      deletes: window.__calls.filter(c => c.name === 'deleteItem').length,
      stillOpen: document.querySelectorAll('#modal:not(.hidden)').length,
    };
  })()`, true);

  ok('대화상자는 하나만 떠 있음', r.dialogs === 1, String(r.dialogs));
  ok('확인 한 번에 삭제 한 번', r.deletes === 1, `deleteItem ${r.deletes}회`);
  ok('확인 뒤 대화상자가 닫힘', r.stillOpen === 0, String(r.stillOpen));
}


/** Selecting a folder should show what that folder is. */
async function folderDescription(win) {
  console.log('\n■ 폴더 설명');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;

    // 폴더A has a description
    document.querySelector('[data-path="폴더A"] > .tree-row').click();
    await wait(350);
    const withMarker = {
      editorShown: !document.getElementById('editorRoot').classList.contains('hidden'),
      title: document.getElementById('noteTitle').textContent,
      path: document.getElementById('notePath').textContent,
      reads: window.__calls.filter(c => c.name === 'readNote').length,
    };

    // 폴더B has none
    window.__calls.length = 0;
    document.querySelector('[data-path="폴더B"] > .tree-row').click();
    await wait(300);
    const empty = document.getElementById('emptyState');
    const withoutMarker = {
      emptyShown: !empty.classList.contains('hidden'),
      heading: empty.querySelector('h1') ? empty.querySelector('h1').textContent : '',
      hasButton: !!empty.querySelector('.empty-action'),
    };

    // and the offer creates one
    const button = empty.querySelector('.empty-action');
    if (button) button.click();
    await wait(400);
    const created = window.__calls.filter(c => c.name === 'describeFolder');
    const nowEditing = [...document.querySelectorAll('.mode-btn')]
      .find(b => b.classList.contains('active')).dataset.mode;

    return { withMarker, withoutMarker, created, nowEditing };
  })()`, true);

  ok('설명이 있는 폴더는 문서를 엶', r.withMarker.editorShown === true);
  ok('폴더 이름을 제목으로 보여줌', r.withMarker.title === '폴더A', r.withMarker.title);
  ok('마커 파일 경로는 그대로 표시',
    r.withMarker.path.endsWith('___cs_free_note__folder.html'), r.withMarker.path);
  ok('설명 없는 폴더는 빈 화면', r.withoutMarker.emptyShown === true);
  ok('빈 화면에 폴더 이름이 나옴', r.withoutMarker.heading === '폴더B', r.withoutMarker.heading);
  ok('설명을 만들 수 있게 안내', r.withoutMarker.hasButton === true);
  ok('만들기를 누르면 생성 요청', r.created.length === 1, JSON.stringify(r.created));
  ok('만든 뒤 바로 편집 모드', r.nowEditing === 'edit', r.nowEditing);
}


/** The three behaviour options, and that they actually change behaviour. */
async function behaviourOptions(win) {
  console.log('\n■ 동작 설정');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const mode = () => [...document.querySelectorAll('.mode-btn')]
      .find(b => b.classList.contains('active')).dataset.mode;

    // start from a note, in edit mode
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'browse').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(300);
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'edit').click();
    await wait(250);
    const before = mode();

    // moving to another note should drop back to browse
    document.querySelector('[data-path="폴더A/안쪽노트.html"] > .tree-row').click();
    await wait(400);
    const afterSwitch = mode();

    // the settings dialog shows all three
    document.getElementById('btnSettings').click();
    await wait(250);
    const shown = {
      scope: document.getElementById('setSearchScope').value,
      startAs: document.getElementById('setStartAs').value,
      returnToBrowse: document.getElementById('setReturnToBrowse').checked,
      minimizeToTray: document.getElementById('setMinimizeToTray').checked,
    };

    window.__calls.length = 0;
    const scope = document.getElementById('setSearchScope');
    scope.value = 'book';
    scope.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);

    const startAs = document.getElementById('setStartAs');
    startAs.value = 'maximized';
    startAs.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);

    const back = document.getElementById('setReturnToBrowse');
    back.checked = false;
    back.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);
    const saved = window.__calls.filter(c => c.name === 'saveSettings').map(c => c.payload);

    document.getElementById('settingsClose').click();
    await wait(150);

    // with the option off, edit mode now survives moving note
    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'edit').click();
    await wait(250);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(400);
    const afterOptionOff = mode();

    // and search now asks for the whole book
    window.__calls.length = 0;
    document.querySelector('[data-path="폴더A"] > .tree-row').click();
    await wait(300);
    document.getElementById('btnSearch').click();
    const input = document.getElementById('searchInput');
    input.value = '모듈';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(500);
    const searches = window.__calls.filter(c => c.name === 'searchNotes').map(c => c.payload);

    return { before, afterSwitch, shown, saved, afterOptionOff, searches };
  })()`, true);

  ok('편집 모드로 들어감', r.before === 'edit', r.before);
  ok('다른 노트로 옮기면 보기 모드로', r.afterSwitch === 'browse', r.afterSwitch);
  ok('설정 창이 현재 값을 보여줌',
    r.shown.scope === 'folder' && r.shown.startAs === 'restore'
    && r.shown.returnToBrowse === true && r.shown.minimizeToTray === false,
    JSON.stringify(r.shown));
  ok('검색 범위가 저장됨',
    r.saved.some((p) => p.ui && p.ui.searchWholeBook === true), JSON.stringify(r.saved));
  ok('창 여는 방식이 저장됨',
    r.saved.some((p) => p.window && p.window.startAs === 'maximized'), JSON.stringify(r.saved));
  ok('보기 모드 복귀 설정이 저장됨',
    r.saved.some((p) => p.editor && p.editor.returnToBrowse === false), JSON.stringify(r.saved));
  ok('꺼두면 편집 모드가 유지됨', r.afterOptionOff === 'edit', r.afterOptionOff);
  ok('검색이 폴더 전체를 대상으로',
    r.searches.length > 0 && r.searches.every((p) => p.scopeRelative === ''),
    JSON.stringify(r.searches));
}


/** F5 and the toolbar button stamp the time, wherever the caret happens to be. */
async function dateStamp(win) {
  console.log('\n■ 날짜·시각 넣기');

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const caretIn = (d, el) => {
      const range = d.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };

    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'browse').click();
    await wait(200);
    document.querySelector('[data-path="루트노트.html"] > .tree-row').click();
    await wait(350);

    // browse mode must not write anything
    const d0 = document.getElementById('noteFrame').contentDocument;
    const beforeBrowse = d0.body.innerHTML;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await wait(200);
    const browseUntouched = d0.body.innerHTML === beforeBrowse;

    [...document.querySelectorAll('.mode-btn')].find(b => b.dataset.mode === 'edit').click();
    await wait(350);
    const d = document.getElementById('noteFrame').contentDocument;

    // an empty paragraph — where execCommand alone does nothing
    d.body.insertAdjacentHTML('beforeend', '<p id="empty"></p>');
    caretIn(d, d.getElementById('empty'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await wait(250);
    const inEmpty = d.getElementById('empty').textContent;

    // among existing text
    d.body.insertAdjacentHTML('beforeend', '<p id="filled">기존 </p>');
    caretIn(d, d.getElementById('filled'));
    document.querySelector('[data-cmd="datetime"]').click();
    await wait(250);
    const inText = d.getElementById('filled').textContent;

    // the settings field previews what the format produces
    document.getElementById('btnSettings').click();
    await wait(250);
    const field = document.getElementById('setDateFormat');
    const shown = field.value;
    field.value = 'yyyy년 m월 d일';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(100);
    const preview = document.getElementById('dateFormatPreview').textContent;
    document.getElementById('settingsClose').click();
    await wait(150);

    return { browseUntouched, inEmpty, inText, shown, preview };
  })()`, true);

  const stamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
  ok('보기 모드에서는 아무 일도 없음', r.browseUntouched === true);
  ok('빈 문단에도 들어감', stamp.test(r.inEmpty), JSON.stringify(r.inEmpty));
  ok('글자 사이에도 들어감',
    r.inText.includes('기존') && stamp.test(r.inText), JSON.stringify(r.inText));
  ok('설정에 형식이 보임', r.shown === 'yyyy-mm-dd hh:nn', r.shown);
  ok('형식을 바꾸면 결과를 미리 보여줌',
    /^\d{4}년 \d{1,2}월 \d{1,2}일$/.test(r.preview), r.preview);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      // The app runs its preload unsandboxed so it can share electron/document
      // with the renderer. The stub has to be able to do the same.
      sandbox: false,
      preload: path.join(__dirname, 'support', 'stub-preload.js'),
    },
  });
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (/error|Refused/i.test(msg)) console.log(`    [renderer] ${msg}`);
  });

  // 이 검사만 홀로 진짜 렌더러를 띄운다. 그 렌더러는 vite 가 만든 것이라
  // 저장소에 없고, 사람 기계에는 지난 빌드가 남아 있어 없는 줄을 모른다.
  // 갓 받아온 기계에서는 없고, loadFile 의 거절은 아무도 받지 않아 검사가
  // 영원히 매달린다 — CI 에서 35분을 말없이 앉아 있다 잘렸다.
  const page = path.join(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(page)) {
    console.error('');
    console.error('  렌더러가 아직 만들어지지 않았습니다:');
    console.error(`    ${page}`);
    console.error('');
    console.error('  먼저 npm run build 를 실행하세요.');
    console.error('');
    process.exit(1);
  }
  try {
    await win.loadFile(page);
  } catch (err) {
    console.error(`  렌더러를 띄우지 못했습니다: ${err.message}`);
    process.exit(1);
  }
  await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,500))', true);

  const ready = await win.webContents.executeJavaScript(
    'document.querySelectorAll(".tree-row").length', true);
  console.log(`트리에 그려진 행: ${ready}개`);
  ok('트리가 그려짐', ready > 0, String(ready));

  if (ready > 0) {
    await scenario(win, '노트를 다른 폴더로 끌기', '루트노트.html', '폴더B', false, { allowed: true });
    await scenario(win, 'Ctrl 을 누른 채 끌기 (복사)', '루트노트.html', '폴더A', true, { allowed: true });
    await scenario(win, '폴더를 다른 폴더로 끌기', '폴더B', '폴더A', false, { allowed: true });
    await scenario(win, '폴더를 자기 하위로 끌기 (거부되어야 함)', '폴더A', '폴더A/하위', false, { allowed: false });
  }

  await templatePicker(win);

  await sourceTabReflectsEdits(win);

  await sourceEditsPersist(win);
  await emptyBlocksAreReachable(win);
  await makeTable(win);
  await darkBeatsNoteStylesheet(win);
  await tableEdgeHandles(win);
  await dragColumnWidth(win);
  await tableKeepsItsWidth(win);
  await arrowsFollowTheColumn(win);
  await tableEditingIsOptional(win);
  await pasteKeepsMeaningNotLooks(win);
  await undoWalksBackThroughPastes(win);
  await undoAfterTypingAndCopying(win);
  await blankLinesAreNotTheCellTop(win);
  await theTitleIsTheRowAbove(win);
  await f2RenamesWhateverIsSelected(win);
  await idleSpansLeaveTheFileNotTheEditor(win);
  await findInNote(win);
  await replaceInNote(win);
  await clickingAPictureSelectsIt(win);
  await printingReachesTheMainProcess(win);
  await darkNoteSurface(win);

  await statusBar(win);

  await searchPanel(win);

  await undoAMove(win);

  await settingsDialog(win);

  await formatPresets(win);

  await singleDelete(win);

  await folderDescription(win);

  await behaviourOptions(win);

  await dateStamp(win);

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  app.exit(failed === 0 ? 0 : 1);
});
