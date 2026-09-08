'use strict';

/**
 * Minimising to the notification area.
 *
 * The option is off by default, and with it off minimising has to behave the
 * way it always did — an app that disappears from the taskbar unasked is a
 * surprise, not a feature. With it on, the window hides and an icon appears;
 * coming back takes the icon away again.
 *
 * Usage: npx electron test/verify-tray.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, BrowserWindow, Tray } = require('electron');

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

const call = (channel, ...args) => {
  const handler = ipcMain._invokeHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tray instances are not enumerable, so count the ones that get built. */
let trayCount = 0;
const RealTray = Tray;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csfreenote-tray-'));
  fs.mkdirSync(path.join(root, 'BookData'), { recursive: true });
  fs.writeFileSync(path.join(root, 'BookData', '노트.html'),
    '<html><head></head><body><p>내용</p></body></html>', 'utf8');

  process.env.PORTABLE_EXECUTABLE_DIR = root;
  Object.defineProperty(app, 'isPackaged', { get: () => false });

  require('../electron/main.js');
  await app.whenReady();
  await wait(600);

  const win = BrowserWindow.getAllWindows()[0];
  ok('창이 열림', !!win);
  if (!win) {
    app.exit(1);
    return;
  }
  win.show();
  await wait(200);

  console.log('\n■ 옵션이 꺼져 있을 때');
  const settings = await call('settings:get');
  ok('기본값은 꺼짐', settings.window.minimizeToTray === false,
    String(settings.window.minimizeToTray));

  // A minimised window reports isVisible() false on Windows, so what separates
  // the two behaviours is whether it is minimised or merely hidden.
  win.minimize();
  await wait(400);
  ok('평소대로 최소화됨', win.isMinimized() === true, `minimized=${win.isMinimized()}`);
  ok('알림 영역 아이콘은 만들지 않음', trayCount === 0, String(trayCount));

  win.restore();
  await wait(300);

  console.log('\n■ 옵션을 켰을 때');
  await call('settings:save', { window: { minimizeToTray: true } });
  const on = await call('settings:get');
  ok('설정이 저장됨', on.window.minimizeToTray === true);

  win.minimize();
  await wait(600);
  // Windows carries out the minimise even when the event is cancelled, so the
  // window ends up both minimised and hidden. What matters is that it is gone
  // from the screen and the icon is there to bring it back.
  ok('창이 화면에서 사라짐', win.isVisible() === false, `visible=${win.isVisible()}`);
  ok('알림 영역 아이콘이 생김', trayCount === 1, String(trayCount));

  // Back through the app's own path — the same function the icon click uses.
  app.emit('second-instance');
  await wait(600);
  ok('아이콘을 눌러 부르면 창이 돌아옴',
    win.isVisible() === true && win.isMinimized() === false,
    `visible=${win.isVisible()} minimized=${win.isMinimized()}`);
  ok('돌아오면 아이콘은 사라짐', trayDestroyed === 1,
    `destroyed=${trayDestroyed}`);

  console.log('\n■ 설정을 다시 끄면');
  await call('settings:save', { window: { minimizeToTray: false } });
  win.minimize();
  await wait(400);
  ok('다시 평소 최소화로', win.isMinimized() === true, `minimized=${win.isMinimized()}`);
  ok('아이콘을 더 만들지 않음', trayCount === 1, String(trayCount));
  win.restore();
  await wait(200);

  console.log(`\n통과 ${passed} / 실패 ${failed}`);
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(failed === 0 ? 0 : 1);
}

let trayDestroyed = 0;

// Count construction and destruction without changing what the app does.
const originalDestroy = RealTray.prototype.destroy;
RealTray.prototype.destroy = function countedDestroy(...args) {
  trayDestroyed += 1;
  return originalDestroy.apply(this, args);
};
const originalSetToolTip = RealTray.prototype.setToolTip;
RealTray.prototype.setToolTip = function countedToolTip(...args) {
  trayCount += 1;
  return originalSetToolTip.apply(this, args);
};

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
