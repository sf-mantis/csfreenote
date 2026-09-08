'use strict';

/**
 * What the installer and uninstaller do to a real machine.
 *
 * csFreeNote keeps notes beside the executable, which means the default
 * uninstaller would delete them along with the program. This installs for
 * real, puts a note in, and checks both ways out: the plain uninstall has to
 * leave the notes behind, and the one that was asked to remove them has to
 * remove them.
 *
 * Usage: node test/verify-installer.js
 *
 * Installs to %LOCALAPPDATA%\Programs\csFreeNote and removes itself again.
 * Nothing else on the machine is touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

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
// Read from package.json rather than written out: the file is named after
// the version, and a check that has to be edited to bump it will be the
// thing that breaks on the release.
const SETUP_NAME = `csFreeNote-${require('../package.json').version}-setup.exe`;
const SETUP = path.join(ROOT, 'release', SETUP_NAME);
const APP = path.join(process.env.LOCALAPPDATA, 'Programs', 'csFreeNote');
const UNINSTALL = path.join(APP, 'Uninstall csFreeNote.exe');

// Synchronous and cheap. Spawning a shell for each wait made the polling
// loops cost more than the thing being waited for.
const sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function killApp() {
  for (let i = 0; i < 20; i += 1) {
    const listed = spawnSync('tasklist', [], { encoding: 'utf8' }).stdout || '';
    if (!/csFreeNote\.exe/i.test(listed)) return;
    spawnSync('taskkill', ['/IM', 'csFreeNote.exe', '/F'], { stdio: 'ignore' });
    sleep(200);
  }
}

const uninstallerRunning = () => /Un_A\.exe|Uninstall csFreeNote/i
  .test(spawnSync('tasklist', [], { encoding: 'utf8' }).stdout || '');

/**
 * Wait for an uninstall to finish.
 *
 * The uninstaller relaunches itself from a temp copy and the command returns
 * at once, so waiting only for it to be absent can be satisfied before it has
 * even started — which checked the machine midway through, after the
 * program files were deleted but before the notes were put back. Wait for it
 * to appear, to go, and then for the program itself to be gone from disk,
 * which is the outcome rather than a process name.
 */
function waitForUninstall() {
  const exe = path.join(APP, 'csFreeNote.exe');
  for (let i = 0; i < 80 && !uninstallerRunning(); i += 1) sleep(250);
  for (let i = 0; i < 480 && uninstallerRunning(); i += 1) sleep(500);
  for (let i = 0; i < 80 && fs.existsSync(exe); i += 1) sleep(250);
  sleep(2000);
}

const DIALOG = path.join(__dirname, 'support', 'dialog.ps1');
const DIALOG_LOG = path.join(os.tmpdir(), 'csfreenote-dialog.txt');

/**
 * Uninstall the way a person does — no /S — answering the boxes by caption.
 *
 * This is the only way a person reaches the question, and it stayed broken
 * through a full green run of everything else: a one-click uninstaller turns
 * silent mode on itself after its own confirmation, so a plain IfSilent test
 * never saw a human standing there. Returns what the question said, so the
 * wording is checked along with the outcome.
 */
function uninstallInteractively(answer) {
  killApp();
  fs.rmSync(DIALOG_LOG, { force: true });
  // -Report rather than stdout, and no `detached`: a driver started detached
  // gets no console and then finds no windows at all, silently.
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', DIALOG, '-Want', `확인,${answer}`, '-Report', DIALOG_LOG], {
    stdio: 'ignore',
  }).unref();

  spawnSync(UNINSTALL, ['/currentuser'], { stdio: 'ignore' });
  waitForUninstall();

  const said = fs.existsSync(DIALOG_LOG) ? fs.readFileSync(DIALOG_LOG, 'utf8') : '';
  // The second TEXT line is the question about notes; the first is the
  // uninstaller's own "are you sure".
  const texts = said.split(/\r?\n/).filter((l) => l.startsWith('TEXT '));
  return { question: texts[1] || '', answered: (said.match(/CLICKED/g) || []).length };
}

function install() {
  // NSIS refuses to run while another copy of its own installer or uninstaller
  // is still winding down. It says so inconsistently — sometimes an exit code,
  // sometimes silence, sometimes a half-copied folder — so judge the attempt by
  // the uninstaller, which it writes once everything else is in place.
  const exe = path.join(APP, 'csFreeNote.exe');
  const done = () => fs.existsSync(exe) && fs.existsSync(UNINSTALL);
  const tries = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) sleep(4000);
    waitForUninstall();
    clearApp();
    const run = spawnSync(SETUP, ['/S'], { stdio: 'ignore' });
    tries.push(run.error ? run.error.code : `exit ${run.status}`);
    for (let i = 0; !run.error && i < 300 && !done(); i += 1) sleep(100);
    if (done()) break;
  }
  if (!done()) throw new Error(`설치되지 않았습니다 (${tries.join(', ')}): ${APP}`);

  // The installer offers to start the app when someone double-clicks it in
  // Explorer, but not when it is run from here — so start it explicitly. What
  // matters is that the app lays out its folders beside the executable.
  spawn(exe, [], { cwd: APP, detached: true, stdio: 'ignore' }).unref();
  const seeded = path.join(APP, 'BookData', 'csFreeNote', '1 소개.html');
  for (let i = 0; i < 300; i += 1) {
    if (fs.existsSync(path.join(APP, 'csFreeNote.json')) && fs.existsSync(seeded)) break;
    sleep(100);
  }
  killApp();
}

const NOTE = '<html><head><meta charset="utf-8"></head><body><p>소중한 메모</p></body></html>';

function addUserData() {
  fs.mkdirSync(path.join(APP, 'BookData', '내 폴더'), { recursive: true });
  fs.mkdirSync(path.join(APP, 'csTemplate'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'BookData', '내 폴더', '중요.html'), NOTE, 'utf8');
  fs.writeFileSync(path.join(APP, 'csTemplate', '내 양식.html'), NOTE, 'utf8');
}

/**
 * Remove the install folder, waiting out whoever still holds it.
 *
 * The uninstaller does SetOutPath $INSTDIR, so the folder is its working
 * directory and cannot be removed until that process is really gone — which
 * is a moment after it stops appearing in the task list.
 *
 * The registry entry has to go too. Left behind with no uninstaller under it,
 * it makes the next install abort before it starts.
 */
function clearApp() {
  spawnSync('taskkill', ['/IM', 'Un_A.exe', '/F'], { stdio: 'ignore' });
  spawnSync('taskkill', ['/IM', SETUP_NAME, '/F'], { stdio: 'ignore' });
  killApp();
  for (let i = 0; i < 120; i += 1) {
    try {
      fs.rmSync(APP, { recursive: true, force: true });
      break;
    } catch {
      sleep(250);
    }
  }
  fs.rmSync(APP, { recursive: true, force: true });

  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'support', 'forget-install.ps1')], { stdio: 'ignore' });
}

const programFiles = () => (fs.existsSync(APP) ? fs.readdirSync(APP) : [])
  .filter((f) => /\.(dll|pak|bin|dat)$/i.test(f) || f === 'csFreeNote.exe');

/**
 * Never run over someone's notes.
 *
 * This installs to the real place and, to check the question the uninstaller
 * asks, goes on to answer yes and delete the book. That is the same folder a
 * person keeps their notes in. It has run harmlessly for weeks against an
 * install that held nothing but the introduction, and then one day it did not:
 * the notes were there, and the run took them.
 *
 * So look first. Anything in BookData beyond the introduction the installer
 * ships means this is somebody's install, and the check stops rather than
 * writes.
 */
function refuseToEatNotes() {
  const book = path.join(APP, 'BookData');
  if (!fs.existsSync(book)) return;
  const SHIPPED = new Set(['csFreeNote', '내 폴더']);   // ours, and this check's own
  const theirs = fs.readdirSync(book).filter((name) => !SHIPPED.has(name));
  if (!theirs.length) return;
  console.error('');
  console.error('  이 검사는 설치와 제거를 실제로 수행하며, 노트까지 지우는 경우도 시험합니다.');
  console.error('  그런데 설치 폴더에 소개 문서가 아닌 것이 있습니다:');
  console.error('');
  for (const name of theirs) console.error('    ' + path.join(book, name));
  console.error('');
  console.error('  지워지면 안 되는 것이므로 검사를 하지 않고 멈춥니다.');
  console.error('  옮기거나 따로 보관한 뒤에 다시 돌리십시오.');
  console.error('');
  process.exit(1);
}

function main() {
  refuseToEatNotes();
  if (!fs.existsSync(SETUP)) {
    console.log(`설치 파일이 없습니다: ${SETUP}`);
    console.log('먼저 npm run dist 를 실행하세요.');
    process.exit(1);
  }

  console.log('■ 설치');
  install();
  ok('프로그램이 설치됨', fs.existsSync(path.join(APP, 'csFreeNote.exe')));
  ok('기본 노트가 놓임',
    fs.existsSync(path.join(APP, 'BookData', 'csFreeNote', '1 소개.html')));
  ok('양식 폴더가 놓임', fs.existsSync(path.join(APP, 'csTemplate')));
  ok('설정이 만들어짐', fs.existsSync(path.join(APP, 'csFreeNote.json')));

  const listed = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -EA 0 |"
    + " Where-Object { $_.DisplayName -like '*csFreeNote*' } |"
    + ' Select-Object -First 1 -ExpandProperty Publisher'], { encoding: 'utf8' });
  ok('제어판에 게시자와 함께 등록됨',
    (listed.stdout || '').trim() === 'sf-mantis', (listed.stdout || '').trim());

  console.log('\n■ 그냥 제거하면 노트는 남는다');
  addUserData();
  killApp();
  execFileSync(UNINSTALL, ['/S', '/currentuser'], { stdio: 'ignore' });
  waitForUninstall();

  ok('프로그램 파일이 사라짐', programFiles().length === 0, programFiles().join(', '));
  ok('직접 만든 노트가 남음',
    fs.existsSync(path.join(APP, 'BookData', '내 폴더', '중요.html')));
  ok('기본 노트도 남음',
    fs.existsSync(path.join(APP, 'BookData', 'csFreeNote', '1 소개.html')));
  ok('직접 만든 양식이 남음', fs.existsSync(path.join(APP, 'csTemplate', '내 양식.html')));
  ok('설정이 남음', fs.existsSync(path.join(APP, 'csFreeNote.json')));

  console.log('\n■ 노트도 지우라고 하면 지운다');
  clearApp();
  install();
  addUserData();
  killApp();
  execFileSync(UNINSTALL, ['/S', '/currentuser', '/DELETEDATA'], { stdio: 'ignore' });
  waitForUninstall();

  const left = fs.existsSync(APP) ? fs.readdirSync(APP) : [];
  ok('노트까지 모두 사라짐',
    !fs.existsSync(path.join(APP, 'BookData')) && !fs.existsSync(path.join(APP, 'csFreeNote.json')),
    left.join(', '));

  console.log('\n■ 물어봤을 때 아니요를 누르면 노트는 남는다');
  clearApp();
  install();
  addUserData();
  const no = uninstallInteractively('아니요');
  ok('질문이 실제로 떴다', no.answered === 2, `클릭 ${no.answered}회`);
  ok('질문이 남는 것을 밝힌다',
    no.question.includes('BookData') && no.question.includes('되돌릴 수 없습니다'),
    no.question);
  ok('프로그램 파일이 사라짐', programFiles().length === 0, programFiles().join(', '));
  ok('노트가 남음', fs.existsSync(path.join(APP, 'BookData', '내 폴더', '중요.html')));
  ok('설정이 남음', fs.existsSync(path.join(APP, 'csFreeNote.json')));

  console.log('\n■ 물어봤을 때 예를 누르면 노트도 지운다');
  clearApp();
  install();
  addUserData();
  const yes = uninstallInteractively('예');
  ok('질문이 실제로 떴다', yes.answered === 2, `클릭 ${yes.answered}회`);
  const after = fs.existsSync(APP) ? fs.readdirSync(APP) : [];
  ok('노트까지 모두 사라짐', after.length === 0, after.join(', '));

  clearApp();

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
