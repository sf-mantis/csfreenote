const {
  app, BrowserWindow, ipcMain, dialog, Menu, Tray, shell, nativeImage, session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const doc = require('./document');
const { decodeBuffer } = require('./encoding');
const { topUpFiles } = require('./seed');
const updates = require('./update');
const noteIO = require('./notes');
const { createSearchIndex } = require('./search');
const configStore = require('./config');

const useViteDevServer = process.argv.includes('--dev') || process.env.CSFREENOTE_DEV === '1';
// A folder's description document is not a note, so it never shows up as one
// in the tree; it is opened when the folder itself is selected.
const FOLDER_MARKER = /^___cs_free_note__folder\.html?$/i;
const MARKER_NAME = '___cs_free_note__folder.html';
// The blank line these documents open with carries a <br>: an empty <p> lays
// out at zero height, so there is nothing to click and no way to put the
// caret in it.
const BLANK_LINE = '<p><br></p>';
const NOTE_EXT = /\.(htm|html)$/i;

const FLUSH_TIMEOUT_MS = 3000;

// Folders the app keeps for itself: they are not part of the user's tree.
const HIDDEN_DIRS = new Set([noteIO.ASSET_DIR, noteIO.BACKUP_DIR]);

const searchIndex = createSearchIndex({ hiddenDirs: HIDDEN_DIRS });

/** Anything that rewrites, moves or removes a file makes its cache entry stale. */
function forgetSearchEntry(relativePath) {
  if (!relativePath) return;
  try {
    searchIndex.invalidate(noteIO.safeJoin(bookDir(), relativePath));
  } catch {
    /* a path we cannot resolve was never cached */
  }
}

let mainWindow = null;
let tray = null;
let closing = false;
function appRoot() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..');
  }
  // A portable build is launched from an extracted copy of itself; this is the
  // folder the user actually put the exe in.
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything the user owns — notes, templates, pasted files, settings — lives
 * beside the executable, the way a portable app should. If that folder is not
 * writable (installed under Program Files, run from read-only media) we fall
 * back to the per-user data folder rather than failing to save.
 */
function dataRoot() {
  const beside = appRoot();
  if (!app.isPackaged || isWritable(beside)) return beside;
  return app.getPath('userData');
}

/** Create a user folder on first run, seeding it from what we shipped. */
function ensureUserDir(name, { topUp = false } = {}) {
  const target = path.join(dataRoot(), name);
  const seed = app.isPackaged ? path.join(process.resourcesPath, name) : null;
  if (!fs.existsSync(target)) {
    try {
      if (seed && fs.existsSync(seed)) copyDirSync(seed, target);
      else fs.mkdirSync(target, { recursive: true });
    } catch {
      fs.mkdirSync(target, { recursive: true });
    }
    return target;
  }

  if (topUp) {
    try { topUpFiles(seed, target); }
    catch { /* the folder is usable as it stands */ }
  }
  return target;
}

function defaultBookData() {
  return ensureUserDir('BookData');
}

function templateDir() {
  // Templates are ours to hand out; an update should bring new ones along.
  return ensureUserDir('csTemplate', { topUp: true });
}

/** Scratch space for files pasted into a note. */
function tempDir() {
  return ensureUserDir('temp');
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Remove half-written files left behind if the machine lost power between the
 * temp write and the rename. The note itself is never one of these — the
 * rename is atomic — so deleting them loses nothing.
 */
function sweepTempFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sweepTempFiles(full);
    else if (/\.\d+\.tmp$/.test(entry.name)) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* leave it; it is inert either way */
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

let settings = configStore.defaults();

/** Absolute path of the book currently open. */
function bookDir() {
  const book = configStore.activeBook(settings);
  return configStore.resolveDir(dataRoot(), book.dir);
}

function loadConfig() {
  const { config, migrated, recovered } = configStore.load(dataRoot());
  settings = config;
  if (migrated) console.log('설정을 csFreeNote.json으로 옮겼습니다.');
  if (recovered) console.error('설정 파일을 읽지 못해 기본값으로 시작합니다:', recovered);

  // Lay out the user-facing folders on first run, so the app root stays
  // readable: notes, templates, scratch space, settings.
  ensureUserDir(path.relative(dataRoot(), bookDir()) || 'BookData');
  templateDir();
  tempDir();
  sweepTempFiles(bookDir());
}

function saveConfig() {
  try {
    configStore.save(dataRoot(), settings);
  } catch (err) {
    console.error('config save failed', err);
  }
}

/** Keep the remembered page pointing at a note that still exists. */
function remapLastPage(fromRelative, toRelative) {
  const next = noteIO.remapPath(settings.ui.lastPage, fromRelative, toRelative);
  if (next === settings.ui.lastPage) return;
  settings.ui.lastPage = next;
  saveConfig();
}

/**
 * What the renderer works with. It does not need the whole settings tree, and
 * keeping the wire shape flat means the file format can change without the
 * renderer caring.
 */
function rendererConfig() {
  const book = configStore.activeBook(settings);
  return {
    Name: book.name,
    dir: bookDir(),
    theme: settings.ui.theme,
    TreeWidth: settings.ui.treeWidth,
    lstPage: settings.ui.lastPage,
    startMode: settings.editor.startMode,
    autosaveMs: settings.editor.autosaveMs,
    returnToBrowse: settings.editor.returnToBrowse,
    tableEditing: settings.editor.tableEditing,
    dateFormat: settings.editor.dateFormat,
    searchWholeBook: settings.ui.searchWholeBook,
  };
}

function applyRendererConfig(patch = {}) {
  if (patch.theme) settings.ui.theme = patch.theme === 'light' ? 'light' : 'dark';
  if (Number.isFinite(Number(patch.TreeWidth))) {
    settings.ui.treeWidth = Number(patch.TreeWidth);
  }
  if (typeof patch.lstPage === 'string') settings.ui.lastPage = patch.lstPage;
  saveConfig();
}

const extractBody = doc.extractBody;
const wrapHtml = doc.wrapDocument;

function isHiddenNote(name) {
  return FOLDER_MARKER.test(name);
}

async function readTree(dir, relative = '') {
  const nodes = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return nodes;
  }

  const folders = [];
  const notes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && HIDDEN_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = await readTree(full, rel);
      // The folder's own description document, if it has one — shown when
      // the folder is selected.
      const marker = (await fsp.readdir(full).catch(() => []))
        .find((name) => FOLDER_MARKER.test(name));
      folders.push({
        type: 'folder',
        name: entry.name,
        path: full,
        relative: rel,
        marker: marker ? `${rel}/${marker}` : null,
        children,
      });
    } else if (NOTE_EXT.test(entry.name) && !isHiddenNote(entry.name)) {
      notes.push({
        type: 'note',
        name: entry.name.replace(NOTE_EXT, ''),
        fileName: entry.name,
        path: full,
        relative: rel,
      });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  notes.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return [...folders, ...notes];
}

/* ------------------------------------------------------------------ *
 * Notification area
 * ------------------------------------------------------------------ */

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
}

function showFromTray() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * The icon exists only while the window is hidden behind it.
 *
 * Leaving one there permanently would put csFreeNote in the notification area
 * of people who never asked for it, and the window is reachable from the
 * taskbar the rest of the time anyway.
 */
function hideToTray() {
  if (!mainWindow) return;

  if (!tray) {
    const image = nativeImage.createFromPath(iconPath());
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip('csFreeNote');
    tray.on('click', showFromTray);
    tray.on('double-click', showFromTray);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '열기', click: showFromTray },
      { type: 'separator' },
      { label: '끝내기', click: () => mainWindow && mainWindow.close() },
    ]));
  }

  mainWindow.hide();
}

function removeTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

/**
 * A note can contain any link at all. Following one inside the app window
 * would replace the app with a web page and leave no way back, so every
 * navigation away from the app's own document is handed to the OS browser.
 */
function guardNavigation(win) {
  const isAppUrl = (url) =>
    url.startsWith('file://') || url.startsWith('http://127.0.0.1:5173');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const block = (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', block);
  win.webContents.on('will-frame-navigate', (event) => block(event, event.url));
}

/** Keep a restored window on a monitor that actually exists right now. */
function clampToDisplay(opts) {
  if (!Number.isFinite(opts.x) || !Number.isFinite(opts.y)) return;
  const { screen } = require('electron');
  const area = screen.getDisplayMatching({
    x: opts.x, y: opts.y, width: opts.width, height: opts.height,
  }).workArea;
  const visible =
    opts.x + opts.width > area.x + 80 &&
    opts.x < area.x + area.width - 80 &&
    opts.y + 40 > area.y &&
    opts.y < area.y + area.height - 40;
  if (!visible) {
    delete opts.x;
    delete opts.y;
  }
}

// The red spell-check underlines belong to a word processor. They appear the
// moment a note becomes editable and stay drawn after it stops being editable,
// and no dictionary is going to be right about a page of Korean prose mixed
// with table names and file paths anyway.
function silenceSpellchecker() {
  const target = session.defaultSession;
  if (target && typeof target.setSpellCheckerEnabled === 'function') {
    target.setSpellCheckerEnabled(false);
  }
}

function createWindow() {
  const opts = {
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#1a1d23',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'csFreeNote',
  };
  if (Number.isFinite(settings.window.left) && Number.isFinite(settings.window.top)) {
    opts.x = settings.window.left;
    opts.y = settings.window.top;
    clampToDisplay(opts);
  }

  mainWindow = new BrowserWindow(opts);

  if (settings.window.startAs === 'maximized' || settings.window.maximized) {
    mainWindow.maximize();
  }

  if (useViteDevServer) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  guardNavigation(mainWindow);

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Minimising hides behind the icon only when asked; otherwise it minimises.
  mainWindow.on('minimize', (event) => {
    if (!settings.window.minimizeToTray) return;
    event.preventDefault();
    hideToTray();
  });

  mainWindow.on('close', (event) => {
    const bounds = mainWindow.getBounds();
    settings.window.maximized = mainWindow.isMaximized();
    if (!mainWindow.isMaximized()) {
      settings.window.left = bounds.x;
      settings.window.top = bounds.y;
      settings.window.width = bounds.width;
      settings.window.height = bounds.height;
    }
    saveConfig();

    // Give the renderer a chance to flush a pending autosave before we go.
    if (closing || mainWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    closing = true;
    // Called by the renderer with its answer, or by the deadline with none.
    const finish = (_event, proceed = true) => {
      clearTimeout(timer);
      ipcMain.removeListener('app:flush-hold', hold);
      ipcMain.removeListener('app:flushed', finish);
      if (proceed === false) {
        // The user has work the file would not take and chose to keep it.
        closing = false;
        return;
      }
      removeTray();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    };
    // The deadline is for a renderer that never answers, not for a person
    // reading a dialog. Once it says it is asking, we wait.
    const hold = () => clearTimeout(timer);
    const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
    ipcMain.once('app:flush-hold', hold);
    ipcMain.once('app:flushed', finish);
    mainWindow.webContents.send('app:flush');
  });

  mainWindow.on('closed', () => {
    removeTray();
    mainWindow = null;
  });

  // Any way back to the window takes the icon away again.
  mainWindow.on('show', removeTray);
  mainWindow.on('restore', removeTray);

  // Any way back to the window takes the icon away again.
  mainWindow.on('show', removeTray);
  mainWindow.on('restore', removeTray);
}

function registerIpc() {
  ipcMain.handle('config:get', () => rendererConfig());

  ipcMain.handle('config:set', (_e, patch) => {
    applyRendererConfig(patch);
    return rendererConfig();
  });

  ipcMain.handle('book:chooseDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '노트 폴더 선택',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: bookDir(),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('book:list', () => ({
    books: settings.books.map((b) => ({
      ...b,
      path: configStore.resolveDir(dataRoot(), b.dir),
      missing: !fs.existsSync(configStore.resolveDir(dataRoot(), b.dir)),
    })),
    active: settings.activeBook,
  }));

  ipcMain.handle('book:select', async (_e, index) => {
    const next = Number(index);
    if (!Number.isInteger(next) || next < 0 || next >= settings.books.length) {
      return { ok: false, message: '그런 노트 폴더가 없습니다.' };
    }
    if (next === settings.activeBook) return { ok: true, unchanged: true };

    settings.activeBook = next;
    // The remembered page belongs to the book that was open, not this one.
    settings.ui.lastPage = '';
    searchIndex.clear();
    saveConfig();
    return { ok: true };
  });

  ipcMain.handle('book:save', async (_e, { index, name, dir, shared }) => {
    const checked = noteIO.validateName(name, { isFolder: true });
    if (!checked.ok) return { ok: false, message: checked.message };

    const target = String(dir || '').trim();
    if (!target) return { ok: false, message: '폴더 경로를 지정하세요.' };
    if (!fs.existsSync(target)) return { ok: false, message: '그 경로에 폴더가 없습니다.' };

    const book = {
      name: checked.name,
      dir: configStore.storedDir(dataRoot(), target),
      shared: shared === true,
    };

    const at = Number(index);
    if (Number.isInteger(at) && at >= 0 && at < settings.books.length) {
      settings.books[at] = book;
      if (at === settings.activeBook) {
        settings.ui.lastPage = '';
        searchIndex.clear();
      }
    } else {
      settings.books.push(book);
    }
    saveConfig();
    return { ok: true, index: Number.isInteger(at) && at >= 0 ? at : settings.books.length - 1 };
  });

  ipcMain.handle('book:remove', async (_e, index) => {
    const at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= settings.books.length) {
      return { ok: false, message: '그런 노트 폴더가 없습니다.' };
    }
    if (settings.books.length === 1) {
      return { ok: false, message: '노트 폴더는 최소 하나 있어야 합니다.' };
    }

    // Removing an entry only forgets the path; the notes themselves stay put.
    settings.books.splice(at, 1);
    if (settings.activeBook === at) {
      settings.activeBook = Math.max(0, at - 1);
      settings.ui.lastPage = '';
      searchIndex.clear();
    } else if (settings.activeBook > at) {
      settings.activeBook -= 1;
    }
    saveConfig();
    return { ok: true, active: settings.activeBook };
  });

  ipcMain.handle('book:reorder', async (_e, { from, to }) => {
    const a = Number(from);
    const b = Number(to);
    const last = settings.books.length - 1;
    if (![a, b].every((n) => Number.isInteger(n) && n >= 0 && n <= last)) {
      return { ok: false, message: '순서를 바꿀 수 없습니다.' };
    }
    const active = settings.books[settings.activeBook];
    const [moved] = settings.books.splice(a, 1);
    settings.books.splice(b, 0, moved);
    settings.activeBook = settings.books.indexOf(active);
    saveConfig();
    return { ok: true, active: settings.activeBook };
  });

  ipcMain.handle('settings:get', () => JSON.parse(JSON.stringify(settings)));

  ipcMain.handle('settings:save', async (_e, patch) => {
    if (patch?.ui) Object.assign(settings.ui, patch.ui);
    if (patch?.editor) Object.assign(settings.editor, patch.editor);
    if (patch?.window) Object.assign(settings.window, patch.window);
    if (patch?.update) Object.assign(settings.update, patch.update);
    // null means "put the defaults back"; an array replaces them.
    if (patch && 'formats' in patch) {
      settings.formats = patch.formats === null
        ? configStore.defaultFormats()
        : patch.formats;
    }
    settings = configStore.normalise(settings);
    saveConfig();
    return JSON.parse(JSON.stringify(settings));
  });

  ipcMain.handle('book:getTree', async () => {
    if (!fs.existsSync(bookDir())) {
      await fsp.mkdir(bookDir(), { recursive: true });
    }
    const marker = (await fsp.readdir(bookDir()).catch(() => []))
      .find((name) => FOLDER_MARKER.test(name));
    return {
      root: bookDir(),
      name: configStore.activeBook(settings).name || path.basename(bookDir()),
      marker: marker || null,
      children: await readTree(bookDir()),
    };
  });

  ipcMain.handle('note:read', async (_e, relativePath) =>
    noteIO.readNote(bookDir(), relativePath));

  ipcMain.handle('note:write', async (_e, payload) => {
    const result = await noteIO.writeNote({ ...payload, bookDir: bookDir() });
    if (result.ok) {
      settings.ui.lastPage = String(payload.relativePath).replace(/\\/g, '/');
      forgetSearchEntry(payload.relativePath);
    }
    return result;
  });

  ipcMain.handle('note:create', async (_e, { parentRelative, title, templateName }) => {
    const parent = parentRelative ? noteIO.safeJoin(bookDir(), parentRelative) : bookDir();
    await fsp.mkdir(parent, { recursive: true });
    const checked = noteIO.validateName(title || '새 노트');
    if (!checked.ok) return { ok: false, message: checked.message };
    const safeTitle = checked.name;
    let fileName = `${safeTitle}.html`;
    let full = path.join(parent, fileName);
    let n = 1;
    while (fs.existsSync(full)) {
      fileName = `${safeTitle} (${n++}).html`;
      full = path.join(parent, fileName);
    }

    // An empty templateName means the user explicitly chose a blank note;
    // omitting it altogether falls back to the default template.
    const wanted = templateName === '' ? '' :
      String(templateName || '기본 양식').replace(NOTE_EXT, '');
    const templates = templateDir();
    // The renderer passes a bare name; match either extension.
    const tplFile = wanted
      ? ['.html', '.htm']
        .map((ext) => path.join(templates, wanted + ext))
        .find((candidate) => fs.existsSync(candidate)) || ''
      : '';

    let body;
    let css = [];
    if (tplFile) {
      const buf = await fsp.readFile(tplFile);
      const { html } = decodeBuffer(buf);
      body = extractBody(html).replace(/<!--title-->/g, safeTitle);
      // The template's own rules come too. A note keeps only its <body> from
      // here on, so anything a template says about its appearance has to be
      // carried across now or it is lost.
      css = doc.templateStyle(html);
    } else {
      body = `<p><strong>${safeTitle}</strong></p>${BLANK_LINE}`;
    }

    const html = wrapHtml(body, css);
    await fsp.writeFile(full, html, 'utf8');

    const relative = path.relative(bookDir(), full).replace(/\\/g, '/');
    return { relativePath: relative, fileName };
  });

  /** Give a folder the description document it does not yet have. */
  ipcMain.handle('folder:describe', async (_e, { relativePath }) => {
    const dir = relativePath ? noteIO.safeJoin(bookDir(), relativePath) : bookDir();
    if (!fs.existsSync(dir)) return { ok: false, message: '폴더를 찾을 수 없습니다.' };

    const existing = (await fsp.readdir(dir)).find((name) => FOLDER_MARKER.test(name));
    if (existing) {
      return {
        ok: true,
        relativePath: [relativePath, existing].filter(Boolean).join('/'),
      };
    }

    const title = relativePath ? path.basename(dir) : configStore.activeBook(settings).name;
    const html = wrapHtml(`<p><strong>${title}</strong></p>${BLANK_LINE}`);
    await fsp.writeFile(path.join(dir, MARKER_NAME), html, 'utf8');
    return {
      ok: true,
      relativePath: [relativePath, MARKER_NAME].filter(Boolean).join('/'),
    };
  });

  ipcMain.handle('folder:create', async (_e, { parentRelative, name }) => {
    const parent = parentRelative ? noteIO.safeJoin(bookDir(), parentRelative) : bookDir();
    const checked = noteIO.validateName(name || '새 폴더', { isFolder: true });
    if (!checked.ok) return { ok: false, message: checked.message };
    const safeName = checked.name;
    let full = path.join(parent, safeName);
    let n = 1;
    while (fs.existsSync(full)) {
      full = path.join(parent, `${safeName} (${n++})`);
    }
    await fsp.mkdir(full, { recursive: true });
    const marker = path.join(full, MARKER_NAME);
    const markerHtml = wrapHtml(`<p><strong>${path.basename(full)}</strong></p>${BLANK_LINE}`);
    await fsp.writeFile(marker, markerHtml, 'utf8');
    return { ok: true, relativePath: path.relative(bookDir(), full).replace(/\\/g, '/') };
  });

  ipcMain.handle('item:rename', async (_e, { relativePath, newName, isFolder }) => {
    const full = noteIO.safeJoin(bookDir(), relativePath);
    const dir = path.dirname(full);
    const checked = noteIO.validateName(newName, { isFolder });
    if (!checked.ok) return { ok: false, message: checked.message };
    const safeName = checked.name;
    const targetName = isFolder ? safeName : (NOTE_EXT.test(safeName) ? safeName : `${safeName}.html`);
    const dest = path.join(dir, targetName);
    // Renaming to the same name is a no-op, not a collision.
    if (path.resolve(dest) === path.resolve(full)) return { ok: true, relativePath };
    if (fs.existsSync(dest)) return { ok: false, message: '이미 같은 이름이 있습니다.' };
    await fsp.rename(full, dest);
    const renamed = path.relative(bookDir(), dest).replace(/\\/g, '/');
    // A backup belongs to the note, so it follows the note to its new name.
    await noteIO.relocateBackup(bookDir(), relativePath, renamed);
    forgetSearchEntry(relativePath);
    remapLastPage(relativePath, renamed);
    return { ok: true, relativePath: renamed };
  });

  ipcMain.handle('item:delete', async (_e, { relativePath }) => {
    const full = noteIO.safeJoin(bookDir(), relativePath);
    // Deleting something that is already gone has achieved what was asked;
    // reporting ENOENT only turns a harmless repeat into an error dialog.
    if (fs.existsSync(full)) {
      // Recoverable by design: everything goes to the recycle bin, never rm.
      await shell.trashItem(full);
    }
    // The recycle bin is the safety net for a deletion; leaving the backup
    // behind would only orphan it, and a later note at this path would
    // inherit it.
    await noteIO.dropBackup(bookDir(), relativePath);
    forgetSearchEntry(relativePath);
    remapLastPage(relativePath, null);
    return { ok: true };
  });

  ipcMain.handle('item:move', async (_e, payload) => {
    const result = await noteIO.moveItem(bookDir(), payload);
    if (result.ok && !payload.copy) {
      forgetSearchEntry(payload.relativePath);
      remapLastPage(payload.relativePath, result.relativePath);
    }
    return result;
  });

  ipcMain.handle('image:save', async (_e, payload) =>
    noteIO.saveImage(bookDir(), payload));

  ipcMain.handle('search:notes', async (_e, { query, scopeRelative }) =>
    searchIndex.search(bookDir(), { query, scopeRelative }));

  ipcMain.handle('shell:showItem', async (_e, relativePath) => {
    const full = relativePath ? noteIO.safeJoin(bookDir(), relativePath) : bookDir();
    shell.showItemInFolder(full);
  });

  // No URL crosses this channel: the page is a constant in update.js, and a
  // release feed must never be able to choose where the browser goes.
  ipcMain.handle('app:openReleases', async () => {
    await shell.openExternal(updates.RELEASES_PAGE);
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (/^https?:/i.test(String(url))) await shell.openExternal(url);
  });

  ipcMain.handle('template:list', async () => {
    const templates = templateDir();
    if (!fs.existsSync(templates)) return [];
    const files = await fsp.readdir(templates);
    return files.filter((f) => NOTE_EXT.test(f)).map((f) => f.replace(NOTE_EXT, ''));
  });
}

// Two copies of the app sharing one book would fight over the same files, and
// Chromium cannot share its cache directory either — the second instance logs
// cache failures and starts degraded. Hand the argument to the running window
// instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  // Chromium has already begun starting its caches by this point and will
  // complain about them on the way out; say plainly what happened so the
  // noise is not read as a failure to launch.
  console.log('csFreeNote가 이미 실행 중입니다. 열려 있는 창을 앞으로 가져옵니다.');
  app.quit();
} else {
  app.on('second-instance', showFromTray);
}

app.whenReady().then(() => {
  loadConfig();
  registerIpc();
  silenceSpellchecker();
  Menu.setApplicationMenu(null);
  createWindow();
  announceUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Look for a newer release, once, and only say so if there is one.
 *
 * Held back so it never competes with opening the last note, and skipped
 * outside a packaged app, where the version in package.json is whatever the
 * working tree happens to say.
 */
function announceUpdate() {
  if (!app.isPackaged || settings.update?.check === false) return;
  setTimeout(async () => {
    const found = await updates.checkForUpdate(app.getVersion());
    if (!found || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('app:update', found);
  }, 6000).unref();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
