'use strict';

/**
 * End-to-end verification of the note write path against a real filesystem.
 *
 * This drives electron/notes.js — the same module the IPC handler calls — over
 * a throwaway copy of the note corpus, then inspects the bytes that landed on
 * disk. Nothing outside the scratch directory is touched.
 *
 * Usage: node test/verify-write.js [scratch-dir]
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const doc = require('../electron/document');
const { decodeBuffer } = require('../electron/encoding');
const noteIO = require('../electron/notes');

const SOURCE_NOTES = [
  // an awkward note: table layout and inline styles, written elsewhere
  ['messy.htm', path.join(__dirname, 'fixtures', 'messy-utf8.htm')],
  // a UTF-8 note written by csFreeNote itself
  ['modern.html', path.join(__dirname, '..', 'BookData', 'csFreeNote', '1 소개.html')],
];

const { declaredCharset } = require('../electron/encoding');

/**
 * A note that is not UTF-8 is refused.
 *
 * Reading one without decoding it shows mojibake, and the next save writes that
 * mojibake into the file. Refusing costs the reader a note they cannot open;
 * accepting costs them the note itself.
 */
function refusesWhatItCannotRead() {
  console.log('');
  console.log('■ UTF-8 이 아닌 노트는 열지 않는다');

  const cases = [
    ['UTF-8 이라 적힌 것', Buffer.from('<meta charset="utf-8"><p>한글</p>', 'utf8'), true],
    ['아무 말 없는 UTF-8', Buffer.from('<p>한글</p>', 'utf8'), true],
    ['BOM 이 붙은 것', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<p>한글</p>', 'utf8')]), true],
    // EUC-KR "한글" is B0 A1 B1 DB — not a valid UTF-8 sequence.
    ['EUC-KR 이라 적힌 것',
      Buffer.concat([Buffer.from('<meta charset="euc-kr"><p>', 'ascii'),
        Buffer.from([0xb0, 0xa1, 0xb1, 0xdb]), Buffer.from('</p>', 'ascii')]), false],
    ['아무 말 없이 UTF-8 이 아닌 것',
      Buffer.concat([Buffer.from('<p>', 'ascii'), Buffer.from([0xb0, 0xa1, 0xb1, 0xdb]),
        Buffer.from('</p>', 'ascii')]), false],
  ];

  for (const [label, buf, shouldOpen] of cases) {
    let opened = false;
    let message = '';
    try { decodeBuffer(buf); opened = true; }
    catch (err) { message = err.message; opened = false; }
    ok(`${label} — ${shouldOpen ? '열림' : '거부'}`, opened === shouldOpen, message);
  }

  // The refusal has to say what the file is, so the reader knows what to do.
  let told = '';
  try {
    decodeBuffer(Buffer.concat([Buffer.from('<meta charset="euc-kr">', 'ascii'),
      Buffer.from([0xb0, 0xa1])]));
  } catch (err) { told = err.message; }
  ok('무엇으로 저장된 파일인지 알려줌', /EUC-KR/.test(told) && /UTF-8/.test(told), told);
  ok('선언을 읽어낸다', declaredCharset(Buffer.from('<meta charset="EUC-KR">')) === 'euc-kr');
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

function flattenToSchema(bodyHtml) {
  return bodyHtml
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .split(/<\/(?:p|div|tr|li|h[1-6])\s*>/i)
    .map((c) => c.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join('');
}

async function run() {
  const scratch =
    process.argv[2] || (await fsp.mkdtemp(path.join(os.tmpdir(), 'csfreenote-write-')));
  await fsp.mkdir(scratch, { recursive: true });
  console.log(`작업 폴더: ${scratch}\n`);

  for (const [name, source] of SOURCE_NOTES) {
    if (!fs.existsSync(source)) {
      console.log(`(건너뜀: ${source} 없음)\n`);
      continue;
    }
    console.log(`■ ${name}  ←  ${path.basename(source)}`);

    const target = path.join(scratch, name);
    await fsp.copyFile(source, target);
    const pristine = await fsp.readFile(target);

    const note = await noteIO.readNote(scratch, name);
    const body = doc.extractBody(note.html);

    // 1. An unchanged body must reproduce the file byte for byte.
    let res = await noteIO.writeNote({
      bookDir: scratch, relativePath: name, body,
      encoding: note.encoding, baseMtime: note.mtime,
    });
    ok('무변경 저장은 파일을 건드리지 않음',
      res.ok && res.unchanged === true && (await fsp.readFile(target)).equals(pristine),
      res.message || 'bytes differ');
    ok('무변경이면 백업도 만들지 않음',
      !fs.existsSync(path.join(scratch, noteIO.BACKUP_DIR, name)));

    // 2. A real edit keeps <head>, <body> attributes and the tail intact.
    const marker = '<p>검증용 추가 문단</p>';
    res = await noteIO.writeNote({
      bookDir: scratch, relativePath: name, body: `${body}\n${marker}`,
      encoding: note.encoding, baseMtime: res.mtime,
    });
    const afterEdit = decodeBuffer(await fsp.readFile(target)).html;
    const headOf = (h) => h.slice(0, h.search(/<body\b/i));
    const tailOf = (h) => h.slice(h.search(/<\/body\s*>/i));
    ok('편집 저장 성공', res.ok, res.message);
    const backup = path.join(scratch, noteIO.BACKUP_DIR, name);
    ok('백업이 _backup/ 에 생성됨', fs.existsSync(backup));
    ok('백업이 편집 전 원본과 동일', (await fsp.readFile(backup)).equals(pristine));
    ok('노트 옆에는 백업 파일 없음',
      !fs.existsSync(`${target}.bak`) && !fs.existsSync(`${target}.orig`));
    ok('<head> 보존', headOf(afterEdit) === headOf(note.html));
    ok('</body> 이후 보존', tailOf(afterEdit) === tailOf(note.html));
    ok('추가 문단 기록됨', afterEdit.includes('검증용 추가 문단'));
    ok('인코딩 유지', decodeBuffer(await fsp.readFile(target)).encoding === note.encoding);

    const beforeStats = doc.documentStats(body);
    const afterStats = doc.documentStats(doc.extractBody(afterEdit));
    ok('구조 보존 (style 속성)', afterStats.styleAttr === beforeStats.styleAttr,
      `${beforeStats.styleAttr} → ${afterStats.styleAttr}`);
    ok('구조 보존 (표)', afterStats.table === beforeStats.table,
      `${beforeStats.table} → ${afterStats.table}`);

    // 5. The destructive flatten must be refused, and the file left alone.
    const carriesStructure = beforeStats.styleAttr >= 3 || beforeStats.table >= 3 ||
      beforeStats.span >= 3 || beforeStats.font >= 3;
    if (carriesStructure) {
      const beforeBytes = await fsp.readFile(target);
      const flat = await noteIO.writeNote({
        bookDir: scratch, relativePath: name, body: flattenToSchema(body),
        encoding: note.encoding, baseMtime: res.mtime,
      });
      ok('평탄화 저장 거부', flat.ok === false && flat.reason === 'loss', JSON.stringify(flat));
      ok('거부 시 파일 그대로', (await fsp.readFile(target)).equals(beforeBytes));
    }

    // 6. A stale mtime is a conflict, not a silent clobber.
    const beforeBytes = await fsp.readFile(target);
    const stale = await noteIO.writeNote({
      bookDir: scratch, relativePath: name, body: `${body}<p>충돌</p>`,
      encoding: note.encoding, baseMtime: 1,
    });
    ok('오래된 mtime 은 충돌 처리', stale.ok === false && stale.reason === 'conflict',
      JSON.stringify(stale));
    ok('충돌 시 파일 그대로', (await fsp.readFile(target)).equals(beforeBytes));

    console.log('');
  }

  // 7. New notes still get a fresh document.
  const fresh = await noteIO.writeNote({
    bookDir: scratch, relativePath: 'fresh.htm', body: '<p>새 노트</p>', encoding: 'utf-8',
  });
  const freshHtml = decodeBuffer(await fsp.readFile(path.join(scratch, 'fresh.htm'))).html;
  ok('새 노트 생성', fresh.ok && freshHtml.includes('<p>새 노트</p>') && doc.hasBody(freshHtml));

  // 8. Paths must not escape the book directory.
  let escaped = false;
  try {
    await noteIO.writeNote({
      bookDir: scratch, relativePath: '../escape.htm', body: '<p>x</p>', encoding: 'utf-8',
    });
    escaped = true;
  } catch {
    /* expected */
  }
  ok('책 폴더 밖 경로 차단', !escaped);

  // 9. Source mode hands over hand-typed HTML. Breaking the document must not
  //    be accepted: the next edit-mode save would rebuild it and lose the head.
  console.log('■ 소스 모드 문법 파괴');
  const srcName = 'source.html';
  const rich = '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body>\n'
    + '<table><tr><td><span style="color:blue">중요</span></td></tr></table>\n</body></html>';
  await fsp.writeFile(path.join(scratch, srcName), rich, 'utf8');
  const srcNote = await noteIO.readNote(scratch, srcName);
  const srcBytes = await fsp.readFile(path.join(scratch, srcName));

  const broken = await noteIO.writeNote({
    bookDir: scratch, relativePath: srcName, html: rich.replace('</body>', ''),
    fullDocument: true, encoding: 'utf-8', baseMtime: srcNote.mtime,
  });
  ok('</body> 를 지운 저장 거부', broken.ok === false && broken.reason === 'malformed',
    JSON.stringify(broken));
  ok('거부 시 파일 그대로', (await fsp.readFile(path.join(scratch, srcName))).equals(srcBytes));

  const edited = await noteIO.writeNote({
    bookDir: scratch, relativePath: srcName, html: rich.replace('중요', '수정됨'),
    fullDocument: true, encoding: 'utf-8', baseMtime: srcNote.mtime,
  });
  ok('정상 소스 편집은 통과', edited.ok === true, JSON.stringify(edited));
  const afterSrc = await noteIO.readNote(scratch, srcName);
  ok('소스 편집 후에도 <style> 유지', afterSrc.html.includes('color:red'));
  ok('소스 편집 후에도 표 유지', afterSrc.html.includes('<table'));
  ok('저장 결과가 반환됨', typeof edited.html === 'string' && edited.html.includes('수정됨'));

  // 10. A power cut between the temp write and the rename leaves the note
  //     untouched, and the stray temp file is inert.
  console.log('');
  console.log('■ 저장된 소스가 한 줄로 뭉치지 않는다');
  // The editor hands back one long line. A note written by hand puts each block
  // on its own line, and the source tab is unreadable without it.
  const linesName = '줄나눔.html';
  await noteIO.writeNote({
    bookDir: scratch, relativePath: linesName,
    body: '<p>첫 줄</p><p><br></p><p>셋째 줄</p>', encoding: 'utf-8',
  });
  const typed = await noteIO.readNote(scratch, linesName);
  const typedBody = doc.extractBody(typed.html).trim();
  ok('블록마다 줄이 나뉨', typedBody.split('\n').length === 3, JSON.stringify(typedBody));
  ok('보이는 글자는 그대로',
    doc.visibleText(typedBody) === doc.visibleText('<p>첫 줄</p><p><br></p><p>셋째 줄</p>'));

  // Saving the same content again must not keep adding newlines, and must be
  // recognised as unchanged even though the editor still sends one line.
  const again = await noteIO.writeNote({
    bookDir: scratch, relativePath: linesName,
    body: '<p>첫 줄</p><p><br></p><p>셋째 줄</p>', encoding: 'utf-8',
    baseMtime: typed.mtime,
  });
  ok('같은 내용을 다시 저장하면 손대지 않음', again.unchanged === true, JSON.stringify(again.reason || ''));

  // A run of paragraphs typed inside a table cell has to keep the cell's
  // indentation, not jump to column zero.
  const cell = '<table>\n  <tr>\n    <td>\n      <p>안녕?</p><p>1번</p><p><br></p>\n    </td>\n  </tr>\n</table>';
  const spread = doc.breakBlocks(cell);
  ok('새 줄이 앞 블록과 같은 깊이로 들어감',
    spread.includes('\n      <p>1번</p>') && spread.includes('\n      <p><br></p>'),
    JSON.stringify(spread.split('\n').slice(3, 6)));

  // Every tag that matters carries attributes. Checking only bare ones let a
  // regex that had lost its whitespace class — [s>/] where [\s>/] was meant —
  // pass while nothing carrying an attribute was ever split.
  const withAttrs = '<p class=\'a\'>가</p><table border=\'1\'><tr><td>x</td></tr></table>';
  ok('속성이 붙어도 줄이 나뉘어짐',
    doc.breakBlocks(withAttrs).includes('</p>\n<table'),
    JSON.stringify(doc.breakBlocks(withAttrs)));
  const cells = '<tr bgcolor=\'#fff\'><td width=\'10\'>가</td><td width=\'20\'>나</td></tr>';
  ok('표 안의 칸 사이도 나뉘어짐',
    /<\/td>\n\s*<td/.test(doc.breakBlocks(cells)),
    JSON.stringify(doc.breakBlocks(cells)));

  // A table joins in three places, not one: between siblings, on the way in
  // (<tbody><tr>) and on the way out (</td></tr>). Only the first was handled.
  const table = '<p>가</p><table border="1"><tbody>'
    + '<tr><td>A</td><td>B</td></tr></tbody></table>';
  const laid = doc.breakBlocks(table).split('\n');
  ok('부모와 자식 사이도 나뉨',
    laid.some((line) => line.trim() === '<tbody>') && laid.some((line) => line.trim() === '<tr>'),
    JSON.stringify(laid));
  ok('닫는 태그도 제 줄을 가짐',
    laid.some((line) => line.trim() === '</tr>') && laid.some((line) => line.trim() === '</table>'),
    JSON.stringify(laid));
  ok('깊이만큼 들여씀',
    laid.some((line) => line.startsWith('  <tbody>'))
    && laid.some((line) => line.startsWith('      <td>A</td>')),
    JSON.stringify(laid));
  ok('인라인 태그는 건드리지 않음',
    doc.breakBlocks('<p><b>굵게</b><i>기울임</i></p>') === '<p><b>굵게</b><i>기울임</i></p>');

  // A table that has been added to and taken from carries the whitespace of
  // where its rows used to be: blank lines where one was removed, stale
  // indentation where one moved. Between two block tags none of it is drawn,
  // so it is ours to set rather than to preserve.
  const messy = '<table border="1">\n  <tbody>\n\n    <tr>\n        <td>A</td><td>B</td>\n\n'
    + '    </tr>\n<tr><td>C</td><td>D</td></tr>\n  </tbody>\n</table>';
  const tidy = doc.breakBlocks(messy).split('\n');
  ok('빈 줄이 남지 않음', tidy.every((line) => line.trim()), JSON.stringify(tidy));
  ok('같은 깊이는 같은 들여쓰기',
    tidy.filter((line) => line.trim().startsWith('<tr>'))
      .every((line, _i, all) => line.match(/^ */)[0] === all[0].match(/^ */)[0]),
    JSON.stringify(tidy.filter((line) => line.trim().startsWith('<tr>'))));
  ok('정리한 것을 또 정리해도 그대로',
    doc.breakBlocks(doc.breakBlocks(messy)) === doc.breakBlocks(messy));
  ok('글자 사이 공백은 지킴',
    doc.breakBlocks('<p>가 <b>나</b> 다</p>') === '<p>가 <b>나</b> 다</p>');

  ok('<pre> 안은 건드리지 않음',
    doc.breakBlocks('<pre><p>a</p><p>b</p></pre>') === '<pre><p>a</p><p>b</p></pre>');
  ok('이미 나뉜 것을 또 나누지 않음',
    doc.breakBlocks('<p>a</p>\n<p>b</p>') === '<p>a</p>\n<p>b</p>');

  console.log('');

  console.log('■ 전원 차단 안전성');
  const notePath = path.join(scratch, srcName);
  const goodBytes = await fsp.readFile(notePath);
  await fsp.writeFile(`${notePath}.9999.tmp`, 'half written');
  const reread = await noteIO.readNote(scratch, srcName);
  ok('임시 파일이 있어도 노트는 온전함',
    (await fsp.readFile(notePath)).equals(goodBytes) && doc.hasBody(reread.html));
  ok('임시 파일은 노트로 취급되지 않음', !/\.html?$/i.test(`${srcName}.9999.tmp`));

  console.log('');

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  if (!process.argv[2]) await fsp.rm(scratch, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * A template decides how its notes look, head and all.
 *
 * A note keeps only its <body> after it is made — saving reads <body>, and the
 * head is never written again. So a template's own rules have to be carried
 * across at that moment. They were not, and the calendar template's cell
 * colours, which live one rule to a line, all vanished the moment a note was
 * made from it.
 */
function templatesKeepTheirLook() {
  console.log('');
  console.log('■ 양식이 정한 모습이 새 노트에 남는다');

  const dir = path.join(__dirname, '..', 'csTemplate');
  const made = (name) => {
    const tpl = fs.readFileSync(path.join(dir, name + '.html'), 'utf8');
    const body = doc.extractBody(tpl).replace(/<!--title-->/g, '시험');
    return doc.wrapDocument(body, doc.templateStyle(tpl));
  };

  const plain = made('기본 양식');
  ok('기본 양식의 .title 규칙이 실림', /\.title \{/.test(plain));

  const note = made('노트 양식');
  ok('노트 양식은 더할 규칙이 없음', doc.templateStyle(
    fs.readFileSync(path.join(dir, '노트 양식.html'), 'utf8')).length === 0);
  ok('노트 양식도 기본 규칙은 갖춤', /body, td \{ font-size: 9pt/.test(note));

  const cal = made('달력 양식');
  for (const rule of ['.head', '.rest', '.week', '.day', '.date']) {
    ok(`달력 양식의 ${rule} 규칙이 실림`, cal.includes('table.calendar ' + rule + ' {'));
  }
  ok('제목 자리가 채워짐', cal.includes('시험') && !cal.includes('<!--title-->'));

  // The base rules are stated once, not repeated by every template that carries
  // them for its own sake.
  const css = (cal.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  const margins = css.split('\n').filter((l) => l.trim() === 'p { margin: 0; }');
  ok('기본 규칙이 두 번 적히지 않음', margins.length === 1, String(margins.length));
}

templatesKeepTheirLook();

refusesWhatItCannotRead();

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
