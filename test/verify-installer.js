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
 * The third way out is the one nobody watched for a long time: an upgrade,
 * where the new installer runs the old uninstaller before laying itself down.
 * That path has to keep the notes without asking, and until now it was only
 * ever read, never run.
 *
 * Usage: node test/verify-installer.js
 *
 * Installs into a folder of its own under the temp directory, via /D=, and
 * removes itself again. The two registry entries a real install owns are the
 * only thing outside that folder it touches, and they are exported before and
 * put back after — see support/keep-registry.ps1. Someone's own installation
 * is left as it was found.
 *
 * Takes several minutes: two of the ways out are driven by clicking the real
 * dialogs, at the speed a person would.
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
// Installed into a throwaway folder, never the place a person keeps theirs.
// The installer honours /D= even when the registry already points somewhere
// else, so this holds on a machine where csFreeNote is really installed.
// No spaces in the name: NSIS takes the rest of the line after /D= unquoted.
const APP = path.join(os.tmpdir(), 'csfreenote-installer-check');
const REAL_APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'csfreenote');
const REG_KEEP = path.join(os.tmpdir(), 'csfreenote-installer-check-reg');
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
    // /D must come last and carry no quotes.
    const run = spawnSync(SETUP, ['/S', `/D=${APP}`], { stdio: 'ignore' });
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

/**
 * Run the installer again over what is already there.
 *
 * No clearApp first, and no /D beyond the one the folder already answers to:
 * that is what makes it an upgrade rather than a fresh install. The installer
 * finds the previous version, runs its uninstaller with --updated, and only
 * then lays the new one down.
 */
function upgradeInPlace() {
  const exe = path.join(APP, 'csFreeNote.exe');
  const done = () => fs.existsSync(exe) && fs.existsSync(UNINSTALL);
  const tries = [];

  // The same patience install() needs, and for the same reason: NSIS will not
  // start while a copy of its own installer or uninstaller is still winding
  // down, and says so inconsistently. An upgrade runs two of them back to
  // back, so there is more winding down here than anywhere else. Without the
  // retry this passed and failed by the second.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) sleep(4000);
    killApp();
    waitForUninstall();
    const run = spawnSync(SETUP, ['/S', `/D=${APP}`], { stdio: 'ignore' });
    tries.push(run.error ? run.error.code : `exit ${run.status}`);
    for (let i = 0; !run.error && i < 900 && !done(); i += 1) sleep(100);
    if (done()) break;
  }
  if (!done()) throw new Error(`덮어 설치가 끝나지 않았습니다 (${tries.join(', ')}): ${APP}`);

  waitForUninstall();
  killApp();
}

const NOTE = '<html><head><meta charset="utf-8"></head><body><p>소중한 메모</p></body></html>';

/**
 * What a note drags along with it.
 *
 * A note is never only its own file. The previous version of it sits in
 * _backup, pasted pictures in _images, and the files attached to it in
 * _files — and losing any of those loses work as surely as losing the note.
 * All three are inside BookData, so the uninstaller's keep branch carries
 * them by carrying the one folder; that is a thing the layout happens to make
 * true rather than a thing anybody wrote down, which is exactly the kind of
 * thing that stops being true without anyone noticing.
 */
const COMPANIONS = [
  ['_backup', '내 폴더', '중요.html'],      // 직전 판
  ['_images', 'ab12cd34.png'],              // 붙여넣은 그림
  ['_files', '내 폴더', '중요', '사양서.pdf'], // 붙임 파일
];

function addUserData() {
  fs.mkdirSync(path.join(APP, 'BookData', '내 폴더'), { recursive: true });
  fs.mkdirSync(path.join(APP, 'csTemplate'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'BookData', '내 폴더', '중요.html'), NOTE, 'utf8');
  fs.writeFileSync(path.join(APP, 'csTemplate', '내 양식.html'), NOTE, 'utf8');

  for (const parts of COMPANIONS) {
    const full = path.join(APP, 'BookData', ...parts);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, NOTE, 'utf8');
  }
}

/** Are the note's companions still there? Returns the ones that are not. */
function missingCompanions() {
  return COMPANIONS
    .filter((parts) => !fs.existsSync(path.join(APP, 'BookData', ...parts)))
    .map((parts) => parts[0]);
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
 * Never run where somebody keeps their notes.
 *
 * This installs and uninstalls for real, and to check the question the
 * uninstaller asks it goes on to answer yes and delete the book. It used to
 * do that in the real install folder. It ran harmlessly for weeks against an
 * install holding nothing but the introduction, and then one day it did not:
 * the notes were there, and the run took them.
 *
 * Now it installs into a folder of its own. What is checked here is that the
 * way out has not quietly come undone - a mistyped /D, an installer that
 * stopped honouring it - rather than what happens to be in the book.
 */
function refuseToEatNotes() {
  const real = path.resolve(REAL_APP).toLowerCase();
  if (path.resolve(APP).toLowerCase() !== real) return;
  console.error('');
  console.error('  이 검사는 설치와 제거를 실제로 수행하며, 노트까지 지우는 경우도 시험합니다.');
  console.error('  그런데 설치 위치가 사람이 쓰는 그 폴더입니다:');
  console.error('');
  console.error('    ' + APP);
  console.error('');
  console.error('  검사를 하지 않고 멈춥니다.');
  console.error('');
  process.exit(1);
}

/**
 * Put this machine's own csFreeNote registry entries aside, and back.
 *
 * Installing writes the per-user install key and the Add/Remove entry, and
 * the cleanup below deletes every entry named csFreeNote - which on this
 * machine includes the real one. The program would survive, but it would
 * disappear from Add/Remove and the next upgrade would not know where it is.
 */
function registry(action) {
  const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'support', 'keep-registry.ps1'),
    '-Action', action, '-Dir', REG_KEEP], { encoding: 'utf8' });
  const said = `${run.stdout || ''}`.match(/(saved|restored) (\d+)/);
  return said ? Number(said[2]) : -1;
}

/**
 * The whole check, with this machine's own install records put aside.
 *
 * Restored in a finally: a check that leaves somebody's program missing from
 * Add/Remove because it threw halfway is a worse bargain than no check.
 */
function main() {
  refuseToEatNotes();
  // Read before anything is installed. The uninstaller names Chromium's own
  // leavings under $APPDATA so they do not outlive the program, and what
  // matters is what it does not name: that folder is where the program falls
  // back to when the place beside the executable cannot be written to, so for
  // somebody who installed under Program Files it holds their notes.
  const macro = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  const appdata = macro.split(/\r?\n/).filter((l) => l.includes('$APPDATA'));
  const NOTES = /BookData|csTemplate|csFreeNote\.(json|ini)/;

  ok('$APPDATA 쪽 찌꺼기를 치우기는 한다', appdata.length > 0, String(appdata.length));
  ok('노트·양식·설정의 이름은 대지 않는다',
    !appdata.some((l) => NOTES.test(l)),
    appdata.filter((l) => NOTES.test(l)).join(' / '));
  // RMDir /r on the folder itself would take everything in it, named or not.
  ok('그 폴더 자체를 재귀로 지우지 않는다',
    !appdata.some((l) => /RMDir\s+\/r\s+"?\$APPDATA[^"]*\$\{APP_FILENAME\}"?\s*$/.test(l)),
    appdata.filter((l) => /RMDir\s+\/r/.test(l)).length + '건');

  if (!fs.existsSync(SETUP)) {
    console.log(`설치 파일이 없습니다: ${SETUP}`);
    console.log('먼저 npm run dist 를 실행하세요.');
    process.exit(1);
  }

  const kept = registry('save');
  console.log(`■ 이 PC 의 설치 기록 ${kept}개를 잠시 보관합니다 (${APP} 에 설치)`);
  try {
    run();
  } finally {
    const back = registry('restore');
    console.log(`\n■ 설치 기록 ${back}개를 되돌렸습니다`);
  }

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

function run() {
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

  // 이 판을 쓰는 사람이 다음 판을 덮어 깔 때 무슨 일이 일어나는가. 업그레이드는
  // 옛 제거 프로그램을 --updated 를 붙여 조용히 먼저 돌리므로, 노트를 지울지
  // 묻는 가지를 건너뛰고 남기는 쪽으로 가야 한다. 판을 내보내면서도 이 길만은
  // 아무도 밟지 않고 있었다.
  console.log('\n■ 새 판을 덮어 깔아도 노트는 남는다');
  addUserData();
  killApp();
  const mine = path.join(APP, 'BookData', '내 폴더', '중요.html');
  const before = fs.readFileSync(mine, 'utf8');
  // 업그레이드가 정말 일어났는지 가리는 표식. 지켜주는 목록(BookData,
  // csTemplate, 설정)에 없으므로, 옛 제거 프로그램이 RMDir /r 을 돌렸다면
  // 사라진다. 없어지지 않았다면 그냥 덮어 쓴 것이고, 노트가 남은 것도
  // 아무것도 증명하지 않는다.
  const mark = path.join(APP, '지워져야 하는 표식.txt');
  fs.writeFileSync(mark, 'x', 'utf8');
  upgradeInPlace();

  ok('프로그램이 다시 놓임', fs.existsSync(path.join(APP, 'csFreeNote.exe')));
  ok('직접 만든 노트가 그대로',
    fs.existsSync(mine) && fs.readFileSync(mine, 'utf8') === before);
  ok('직접 만든 양식도 그대로',
    fs.existsSync(path.join(APP, 'csTemplate', '내 양식.html')));
  ok('설정도 그대로', fs.existsSync(path.join(APP, 'csFreeNote.json')));
  ok('기본 노트도 그대로',
    fs.existsSync(path.join(APP, 'BookData', 'csFreeNote', '1 소개.html')));
  ok('설치 폴더는 실제로 갈아엎였다 (덮어 쓴 것이 아니다)',
    !fs.existsSync(mark));
  ok('백업·그림·붙임도 그대로',
    missingCompanions().length === 0, missingCompanions().join(', '));

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
  ok('백업·그림·붙임도 남음',
    missingCompanions().length === 0, missingCompanions().join(', '));

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

}

main();
