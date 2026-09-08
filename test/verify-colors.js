'use strict';

/**
 * The dark-note colour mapping, checked on its own.
 *
 * Usage: node test/verify-colors.js
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
  const mod = await import(
    pathToFileURL(path.join(__dirname, '..', 'src', 'dark-note.mjs')).href
  );
  const { parseColor, rgbToHsl, darkenBackground, lightenForeground, darkNoteCss } = mod;

  console.log('■ 색 해석');
  ok('#rgb 축약형', JSON.stringify(parseColor('#f0a')) === '[255,0,170]');
  ok('#rrggbb', JSON.stringify(parseColor('#3C62C6')) === '[60,98,198]');
  ok('rgb()', JSON.stringify(parseColor('rgb(1, 2, 3)')) === '[1,2,3]');
  ok('색 이름', JSON.stringify(parseColor('white')) === '[255,255,255]');
  ok('잘못된 값은 null', parseColor('nonsense') === null && parseColor('') === null);

  console.log('\n■ 배경 매핑');
  ok('표 머리 #3c62c6 → #1f2a47', darkenBackground('#3c62c6') === '#1f2a47',
    darkenBackground('#3c62c6'));
  ok('흰 배경은 거의 검정', darkenBackground('#ffffff') === '#1a1a1a');
  ok('검정 배경은 검정 유지', darkenBackground('#000000') === '#000000');
  for (const c of ['#3c62c6', '#f4f4ec', '#ffcfbf', '#800000']) {
    const [h] = rgbToHsl(parseColor(c));
    const [h2] = rgbToHsl(parseColor(darkenBackground(c)));
    ok(`${c} 색상(hue) 유지`, Math.abs(h - h2) < 0.02, `${h.toFixed(3)} → ${h2.toFixed(3)}`);
  }
  for (const c of ['#3c62c6', '#ffffff', '#f4f4ec', '#ffcfbf']) {
    const [, , l] = rgbToHsl(parseColor(darkenBackground(c)));
    ok(`${c} 배경이 충분히 어두움`, l <= 0.32, l.toFixed(3));
  }

  console.log('\n■ 글자 매핑');
  ok('흰 글씨는 밝게 유지', lightenForeground('#ffffff') === '#ebebeb');
  ok('검은 글씨는 밝아짐', lightenForeground('#000000') === '#f2f2f2');
  for (const c of ['#4070aa', '#800000', '#3c62c6']) {
    const [, , l] = rgbToHsl(parseColor(lightenForeground(c)));
    ok(`${c} 글자가 충분히 밝음`, l >= 0.6, l.toFixed(3));
    const [h] = rgbToHsl(parseColor(c));
    const [h2] = rgbToHsl(parseColor(lightenForeground(c)));
    ok(`${c} 글자 색상(hue) 유지`, Math.abs(h - h2) < 0.02);
  }

  console.log('\n■ 규칙 생성');
  const note = '<html><body><table bgcolor="#3c62c6"><tr bgcolor="#FFFFFF"><td>'
    + '<font color="#ffffff">머리</font>'
    + '<p style="color: #4070aa; background-color:#f4f4ec">본문</p>'
    + '</td></tr></table></body></html>';
  const css = darkNoteCss(note);
  ok('bgcolor 규칙 생성', css.includes('[bgcolor="#3c62c6" i]') && css.includes('#1f2a47'));
  ok('대소문자 다른 같은 색도 각각 처리',
    css.includes('[bgcolor="#FFFFFF" i]'), css);
  ok('color 속성 규칙 생성', css.includes('[color="#ffffff" i]'));
  ok('인라인 배경 규칙 생성', css.includes('#f4f4ec'));
  ok('인라인 글자색 규칙 생성', css.includes('#4070aa'));
  ok('본문 기본 배경 규칙', css.includes(':root, body'));
  ok('규칙에 중복 없음', new Set(css.split('\n')).size === css.split('\n').length);

  const empty = darkNoteCss('<html><body><p>색 없음</p></body></html>');
  ok('색이 없는 노트도 기본 규칙은 생성', empty.includes(':root, body'));
  ok('색이 없으면 속성 규칙은 없음', !empty.includes('[bgcolor'));

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
