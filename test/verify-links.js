'use strict';

/**
 * A note's links must mean the same thing after it moves.
 *
 * The bug: a note at the book root referenced a pasted image as
 * `_images/ab12.png`. Dragged into a subfolder it kept that text, which now
 * reads as `subfolder/_images/ab12.png` — nothing. The picture went blank
 * while the file sat where it always was.
 *
 * Two halves are checked. The arithmetic, in electron/links.js, with no disk
 * involved. Then the real move through electron/notes.js, on a throwaway book,
 * because the first bug was not in the arithmetic — it was that nobody did the
 * arithmetic at all.
 *
 * Usage: node test/verify-links.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const links = require('../electron/links');
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const book = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cslinks-'));

/** A note holding whatever body is given, shaped the way the app writes one. */
function put(root, relative, body) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full,
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n${body}\n</body></html>`,
    'utf8');
}

const srcOf = (html) => (html.match(/src="([^"]*)"/) || [])[1];

/** Does the note's own link still land on a file that exists? */
function reaches(root, relative, href) {
  return fs.existsSync(path.resolve(path.dirname(path.join(root, relative)), href));
}

async function main() {
  const { relink, rewriteLinks, isFixed } = links;

  // --- what must never be touched -------------------------------------------
  const fixed = [
    ['http', 'http://x.test/a.png'],
    ['https', 'https://x.test/a.png'],
    ['data', 'data:image/png;base64,AAAA'],
    ['file', 'file:///c:/a.png'],
    ['mailto', 'mailto:a@b.test'],
    ['조각', '#section'],
    ['뿌리 기준', '/a.png'],
    ['프로토콜 생략', '//x.test/a.png'],
    ['빈 값', ''],
  ];
  for (const [what, url] of fixed) {
    ok(`${what} 링크는 건드리지 않는다`, isFixed(url) === true, url);
  }

  // --- the arithmetic -------------------------------------------------------
  ok('뿌리에서 한 칸 아래로', relink('_images/a.png', '', '하위') === '../_images/a.png');
  ok('한 칸 아래에서 뿌리로', relink('../_images/a.png', '하위', '') === '_images/a.png');
  ok('두 칸 아래로', relink('_images/a.png', '', 'a/b') === '../../_images/a.png');
  ok('같은 깊이면 그대로', relink('../_images/a.png', 'a', 'b') === null);
  ok('책 밖을 가리키면 그대로', relink('../../밖.png', '', '하위') === null);
  ok('폴더가 그대로면 아무 일 없음',
    rewriteLinks('<img src="_images/a.png">', 'a', 'a') === '<img src="_images/a.png">');

  // 물음표 뒤와 조각은 경로가 아니므로 그대로 붙어 있어야 한다
  ok('질의와 조각은 그대로 붙어 온다',
    relink('_images/a.png?v=2#top', '', '하위') === '../_images/a.png?v=2#top');

  // 한글 이름은 퍼센트 인코딩으로 오는 경우가 있다. 풀어서 계산하고 다시 싸야 한다
  ok('인코딩된 한글 이름을 지킨다',
    relink('_images/%EA%B7%B8%EB%A6%BC.png', '', '하위')
      === '../_images/%EA%B7%B8%EB%A6%BC.png');
  ok('인코딩되지 않은 한글도 싸서 돌려준다',
    relink('_images/그림.png', '', '하위') === '../_images/%EA%B7%B8%EB%A6%BC.png');
  ok('망가진 인코딩은 손대지 않는다', relink('_images/%zz.png', '', '하위') === null);

  // --- the surgery ----------------------------------------------------------
  ok('태그 밖의 글은 마크업이 아니다',
    rewriteLinks('<p>src="a.png" 라고 적었다</p>', '', '하위')
      === '<p>src="a.png" 라고 적었다</p>');
  ok('style 블록은 건드리지 않는다',
    rewriteLinks('<style>p { background: url(_images/a.png); }</style>', '', '하위')
      === '<style>p { background: url(_images/a.png); }</style>');
  ok('base 태그는 건드리지 않는다',
    rewriteLinks('<base href="_images/">', '', '하위') === '<base href="_images/">');
  ok('홑따옴표도 고친다',
    rewriteLinks("<img src='_images/a.png'>", '', '하위') === "<img src='../_images/a.png'>");
  ok('a href 도 고친다',
    rewriteLinks('<a href="_images/a.pdf">붙임</a>', '', '하위')
      === '<a href="../_images/a.pdf">붙임</a>');

  // src 와 href 만 대상이다. 비슷하게 생긴 다른 속성은 링크가 아니다
  const two = rewriteLinks(
    '<img src="_images/a.png" data-src="_images/b.png" href="_images/c.png">', '', '하위');
  ok('src 와 href 만 고친다', two.split('../_images/').length - 1 === 2, two);

  // --- 실제로 옮겨 본다 -------------------------------------------------------
  {
    const root = book();
    put(root, '노트.html', '<p></p>');
    const saved = await noteIO.saveImage(root, {
      relativePath: '노트.html', mimeType: 'image/png', data: PNG,
    });
    put(root, '노트.html', `<p><img src="${saved.href}" alt=""></p>`);
    fs.mkdirSync(path.join(root, '하위'), { recursive: true });

    const moved = await noteIO.moveItem(root, { relativePath: '노트.html', targetFolder: '하위' });
    const href = srcOf((await noteIO.readNote(root, moved.relativePath)).html);
    ok('옮긴 노트의 그림이 살아 있다', reaches(root, moved.relativePath, href), href);
    ok('고친 노트 수를 알려준다', moved.relinked === 1, String(moved.relinked));

    const back = await noteIO.moveItem(root,
      { relativePath: moved.relativePath, targetFolder: '' });
    ok('되돌리면 원래 글자로 돌아온다',
      srcOf((await noteIO.readNote(root, back.relativePath)).html) === saved.href);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 폴더째 옮기면 그 안의 노트가 전부 따라 고쳐진다
  {
    const root = book();
    put(root, '묶음/얕은.html', '<p></p>');
    put(root, '묶음/안쪽/깊은.html', '<p></p>');
    const a = await noteIO.saveImage(root, {
      relativePath: '묶음/얕은.html', mimeType: 'image/png', data: PNG,
    });
    const b = await noteIO.saveImage(root, {
      relativePath: '묶음/안쪽/깊은.html', mimeType: 'image/png', data: Buffer.concat([PNG, PNG]),
    });
    put(root, '묶음/얕은.html', `<p><img src="${a.href}"></p>`);
    put(root, '묶음/안쪽/깊은.html', `<p><img src="${b.href}"></p>`);
    fs.mkdirSync(path.join(root, '새자리'), { recursive: true });

    const moved = await noteIO.moveItem(root, { relativePath: '묶음', targetFolder: '새자리' });
    ok('폴더 안 노트 둘이 다 고쳐졌다', moved.relinked === 2, String(moved.relinked));
    for (const rel of ['새자리/묶음/얕은.html', '새자리/묶음/안쪽/깊은.html']) {
      const href = srcOf((await noteIO.readNote(root, rel)).html);
      ok(`${rel.split('/').pop()} 의 그림이 살아 있다`, reaches(root, rel, href), href);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 복사본도 새 자리에서 맞아야 하고, 원본은 그대로여야 한다
  {
    const root = book();
    put(root, '노트.html', '<p></p>');
    const saved = await noteIO.saveImage(root, {
      relativePath: '노트.html', mimeType: 'image/png', data: PNG,
    });
    put(root, '노트.html', `<p><img src="${saved.href}"></p>`);
    fs.mkdirSync(path.join(root, '하위'), { recursive: true });

    const copied = await noteIO.moveItem(root,
      { relativePath: '노트.html', targetFolder: '하위', copy: true });
    const href = srcOf((await noteIO.readNote(root, copied.relativePath)).html);
    ok('복사본의 그림도 살아 있다', reaches(root, copied.relativePath, href), href);
    ok('원본은 그대로다',
      srcOf((await noteIO.readNote(root, '노트.html')).html) === saved.href);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 고칠 것이 없는 노트는 쓰지 않는다
  {
    const root = book();
    put(root, '맨노트.html', '<p>글만 있다</p>');
    fs.mkdirSync(path.join(root, '하위'), { recursive: true });
    const moved = await noteIO.moveItem(root,
      { relativePath: '맨노트.html', targetFolder: '하위' });
    ok('고칠 것이 없으면 쓰지 않는다', moved.relinked === 0, String(moved.relinked));
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
