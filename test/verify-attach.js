'use strict';

/**
 * Files a note carries, and the links that point at them.
 *
 * The drawer is named after the note, which is what makes the list free of a
 * manifest — and also what makes it fragile in a way pasted images are not.
 * Moving a note changes how far `../` reaches; renaming it moves the drawer
 * itself, so the target of the link walks away even though the note has not
 * budged. Renaming used to be the safe operation. With attachments it is the
 * one that needs the most care, and the checks below are mostly about that.
 *
 * Usage: node test/verify-attach.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const attach = require('../electron/attach');
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

const book = () => fs.mkdtempSync(path.join(os.tmpdir(), 'csattach-'));
const hrefOf = (html) => (html.match(/href="([^"]*)"/) || [])[1];

function put(root, relative, body) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full,
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n${body}\n</body></html>`,
    'utf8');
}

/** A note with one file attached and a link to it already in the text. */
function withFile(root, noteRelative, fileName = '사양서.pdf') {
  put(root, noteRelative, '<p></p>');
  const dir = attach.attachDir(root, noteRelative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), 'bytes', 'utf8');
  const href = attach.hrefFor(noteRelative, fileName);
  put(root, noteRelative, `<p><a href="${href}">${fileName}</a></p>`);
  return href;
}

/** Does the note's own link still land on a file that is there? */
function reaches(root, noteRelative) {
  const html = fs.readFileSync(path.join(root, noteRelative), 'utf8');
  const href = decodeURIComponent(hrefOf(html) || '');
  if (!href) return false;
  return fs.existsSync(path.resolve(path.dirname(path.join(root, noteRelative)), href));
}

/** What the app does when a note or folder is renamed, in that order. */
async function rename(root, fromRelative, newBase) {
  const full = path.join(root, fromRelative);
  const dest = path.join(path.dirname(full), newBase);
  fs.renameSync(full, dest);
  const renamed = path.relative(root, dest).split(path.sep).join('/');
  await noteIO.relocateBackup(root, fromRelative, renamed);
  const relinked = await noteIO.relinkMoved(root, fromRelative, renamed);
  return { renamed, relinked };
}

async function main() {
  // --- where a drawer lives -------------------------------------------------
  ok('노트의 서랍', attach.attachRelative('폴더A/노트.html') === '_files/폴더A/노트');
  ok('뿌리 노트의 서랍', attach.attachRelative('노트.html') === '_files/노트');
  ok('확장자를 떼어 폴더처럼 읽히게',
    !attach.attachRelative('노트.html').includes('.html'));
  ok('폴더도 같은 규칙을 탄다 — 그래서 폴더 이름 변경이 된다',
    attach.attachRelative('묶음') === '_files/묶음');
  ok('.htm 도 같은 서랍', attach.attachRelative('노트.htm') === '_files/노트');

  // --- the href a note writes ----------------------------------------------
  ok('뿌리에서는 바로', decodeURIComponent(attach.hrefFor('노트.html', 'a.pdf'))
    === '_files/노트/a.pdf');
  ok('한 칸 아래에서는 올라가서', decodeURIComponent(attach.hrefFor('폴더A/노트.html', 'a.pdf'))
    === '../_files/폴더A/노트/a.pdf');
  ok('이름은 퍼센트 인코딩된다',
    attach.hrefFor('노트.html', '사양 서.pdf').includes('%20'));

  // --- names ---------------------------------------------------------------
  ok('공백과 하이픈은 이름의 일부다', attach.safeName('2026-09-08 측정.xlsx')
    === '2026-09-08 측정.xlsx');
  ok('윈도가 거부하는 글자는 바꾼다', attach.safeName('보고서<1>|2.pdf') === '보고서_1__2.pdf',
    attach.safeName('보고서<1>|2.pdf'));
  ok('이름은 경로가 아니다', attach.safeName('../../밖.pdf') === '밖.pdf');
  // path.basename 은 윈도에서 드라이브 표시를 떼어낸다. 이름에 : 를 쓸 수
  // 없으므로 잃을 것이 없고, 경로처럼 생긴 것이 이름으로 들어오는 길이 하나
  // 줄어든다.
  ok('드라이브 표시는 떼어낸다', attach.safeName('C:보고서.pdf') === '보고서.pdf',
    attach.safeName('C:보고서.pdf'));
  ok('빈 이름에도 무언가를 준다', attach.safeName('') === '파일');
  ok('그림 판별은 확장자로', attach.isImage('도면.PNG') && !attach.isImage('사양서.pdf'));

  {
    const root = book();
    const dir = path.join(root, 'x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '도면.png'), '1', 'utf8');
    ok('겹치는 이름은 번호를 받는다', attach.freeName(dir, '도면.png') === '도면 (2).png');
    ok('겹치지 않으면 그대로', attach.freeName(dir, '다른.png') === '다른.png');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // --- the one collision the naming leaves behind --------------------------
  {
    const root = book();
    put(root, '기록.html', '<p></p>');
    ok('혼자면 겹치지 않는다', attach.collides(root, '기록.html') === null);
    put(root, '기록.htm', '<p></p>');
    ok('.htm 짝을 찾아낸다', attach.collides(root, '기록.html') === '기록.htm');
    ok('반대쪽에서도', attach.collides(root, '기록.htm') === '기록.html');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // --- the list is the folder ----------------------------------------------
  {
    const root = book();
    put(root, '노트.html', '<p></p>');
    ok('서랍이 없으면 빈 목록', (await attach.listAttachments(root, '노트.html')).length === 0);

    const dir = attach.attachDir(root, '노트.html');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '나중.pdf'), '12345', 'utf8');
    fs.writeFileSync(path.join(dir, '가장.png'), '1', 'utf8');
    const files = await attach.listAttachments(root, '노트.html');
    ok('폴더 내용이 곧 목록', files.length === 2, JSON.stringify(files));
    ok('이름 순으로 나온다', files[0].name === '가장.png', files.map((f) => f.name).join());
    ok('크기를 함께 준다', files[1].bytes === 5, String(files[1].bytes));
    ok('그림인지 함께 준다', files[0].image === true && files[1].image === false);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // --- 링크가 살아남아야 하는 다섯 경우 --------------------------------------
  {
    const root = book();
    withFile(root, '노트.html');
    fs.mkdirSync(path.join(root, '하위'), { recursive: true });
    const m = await noteIO.moveItem(root, { relativePath: '노트.html', targetFolder: '하위' });
    ok('① 노트를 하위 폴더로 옮겨도 닿는다', reaches(root, m.relativePath));
    ok('서랍도 따라왔다', fs.existsSync(attach.attachDir(root, m.relativePath)));
    ok('옛 서랍은 남지 않았다', !fs.existsSync(path.join(root, '_files', '노트')));
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = book();
    withFile(root, '노트.html');
    const r = await rename(root, '노트.html', '새이름.html');
    ok('② 노트 이름을 바꿔도 닿는다', reaches(root, r.renamed));
    ok('이름 변경도 링크를 고쳐 쓴다', r.relinked === 1, String(r.relinked));
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = book();
    withFile(root, '묶음/노트.html');
    fs.mkdirSync(path.join(root, '새자리'), { recursive: true });
    const m = await noteIO.moveItem(root, { relativePath: '묶음', targetFolder: '새자리' });
    ok('③ 폴더를 옮겨도 닿는다', reaches(root, `${m.relativePath}/노트.html`));
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = book();
    withFile(root, '묶음/노트.html');
    const r = await rename(root, '묶음', '새묶음');
    ok('④ 폴더 이름을 바꿔도 닿는다', reaches(root, `${r.renamed}/노트.html`));
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = book();
    withFile(root, '노트.html');
    fs.mkdirSync(path.join(root, 'A/B'), { recursive: true });
    const m = await noteIO.moveItem(root, { relativePath: '노트.html', targetFolder: 'A/B' });
    const r = await rename(root, m.relativePath, '최종.html');
    ok('⑤ 옮긴 뒤 이름까지 바꿔도 닿는다', reaches(root, r.renamed));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 붙임과 그림이 같은 노트에 있으면 둘 다 맞아야 한다. 하나는 대상이 함께
  // 움직이고 하나는 제자리에 남으므로, 같은 계산으로는 둘 다 맞출 수 없다.
  {
    const root = book();
    put(root, '노트.html', '<p></p>');
    const image = await noteIO.saveImage(root, {
      relativePath: '노트.html',
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const dir = attach.attachDir(root, '노트.html');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '사양서.pdf'), 'bytes', 'utf8');
    put(root, '노트.html',
      `<p><img src="${image.href}"></p>`
      + `<p><a href="${attach.hrefFor('노트.html', '사양서.pdf')}">사양서</a></p>`);

    const r = await rename(root, '노트.html', '새이름.html');
    const html = fs.readFileSync(path.join(root, r.renamed), 'utf8');
    const src = decodeURIComponent((html.match(/src="([^"]*)"/) || [])[1] || '');
    const href = decodeURIComponent(hrefOf(html) || '');
    ok('이름 변경: 그림은 그대로 남는다', src === image.href, src);
    ok('이름 변경: 붙임은 새 서랍을 가리킨다', href === '_files/새이름/사양서.pdf', href);

    fs.mkdirSync(path.join(root, '하위'), { recursive: true });
    const m = await noteIO.moveItem(root, { relativePath: r.renamed, targetFolder: '하위' });
    const after = fs.readFileSync(path.join(root, m.relativePath), 'utf8');
    ok('이동: 그림은 한 칸 올라간다',
      decodeURIComponent((after.match(/src="([^"]*)"/) || [])[1] || '') === '../_images/'
        + path.basename(image.href), after.match(/src="([^"]*)"/)[1]);
    ok('이동: 붙임은 새 자리의 서랍을 가리킨다',
      decodeURIComponent(hrefOf(after) || '') === '../_files/하위/새이름/사양서.pdf',
      hrefOf(after));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 이미 서랍이 서 있는 이름으로 바꾸면 아무것도 옮기지 않는다. 두 노트의
  // 파일 뭉치를 조용히 합치는 것이 링크가 옛 자리를 가리키는 것보다 나쁘다.
  {
    const root = book();
    withFile(root, '노트.html', 'ㄱ.pdf');
    const other = attach.attachDir(root, '이미있음.html');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'ㄴ.pdf'), 'bytes', 'utf8');

    const r = await rename(root, '노트.html', '이미있음.html');
    const theirs = await attach.listAttachments(root, r.renamed);
    ok('남의 서랍에 합치지 않는다', theirs.length === 1 && theirs[0].name === 'ㄴ.pdf',
      theirs.map((f) => f.name).join());
    ok('내 서랍은 옛 자리에 남는다', fs.existsSync(path.join(root, '_files', '노트', 'ㄱ.pdf')));
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
