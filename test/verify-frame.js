'use strict';

/**
 * Editor round-trip verification, run inside Chromium.
 *
 * The iframe editor loads a note as a real document and hands back
 * `body.innerHTML` when saving. Chromium re-serialises what it parsed, so the
 * question this answers is: after a note has been through the parser and
 * designMode, does it still contain everything it contained before?
 *
 * Usage: npx electron test/verify-frame.js
 *        CSFREENOTE_CORPUS=<dir> npx electron test/verify-frame.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const doc = require('../electron/document');
const { decodeBuffer } = require('../electron/encoding');

const NOTE_EXT = /\.(htm|html)$/i;
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Corpora to scan. The committed fixtures always run; point
 * CSFREENOTE_CORPUS at a real note folder (path.delimiter separated) to also
 * run the suite over your own notes.
 */
function corpora() {
  const extra = (process.env.CSFREENOTE_CORPUS || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return [FIXTURES, path.join(__dirname, '..', 'BookData'), ...extra];
}

const HARNESS = `<!doctype html>
<meta charset="utf-8">
<title>frame round-trip</title>
<iframe id="f" sandbox="allow-same-origin" style="width:800px;height:600px"></iframe>
`;

function collect(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (NOTE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** Load a document into the frame exactly as the app does, then read it back. */
function roundTrip(win, html) {
  const script = `new Promise((resolve, reject) => {
    const f = document.getElementById('f');
    const onLoad = () => {
      f.removeEventListener('load', onLoad);
      try {
        const d = f.contentDocument;
        d.designMode = 'on';
        d.execCommand('styleWithCSS', false, 'false');
        d.designMode = 'off';
        resolve(d.body ? d.body.innerHTML : null);
      } catch (err) { reject(String(err)); }
    };
    f.addEventListener('load', onLoad);
    f.srcdoc = ${JSON.stringify(html)};
  })`;
  return win.webContents.executeJavaScript(script, true);
}

const KEYS = ['table', 'row', 'cell', 'image', 'anchor', 'font', 'span', 'listItem', 'heading', 'styleAttr', 'colorAttr'];

/**
 * The whole loop, once: open a real legacy note, type into it the way the
 * toolbar does, save it through the real write path, and read the file back.
 */
async function verifyEditAndSave(win) {
  const noteIO = require('../electron/notes');
  const source = path.join(__dirname, 'fixtures', 'messy-utf8.htm');
  if (!fs.existsSync(source)) {
    console.log('\n(편집·저장 검사 건너뜀: 원본 노트 없음)');
    return false;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'csfreenote-edit-'));
  const target = path.join(scratch, 'note.htm');
  fs.copyFileSync(source, target);

  const note = await noteIO.readNote(scratch, 'note.htm');
  const before = doc.documentStats(doc.extractBody(note.html));

  // Edit it the way the app does: designMode on, then toolbar commands.
  const edited = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const f = document.getElementById('f');
    const onLoad = () => {
      f.removeEventListener('load', onLoad);
      try {
        const d = f.contentDocument;
        d.designMode = 'on';
        d.execCommand('styleWithCSS', false, 'false');

        // caret at the end of the note, then type a paragraph
        const range = d.createRange();
        range.selectNodeContents(d.body);
        range.collapse(false);
        const sel = d.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        d.execCommand('insertHTML', false, '<p>편집 검증 문단</p>');

        // select that new text and bold it
        const last = d.body.lastElementChild;
        const r2 = d.createRange();
        r2.selectNodeContents(last);
        sel.removeAllRanges(); sel.addRange(r2);
        d.execCommand('bold');

        d.designMode = 'off';
        resolve(d.body.innerHTML);
      } catch (err) { reject(String(err)); }
    };
    f.addEventListener('load', onLoad);
    f.srcdoc = ${JSON.stringify('__HTML__')};
  })`.replace(JSON.stringify('__HTML__'), JSON.stringify(note.html)), true);

  const res = await noteIO.writeNote({
    bookDir: scratch,
    relativePath: 'note.htm',
    body: edited,
    encoding: note.encoding,
    baseMtime: note.mtime,
  });

  const reread = await noteIO.readNote(scratch, 'note.htm');
  const after = doc.documentStats(doc.extractBody(reread.html));

  const results = [
    ['저장 성공', res.ok === true, res.message || ''],
    ['가드 통과', res.reason !== 'loss', res.message || ''],
    ['입력한 문단이 파일에 있음', reread.html.includes('편집 검증 문단'), ''],
    ['굵게 서식이 적용됨', /<(b|strong)\b/i.test(doc.extractBody(reread.html)), ''],
    ['표 보존', after.table >= before.table, `${before.table} → ${after.table}`],
    ['style 속성 보존', after.styleAttr >= before.styleAttr, `${before.styleAttr} → ${after.styleAttr}`],
    ['글꼴 지정 보존', after.font >= before.font, `${before.font} → ${after.font}`],
    ['인코딩 유지', reread.encoding === note.encoding, `${note.encoding} → ${reread.encoding}`],
    ['<head> 보존',
      reread.html.slice(0, reread.html.search(/<body\b/i)) === note.html.slice(0, note.html.search(/<body\b/i)), ''],
    ['백업이 _backup/ 에 생성됨',
      fs.existsSync(path.join(scratch, noteIO.BACKUP_DIR, 'note.htm')), ''],
  ];

  console.log('\n편집 → 저장 → 재읽기 (다른 편집기가 만든 노트)');
  let failed = false;
  for (const [name, ok, detail] of results) {
    if (!ok) failed = true;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  return failed;
}

/**
 * The templates a new note is built from.
 *
 * An empty `<p></p>` has no height, so in designMode there is nothing to click
 * and the caret cannot be put there — the note ships with rows the user cannot
 * type into. And the spacing has to look like the notes they already have,
 * which sit at about 1.2; anything much taller reads as wrong.
 */
async function verifyTemplates(win) {
  const dir = path.join(__dirname, '..', 'csTemplate');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => NOTE_EXT.test(f)) : [];
  const results = [];

  for (const name of files) {
    const html = fs.readFileSync(path.join(dir, name), 'utf8');
    const probe = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const f = document.getElementById('f');
      const onLoad = () => {
        f.removeEventListener('load', onLoad);
        try {
          const d = f.contentDocument;
          d.designMode = 'on';
          const leaves = [...d.body.querySelectorAll('p, div, td')]
            .filter((el) => !el.querySelector('p, div, td, table'));
          const empty = leaves.filter((el) => !el.textContent.trim());
          const flat = empty
            .filter((el) => el.getBoundingClientRect().height === 0)
            .map((el) => el.tagName.toLowerCase());

          // A caret has to be able to land in the first empty block.
          let typed = null;
          if (empty.length) {
            const range = d.createRange();
            range.selectNodeContents(empty[0]);
            range.collapse(true);
            range.insertNode(d.createTextNode('가'));
            typed = empty[0].textContent;
          }

          const cs = getComputedStyle(d.body);
          resolve({
            empty: empty.length,
            flat,
            typed,
            fontSize: cs.fontSize,
            ratio: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
          });
        } catch (err) { reject(String(err)); }
      };
      f.addEventListener('load', onLoad);
      f.srcdoc = ${JSON.stringify(html)};
    })`);

    results.push([`${name} — 빈 칸에 커서 자리가 있다`,
      probe.flat.length === 0,
      probe.flat.length ? `높이 0인 칸 ${probe.flat.length}개: ${probe.flat.join(', ')}` : '']);
    if (probe.empty) {
      results.push([`${name} — 빈 칸에 글자가 들어간다`,
        probe.typed === '가', JSON.stringify(probe.typed)]);
    }
    results.push([`${name} — 줄간격이 옛 노트와 비슷하다`,
      probe.ratio <= 1.4,
      `${probe.fontSize} / 배율 ${probe.ratio.toFixed(2)}`]);
  }

  console.log('\n노트 양식');
  let failed = false;
  for (const [name, ok, detail] of results) {
    if (!ok) failed = true;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  }
  return failed;
}

async function main() {
  const harnessPath = path.join(os.tmpdir(), `csfreenote-frame-${process.pid}.html`);
  fs.writeFileSync(harnessPath, HARNESS, 'utf8');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await win.loadFile(harnessPath);

  const files = corpora().flatMap((root) => collect(root));
  console.log(`노트 ${files.length}개를 Chromium 왕복 검사합니다.\n`);

  let checked = 0;
  let textLoss = 0;
  let textGain = 0;
  let skipped = 0;
  let guardTripped = 0;
  const drift = Object.fromEntries(KEYS.map((k) => [k, { same: 0, changed: [], grew: [] }]));

  for (const file of files) {
    // A corpus may hold a file that is not UTF-8. The app refuses to open it,
    // so there is nothing to round-trip; skip it rather than stop here.
    let html;
    try {
      ({ html } = decodeBuffer(fs.readFileSync(file)));
    } catch (err) {
      if (err && err.code === 'NOT_UTF8') { skipped += 1; continue; }
      throw err;
    }
    if (!doc.hasBody(html)) continue;

    const before = doc.extractBody(html);
    let after;
    try {
      after = await roundTrip(win, html);
    } catch (err) {
      console.log(`  ERROR ${path.basename(file)} — ${err}`);
      continue;
    }
    if (after === null) continue;
    checked += 1;

    const a = doc.documentStats(before);
    const b = doc.documentStats(after);
    const name = path.basename(file);

    for (const key of KEYS) {
      // Losing a construct is a failure; gaining one is the parser reopening
      // an unclosed <font>/<b> in the next block, which renders identically.
      if (a[key] <= b[key]) drift[key].same += 1;
      else drift[key].changed.push(`${name}: ${a[key]} → ${b[key]}`);
      if (a[key] !== b[key]) drift[key].grew.push(`${name}: ${a[key]} → ${b[key]}`);
    }

    // Text must never shrink. It can grow: a raw '<' pasted inside code was
    // being swallowed as a bogus tag, and the parser escapes it back into
    // visible text — the note gains back something it was already hiding.
    if (b.textLength < a.textLength) {
      textLoss += 1;
      console.log(`  텍스트 손실  ${name}: ${a.textLength} → ${b.textLength}`);
    } else if (b.textLength > a.textLength) {
      textGain += 1;
      console.log(`  텍스트 복구  ${name}: ${a.textLength} → ${b.textLength} (깨진 마크업이 본문으로 살아남)`);
    }

    const verdict = doc.inspectWrite(before, after);
    if (!verdict.safe) {
      guardTripped += 1;
      console.log(`  가드 발동    ${name}: ${doc.describeReasons(verdict.reasons)}`);
    }
  }

  console.log(`\n검사한 노트: ${checked}개\n`);
  console.log('구조 보존 (손실 없음 / 전체)');
  for (const key of KEYS) {
    const d = drift[key];
    const mark = d.changed.length === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${key.padEnd(11)} ${d.same}/${checked}`);
    for (const line of d.changed.slice(0, 5)) console.log(`          손실 ${line}`);
    if (d.changed.length > 5) console.log(`          … 외 ${d.changed.length - 5}건`);
    if (d.grew.length) {
      console.log(`          (증가 ${d.grew.length}건 — 닫히지 않은 태그를 파서가 다시 열어줌)`);
      for (const line of d.grew.slice(0, 3)) console.log(`           ${line}`);
    }
  }

  console.log(`\n본문 텍스트 손실: ${textLoss}건`);
  console.log(`본문 텍스트 복구: ${textGain}건`);
  console.log(`저장 가드 발동:   ${guardTripped}건`);

  const structureLost = KEYS.some((k) => drift[k].changed.length > 0);
  const editFailed = await verifyEditAndSave(win);
  const templateFailed = await verifyTemplates(win);
  const failed = textLoss > 0 || guardTripped > 0 || structureLost
    || editFailed || templateFailed;
  console.log(failed ? '\n실패' : '\n통과');

  fs.unlinkSync(harnessPath);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
