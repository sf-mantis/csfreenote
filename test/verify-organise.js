'use strict';

/**
 * Verification for moving, copying and image storage.
 *
 * Drives electron/notes.js — the module the IPC handlers call — against a
 * throwaway book, then inspects what landed on disk. Nothing outside the
 * scratch directory is touched.
 *
 * Usage: node test/verify-organise.js
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const noteIO = require('../electron/notes');

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

const NOTE = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>내용</p></body></html>';

/** Smallest valid PNG: a 1x1 transparent pixel, built rather than pasted in. */
function onePixelPng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function run() {
  const book = await fsp.mkdtemp(path.join(os.tmpdir(), 'csfreenote-org-'));
  console.log(`작업 폴더: ${book}\n`);

  await fsp.mkdir(path.join(book, '폴더A', '하위'), { recursive: true });
  await fsp.mkdir(path.join(book, '폴더B'), { recursive: true });
  await fsp.writeFile(path.join(book, '폴더A', '노트.html'), NOTE, 'utf8');
  await fsp.writeFile(path.join(book, '폴더B', '노트.html'), NOTE, 'utf8');
  await fsp.writeFile(path.join(book, '루트노트.html'), NOTE, 'utf8');

  console.log('■ 이동');
  let res = await noteIO.moveItem(book, { relativePath: '루트노트.html', targetFolder: '폴더A' });
  ok('노트를 폴더로 이동', res.ok && res.relativePath === '폴더A/루트노트.html', JSON.stringify(res));
  ok('원래 자리에서 사라짐', !fs.existsSync(path.join(book, '루트노트.html')));
  ok('새 자리에 있음', fs.existsSync(path.join(book, '폴더A', '루트노트.html')));

  res = await noteIO.moveItem(book, { relativePath: '폴더A/루트노트.html', targetFolder: '' });
  ok('루트로 되돌리기', res.ok && res.relativePath === '루트노트.html', JSON.stringify(res));

  console.log('\n■ 이름 충돌');
  res = await noteIO.moveItem(book, { relativePath: '폴더A/노트.html', targetFolder: '폴더B' });
  ok('충돌 시 덮어쓰지 않고 번호 부여',
    res.ok && res.relativePath === '폴더B/노트 (2).html', JSON.stringify(res));
  ok('기존 노트 그대로',
    (await fsp.readFile(path.join(book, '폴더B', '노트.html'), 'utf8')) === NOTE);

  console.log('\n■ 거부되어야 하는 이동');
  res = await noteIO.moveItem(book, { relativePath: '폴더A', targetFolder: '폴더A/하위' });
  ok('폴더를 자기 하위로 이동 거부', res.ok === false && res.reason === 'descendant', JSON.stringify(res));
  ok('거부 후 폴더 그대로', fs.existsSync(path.join(book, '폴더A', '하위')));

  res = await noteIO.moveItem(book, { relativePath: '폴더B/노트.html', targetFolder: '폴더B' });
  ok('같은 폴더로 이동은 무시', res.ok === false && res.reason === 'same', JSON.stringify(res));

  let escaped = false;
  try {
    await noteIO.moveItem(book, { relativePath: '../탈출.html', targetFolder: '' });
    escaped = true;
  } catch { /* expected */ }
  ok('책 폴더 밖 경로 차단', !escaped);

  console.log('\n■ 복사');
  res = await noteIO.moveItem(book, { relativePath: '폴더B/노트.html', targetFolder: '폴더A', copy: true });
  ok('노트 복사', res.ok && fs.existsSync(path.join(book, '폴더A', '노트.html')), JSON.stringify(res));
  ok('원본 남아 있음', fs.existsSync(path.join(book, '폴더B', '노트.html')));

  res = await noteIO.moveItem(book, { relativePath: '폴더A', targetFolder: '폴더B', copy: true });
  ok('폴더 통째 복사', res.ok && fs.existsSync(path.join(book, '폴더B', '폴더A', '노트.html')),
    JSON.stringify(res));

  console.log('\n■ 이미지');
  const png = onePixelPng();
  const saved = await noteIO.saveImage(book, {
    relativePath: '폴더A/노트.html', mimeType: 'image/png', data: png,
  });
  const assetPath = path.join(book, noteIO.ASSET_DIR, saved.fileName);
  ok('이미지가 파일로 저장됨', fs.existsSync(assetPath));
  ok('바이트 동일', (await fsp.readFile(assetPath)).equals(png));
  ok('href 가 상대경로', !path.isAbsolute(saved.href) && !saved.href.startsWith('blob:'),
    saved.href);

  // The note document carries <base> pointing at its own folder, so the href
  // must resolve from there.
  const resolved = path.resolve(path.join(book, '폴더A'), saved.href);
  ok('노트 폴더 기준으로 해석됨', path.resolve(assetPath) === resolved, `${saved.href} → ${resolved}`);

  const again = await noteIO.saveImage(book, {
    relativePath: '폴더B/노트.html', mimeType: 'image/png', data: png,
  });
  ok('같은 이미지는 파일 하나만',
    again.fileName === saved.fileName &&
    fs.readdirSync(path.join(book, noteIO.ASSET_DIR)).length === 1);

  // A note deeper in the tree needs a longer path back up to the store.
  await fsp.writeFile(path.join(book, '폴더A', '하위', '깊은노트.html'), NOTE, 'utf8');
  const deep = await noteIO.saveImage(book, {
    relativePath: '폴더A/하위/깊은노트.html', mimeType: 'image/png', data: png,
  });
  ok('깊이에 따라 상대경로가 달라짐', deep.href !== saved.href, `${saved.href} / ${deep.href}`);
  ok('깊은 노트에서도 해석됨',
    path.resolve(assetPath) === path.resolve(path.join(book, '폴더A', '하위'), deep.href),
    deep.href);

  let rejected = false;
  try {
    await noteIO.saveImage(book, {
      relativePath: '폴더A/노트.html', mimeType: 'application/x-msdownload', data: png,
    });
  } catch { rejected = true; }
  ok('이미지가 아닌 형식 거부', rejected);

  console.log('\n■ 이름 규칙');
  const accepted = ['정상 이름', '괄호(포함)', '점.중간.있음', '한글 English 123'];
  for (const name of accepted) {
    const r = noteIO.validateName(name);
    ok(`허용: ${name}`, r.ok === true, r.message);
  }
  const badNames = [
    ['빈 이름', '   '],
    ['끝에 점', '메모.'],
    ['예약어 CON', 'CON'],
    ['예약어 con.html', 'con.html'],
    ['예약어 COM1', 'COM1'],
    ['금지문자 /', '가/나'],
    ['금지문자 :', '가:나'],
    ['금지문자 ?', '가?나'],
    ['제어문자', `가${String.fromCharCode(1)}나`],
    ['너무 긴 이름', 'ㄱ'.repeat(200)],
  ];
  for (const [label, name] of badNames) {
    const r = noteIO.validateName(name);
    ok(`거부: ${label}`, r.ok === false && !!r.message, JSON.stringify(r));
  }

  // Trailing spaces are trimmed rather than rejected, and the trimmed name is
  // what gets returned — so what the app reports always matches the file.
  const trimmed = noteIO.validateName('메모 ');
  ok('끝 공백은 다듬어서 허용', trimmed.ok === true && trimmed.name === '메모',
    JSON.stringify(trimmed));

  console.log('\n■ 백업이 노트를 따라감');
  await fsp.mkdir(path.join(book, '보관'), { recursive: true });
  await fsp.writeFile(path.join(book, '보관', '따라올까.html'), NOTE, 'utf8');
  const bnote = await noteIO.readNote(book, '보관/따라올까.html');
  await noteIO.writeNote({
    bookDir: book, relativePath: '보관/따라올까.html',
    body: '<p>고침</p>', encoding: 'utf-8', baseMtime: bnote.mtime,
  });
  const bak = (rel) => fs.existsSync(noteIO.backupPath(book, rel));
  ok('편집하면 _backup 에 생김', bak('보관/따라올까.html'));

  await noteIO.relocateBackup(book, '보관/따라올까.html', '보관/새이름.html');
  ok('이름 변경을 따라감', bak('보관/새이름.html') && !bak('보관/따라올까.html'));

  await fsp.rename(path.join(book, '보관', '따라올까.html'), path.join(book, '보관', '새이름.html'));
  const moved = await noteIO.moveItem(book, { relativePath: '보관/새이름.html', targetFolder: '폴더B' });
  ok('이동을 따라감', moved.ok && bak('폴더B/새이름.html') && !bak('보관/새이름.html'),
    JSON.stringify(moved));

  await noteIO.dropBackup(book, '폴더B/새이름.html');
  ok('삭제하면 백업도 사라짐', !bak('폴더B/새이름.html'));
  ok('빈 백업 폴더는 정리됨', !fs.existsSync(path.join(book, noteIO.BACKUP_DIR, '보관')));


  console.log('\n■ 열린 노트 경로 추적');
  const remap = (cur, from, to) => noteIO.remapPath(cur, from, to);
  ok('노트 이름 변경을 따라감',
    remap('폴더/노트.html', '폴더/노트.html', '폴더/새이름.html') === '폴더/새이름.html');
  ok('상위 폴더 이름 변경을 따라감',
    remap('폴더/노트.html', '폴더', '새폴더') === '새폴더/노트.html');
  ok('상위 폴더 이동을 따라감',
    remap('폴더/노트.html', '폴더', '보관/폴더') === '보관/폴더/노트.html');
  ok('노트 삭제 시 비워짐', remap('폴더/노트.html', '폴더/노트.html', null) === '');
  ok('상위 폴더 삭제 시 비워짐', remap('폴더/하위/노트.html', '폴더', null) === '');
  ok('무관한 항목은 그대로', remap('폴더/노트.html', '다른폴더', null) === '폴더/노트.html');
  ok('이름이 접두사만 같으면 그대로',
    remap('폴더2/노트.html', '폴더', null) === '폴더2/노트.html');
  ok('빈 값은 안전하게 처리', remap('', '폴더', null) === '' && remap('a.html', '', null) === 'a.html');


  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  await fsp.rm(book, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
