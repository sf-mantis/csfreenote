'use strict';

/**
 * The Korean the user actually reads.
 *
 * A tooltip that still described a button's old behaviour survived several
 * rounds of changes, because nothing was looking at the words. This checks the
 * shipped notes, the window's own strings and the messages the code produces
 * for mixed terminology, spacing and typos.
 *
 * Usage: node test/verify-wording.js
 */

const fs = require('fs');
const path = require('path');

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

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Everything the user can read, gathered from where it actually lives. */
function userFacingText() {
  const sources = [];

  const shell = read('index.html');
  for (const m of shell.matchAll(/(?:title|placeholder)="([^"]*)"/g)) {
    sources.push({ where: 'index.html', text: m[1] });
  }
  for (const m of shell.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) {
    sources.push({ where: 'index.html', text: m[1].trim() });
  }

  for (const file of ['src/main.js', 'electron/main.js', 'electron/notes.js',
    'electron/config.js', 'electron/document.js']) {
    const code = read(file);
    // Strings and template literals, minus comment lines.
    const body = code.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    for (const m of body.matchAll(/'([^'\n]*[가-힣][^'\n]*)'|`([^`]*[가-힣][^`]*)`|"([^"\n]*[가-힣][^"\n]*)"/g)) {
      sources.push({ where: file, text: m[1] || m[2] || m[3] });
    }
  }

  for (const name of fs.readdirSync(path.join(ROOT, 'BookData', 'csFreeNote'))) {
    const rel = path.join('BookData', 'csFreeNote', name);
    // Tags come out with nothing in their place: <strong>X</strong>를 renders
    // as X를, and replacing them with a space would invent a gap that the
    // reader never sees — and fail the spacing check on it.
    const html = read(rel)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z]+;/gi, ' ');
    sources.push({ where: rel, text: html });
  }

  return sources;
}

function main() {
  const sources = userFacingText();
  const find = (needle) => sources.filter((s) => s.text.includes(needle));

  console.log('■ 용어 통일');
  // One thing, one name. The pairs are the ones that had drifted.
  const terms = [
    ['트리 감추기', '트리 숨기기'],
    ['글자 서식', '텍스트 서식'],
    ['보기 모드', '브라우즈 모드'],
    ['편집 모드', '에디트 모드'],
    ['노트 폴더', '데이터 폴더'],
  ];
  // The introduction sets the two names side by side on purpose — "보기 모드 —
  // 브라우즈 모드" — so a reader coming from another program recognises what
  // they are looking at. That is the one place the older name is meant to
  // appear, and it is written for readers, not used as our own term.
  const GLOSSARY = '2 간단한 사용법.html';
  for (const [keep, drop] of terms) {
    const hits = find(drop).filter((h) => !h.where.endsWith(GLOSSARY));
    ok(`'${drop}' 대신 '${keep}'`, hits.length === 0,
      hits.map((h) => h.where).join(', '));
  }

  console.log('\n■ 조사 띄어쓰기');
  // A particle is written against the word it belongs to, Latin or not.
  const spaced = [];
  for (const source of sources) {
    // The word must end in a letter or digit: a sentence-ending period
    // followed by 이 is the determiner "this", not a particle.
    for (const m of source.text.matchAll(/[A-Za-z0-9_.+…-]*[A-Za-z0-9] (는|은|가|이|를|을|로|으로|와|과)(?=\s|$|[.,)])/g)) {
      spaced.push(`${source.where}: ${m[0]}`);
    }
  }
  ok('영문 뒤 조사를 띄어 쓰지 않음', spaced.length === 0, spaced.join(' | '));

  console.log('\n■ 오타');
  const typos = [
    ['변견', '변경'], ['눌르면', '누르면'], ['됬', '됐'], ['웬만', '웬만'],
    ['갯수', '개수'], ['몇일', '며칠'], ['할수있', '할 수 있'],
    ['됩니당', '됩니다'], ['있읍니다', '있습니다'], ['왠지', '웬지'],
  ];
  const found = [];
  for (const [wrong] of typos) {
    for (const hit of find(wrong)) found.push(`${hit.where}: ${wrong}`);
  }
  ok('알려진 오타 없음', found.length === 0, found.join(' | '));

  console.log('\n■ 그 밖');
  ok('사전에 없는 조어를 쓰지 않음', find('노트장').length === 0,
    find('노트장').map((h) => h.where).join(', '));
  const modeLabels = read('index.html');
  ok('모드 버튼의 글자와 설명이 어긋나지 않음',
    /data-mode="browse" title="보기/.test(modeLabels)
    && /data-mode="edit" title="편집/.test(modeLabels)
    && /data-mode="source" title="소스/.test(modeLabels));

  console.log(`\n검사한 문구 ${sources.length}개`);
  console.log(`통과 ${passed} / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
