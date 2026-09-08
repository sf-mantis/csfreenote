'use strict';

/**
 * Application settings.
 *
 * Settings live in JSON. An earlier build kept them in an INI: flat keys, one
 * book per [DataDirN] section, written in the system code page. That shape
 * carries neither a list of books nor nine text-format presets well, so an
 * INI left over from then is read once and converted, and nothing is lost on
 * the way across.
 *
 * Free of Electron so the verification harness runs the same code the app does.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FILE_NAME = 'csFreeNote.json';
const LEGACY_FILE_NAME = 'csFreeNote.ini';
const VERSION = 1;

const FORMAT_COUNT = 9;

/**
 * Ctrl-1 … Ctrl-9 apply a saved text format.
 *
 * Every field may be left blank, meaning "leave this alone" — a preset that
 * only sets a colour should not also drag the font back to a default.
 */
function defaultFormats() {
  const blank = {
    label: '', font: '', size: 0, color: '', highlight: '',
    bold: null, italic: null, underline: null, align: '',
  };
  const presets = [
    { label: '본문', font: '맑은 고딕', size: 3, color: '#222222', bold: false },
    { label: '작게', size: 2 },
    { label: '크게', size: 5 },
    { label: '굵게', bold: true },
    { label: '파랑 강조', color: '#3c62c6', bold: true },
    { label: '빨강 강조', color: '#a33333', bold: true },
    { label: '형광펜', highlight: '#fff2a8' },
    { label: '가운데', align: 'center' },
    { label: '오른쪽', align: 'right' },
  ];
  return presets.map((preset) => ({ ...blank, ...preset }));
}

const ALIGNMENTS = ['', 'left', 'center', 'right'];

function normaliseFormat(raw, fallback) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const hex = (value) => (/^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value).toLowerCase() : '');
  const tri = (value) => (value === true || value === false ? value : null);
  const size = Math.round(Number(input.size));
  return {
    label: String(input.label ?? fallback.label).slice(0, 20),
    font: String(input.font ?? '').slice(0, 60),
    size: Number.isFinite(size) && size >= 1 && size <= 7 ? size : 0,
    color: hex(input.color),
    highlight: hex(input.highlight),
    bold: tri(input.bold),
    italic: tri(input.italic),
    underline: tri(input.underline),
    align: ALIGNMENTS.includes(input.align) ? input.align : '',
  };
}

function defaults() {
  return {
    version: VERSION,
    books: [{ name: '기본 폴더', dir: 'BookData', shared: false }],
    activeBook: 0,
    window: {
      width: 1280, height: 800, left: null, top: null, maximized: true,
      startAs: 'restore',
      minimizeToTray: false,
    },
    ui: { theme: 'dark', treeWidth: 260, lastPage: '', searchWholeBook: false },
    editor: {
      autosaveMs: 700, startMode: 'browse', template: '기본 양식',
      returnToBrowse: true,
      dateFormat: 'yyyy-mm-dd hh:nn:ss dddd',
      tableEditing: false,
    },
    // Telling someone a new version exists costs one request at startup and
    // nothing after. It is off only for those who would rather not be asked.
    update: { check: true },
    formats: defaultFormats(),
  };
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** A book inside the app folder is stored relative, so the folder can move. */
function storedDir(dataRoot, dir) {
  const relative = path.relative(path.resolve(dataRoot), dir);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : dir;
}

function resolveDir(dataRoot, dir) {
  return path.resolve(dataRoot, String(dir || '').split('/').join(path.sep));
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** A hand-edited file may hold 0, "false" or nothing at all for a flag. */
const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return !/^(false|0|no|off)$/i.test(value.trim());
  return Boolean(value);
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Bring anything that was read off disk back to a shape the app can rely on.
 * A settings file people can hand-edit will eventually be hand-edited.
 */
function normalise(raw) {
  const base = defaults();
  const input = raw && typeof raw === 'object' ? raw : {};

  const books = Array.isArray(input.books)
    ? input.books
      .filter((b) => b && typeof b.dir === 'string' && b.dir.trim())
      .map((b) => ({
        name: String(b.name || '').trim() || '노트 폴더',
        dir: b.dir.trim(),
        shared: flag(b.shared, false),
      }))
    : [];

  const config = {
    version: VERSION,
    books: books.length ? books : base.books,
    activeBook: 0,
    window: {
      width: clampInt(input.window?.width, 400, 20000, base.window.width),
      height: clampInt(input.window?.height, 300, 20000, base.window.height),
      left: Number.isFinite(Number(input.window?.left)) && input.window?.left !== null
        ? Math.round(Number(input.window.left)) : null,
      top: Number.isFinite(Number(input.window?.top)) && input.window?.top !== null
        ? Math.round(Number(input.window.top)) : null,
      maximized: flag(input.window?.maximized, true),
      startAs: input.window?.startAs === 'maximized' ? 'maximized' : 'restore',
      // Off unless asked for: an app that vanishes from the taskbar when
      // minimised is a surprise, not a feature.
      minimizeToTray: flag(input.window?.minimizeToTray, false),
    },
    ui: {
      theme: input.ui?.theme === 'light' ? 'light' : 'dark',
      treeWidth: clampInt(input.ui?.treeWidth, 180, 480, base.ui.treeWidth),
      lastPage: String(input.ui?.lastPage || ''),
      searchWholeBook: flag(input.ui?.searchWholeBook, false),
    },
    editor: {
      autosaveMs: clampInt(input.editor?.autosaveMs, 300, 600000, base.editor.autosaveMs),
      startMode: input.editor?.startMode === 'edit' ? 'edit' : 'browse',
      template: String(input.editor?.template ?? base.editor.template),
      // Leaving edit mode on when moving to another note is how a stray
      // keystroke ends up in a note nobody meant to change.
      returnToBrowse: flag(input.editor?.returnToBrowse, true),
      // Off unless asked for. 노트 양식 keeps the whole note inside a layout
      // table, so the row and column controls would hover over ordinary
      // writing there — and one of them deletes a row.
      tableEditing: flag(input.editor?.tableEditing, false),
      dateFormat: String(input.editor?.dateFormat ?? base.editor.dateFormat).slice(0, 80)
        || base.editor.dateFormat,
    },
    update: {
      check: flag(input.update?.check, true),
    },
  };

  const fallback = defaultFormats();
  config.formats = Array.from({ length: FORMAT_COUNT }, (_, i) =>
    normaliseFormat(Array.isArray(input.formats) ? input.formats[i] : null, fallback[i]));

  config.activeBook = clampInt(input.activeBook, 0, config.books.length - 1, 0);
  return config;
}

/* ------------------------------------------------------------------ *
 * Legacy INI
 * ------------------------------------------------------------------ */

function parseIni(text) {
  const sections = {};
  let current = '';
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const header = trimmed.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1];
      sections[current] = sections[current] || {};
      continue;
    }
    const at = trimmed.indexOf('=');
    if (at < 0) continue;
    (sections[current] = sections[current] || {})[trimmed.slice(0, at).trim()] =
      trimmed.slice(at + 1).trim();
  }
  return sections;
}

/** Convert the older INI shape into the current settings object. */
function fromIni(text) {
  const sections = parseIni(text);
  const program = sections.PROGRAM || {};

  const books = [];
  for (let n = 1; n <= 32; n += 1) {
    const section = sections[`DataDir${n}`];
    if (!section || !section.dir) continue;
    books.push({
      name: String(section.Name || `노트 폴더 ${n}`).trim() || `노트 폴더 ${n}`,
      dir: String(section.dir).trim(),
      shared: section.shared === '1' || /^(1|true|yes)$/i.test(String(section.share || '')),
    });
  }

  return normalise({
    books,
    activeBook: 0,
    window: {
      width: program.Width, height: program.Height,
      left: program.Left === '' ? null : program.Left,
      top: program.Top === '' ? null : program.Top,
      maximized: program.Maximized !== '0',
    },
    ui: {
      theme: program.theme,
      treeWidth: program.TreeWidth,
      // The INI wrote note paths with backslashes.
      lastPage: String(program.lstPage || '').replace(/\\/g, '/'),
    },
  });
}

/* ------------------------------------------------------------------ *
 * Load and save
 * ------------------------------------------------------------------ */

function configPath(dataRoot) {
  return path.join(dataRoot, FILE_NAME);
}

/**
 * Read settings, converting an old INI the first time and removing it once the
 * JSON has been written — two settings files, only one of them read, is the
 * kind of thing that wastes an afternoon later.
 *
 * @returns {{config: object, migrated: boolean}}
 */
function load(dataRoot) {
  const file = configPath(dataRoot);

  if (fs.existsSync(file)) {
    try {
      return { config: normalise(JSON.parse(fs.readFileSync(file, 'utf8'))), migrated: false };
    } catch (err) {
      // A corrupt settings file must not stop the app from opening.
      try {
        fs.renameSync(file, `${file}.broken`);
      } catch { /* nothing more to do */ }
      return { config: defaults(), migrated: false, recovered: String(err.message || err) };
    }
  }

  const legacy = path.join(dataRoot, LEGACY_FILE_NAME);
  if (fs.existsSync(legacy)) {
    try {
      const config = fromIni(fs.readFileSync(legacy, 'utf8'));
      save(dataRoot, config);
      try {
        fs.unlinkSync(legacy);
      } catch { /* leave it; the JSON is what gets read now */ }
      return { config, migrated: true };
    } catch {
      return { config: defaults(), migrated: false };
    }
  }

  const config = defaults();
  save(dataRoot, config);
  return { config, migrated: false };
}

function save(dataRoot, config) {
  const file = configPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalise(config), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

async function saveAsync(dataRoot, config) {
  const file = configPath(dataRoot);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(normalise(config), null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

/* ------------------------------------------------------------------ *
 * Books
 * ------------------------------------------------------------------ */

function activeBook(config) {
  return config.books[config.activeBook] || config.books[0];
}

module.exports = {
  FILE_NAME,
  LEGACY_FILE_NAME,
  defaults,
  defaultFormats,
  normalise,
  FORMAT_COUNT,
  fromIni,
  parseIni,
  load,
  save,
  saveAsync,
  configPath,
  storedDir,
  resolveDir,
  activeBook,
};
