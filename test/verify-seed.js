'use strict';

/**
 * What an update is allowed to put back.
 *
 * A new template shipped with an update has to reach an install that already
 * exists — the folder is created once and was never looked at again, so the
 * calendar template arrived for nobody. But the same folder holds whatever the
 * reader has put there or changed, and the notes folder holds their work.
 *
 * So the rule is the narrowest one that still lets a new file arrive: write
 * what is missing, touch nothing else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { topUpFiles } = require('../electron/seed');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function main() {
  console.log('■ 업데이트가 채우는 것');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csfreenote-seed-'));
  const seed = path.join(root, 'seed');
  const target = path.join(root, 'target');
  fs.mkdirSync(seed);
  fs.mkdirSync(target);

  fs.writeFileSync(path.join(seed, '기본 양식.html'), '<p>새로 온 기본</p>', 'utf8');
  fs.writeFileSync(path.join(seed, '노트 양식.html'), '<p>새로 온 노트</p>', 'utf8');
  fs.writeFileSync(path.join(seed, '달력 양식.html'), '<p>달력</p>', 'utf8');

  // Already there: one the reader changed, and one of their own.
  fs.writeFileSync(path.join(target, '기본 양식.html'), '<p>내가 고친 기본</p>', 'utf8');
  fs.writeFileSync(path.join(target, '내 양식.html'), '<p>내 것</p>', 'utf8');

  const added = topUpFiles(seed, target);

  ok('새 양식이 들어옴', added.includes('달력 양식.html'), added.join(', '));
  ok('노트 양식도 없었으므로 들어옴', added.includes('노트 양식.html'), added.join(', '));
  ok('고쳐 쓰던 양식은 그대로',
    fs.readFileSync(path.join(target, '기본 양식.html'), 'utf8') === '<p>내가 고친 기본</p>');
  ok('직접 만든 양식은 건드리지 않음',
    fs.readFileSync(path.join(target, '내 양식.html'), 'utf8') === '<p>내 것</p>');
  ok('덮어쓴 것이 없음', !added.includes('기본 양식.html'), added.join(', '));

  // Run it again: nothing left to do.
  ok('두 번째에는 채울 것이 없음', topUpFiles(seed, target).length === 0);

  // A file the reader deleted comes back — the price of this rule, and the
  // reason notes are never topped up.
  fs.unlinkSync(path.join(target, '달력 양식.html'));
  ok('지운 양식은 다시 생긴다 (양식에 한해 받아들인 값)',
    topUpFiles(seed, target).includes('달력 양식.html'));

  console.log('');
  console.log('■ 없는 폴더');
  ok('씨앗이 없으면 아무 일도 없음', topUpFiles(path.join(root, '없음'), target).length === 0);
  ok('대상이 없으면 아무 일도 없음', topUpFiles(seed, path.join(root, '없음')).length === 0);
  ok('대상 폴더를 만들지는 않음', !fs.existsSync(path.join(root, '없음')));

  fs.rmSync(root, { recursive: true, force: true });

  console.log('');
  console.log(failed ? `통과 ${passed} / 실패 ${failed}` : `통과 ${passed} / 실패 0`);
  if (failed) process.exit(1);
}

main();
