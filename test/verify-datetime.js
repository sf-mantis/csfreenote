'use strict';

/**
 * The date and time format used when stamping a note.
 *
 * Usage: node test/verify-datetime.js
 */

const path = require('path');
const { pathToFileURL } = require('url');

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

async function main() {
  const { formatDateTime, DEFAULT_FORMAT } = await import(
    pathToFileURL(path.join(__dirname, '..', 'src', 'datetime.mjs')).href
  );

  // 2026-08-28 09:05:07, a Friday
  const at = new Date(2026, 7, 28, 9, 5, 7);
  const pm = new Date(2026, 7, 28, 15, 5, 7);
  const f = (fmt, when = at) => formatDateTime(fmt, when);

  console.log('■ 토큰');
  ok('yyyy 연 네 자리', f('yyyy') === '2026', f('yyyy'));
  ok('yy 연 두 자리', f('yy') === '26', f('yy'));
  ok('mm 은 월', f('mm') === '08', f('mm'));
  ok('m 은 앞자리 없는 월', f('m') === '8', f('m'));
  ok('dd 일', f('dd') === '28', f('dd'));
  ok('hh 시', f('hh') === '09', f('hh'));
  ok('nn 은 분', f('nn') === '05', f('nn'));
  ok('ss 초', f('ss') === '07', f('ss'));
  ok('dddd 요일 전체', f('dddd') === '금요일', f('dddd'));
  ok('ddd 요일 한 글자', f('ddd') === '금', f('ddd'));
  ok('tt 오전', f('tt') === '오전', f('tt'));
  ok('tt 오후', f('tt', pm) === '오후', f('tt', pm));

  console.log('\n■ 형식 문자열');
  ok('기본 형식이 그대로 동작',
    f(DEFAULT_FORMAT) === '2026-08-28 09:05:07 금요일', f(DEFAULT_FORMAT));
  ok('실제 노트에 쓰이던 표기',
    f('yyyy-mm-dd hh:nn:ss') === '2026-08-28 09:05:07');
  ok('짧은 표기', f('mm/dd') === '08/28', f('mm/dd'));
  ok('한글이 섞인 형식',
    f('yyyy년 m월 d일 ddd요일') === '2026년 8월 28일 금요일',
    f('yyyy년 m월 d일 ddd요일'));

  console.log('\n■ 까다로운 경우');
  ok('yyyy 가 yy 두 번으로 읽히지 않음', f('yyyy') === '2026');
  ok('따옴표 안은 그대로', f('"mm"은 월 mm') === 'mm은 월 08', f('"mm"은 월 mm'));
  ok('모르는 글자는 그대로', f('[dd]') === '[28]', f('[dd]'));
  ok('빈 형식은 빈 문자열', f('') === '');
  ok('자정은 00 시', f('hh:nn', new Date(2026, 7, 28, 0, 0, 0)) === '00:00');
  ok('한 자리 달·일에 0 을 채움',
    formatDateTime('yyyy-mm-dd', new Date(2026, 0, 3)) === '2026-01-03',
    formatDateTime('yyyy-mm-dd', new Date(2026, 0, 3)));

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
