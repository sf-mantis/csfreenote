'use strict';

/**
 * Files that belong to a note.
 *
 * Each note gets a folder of its own under the book's `_files`, mirroring the
 * tree the way `_backup` does. The folder's contents *are* the attachment
 * list — there is no manifest, so there is nothing to fall out of step with
 * what is actually on disk, and copying the book folder carries the files
 * along with the notes.
 *
 * This is deliberately not where pasted images go. Those live once in
 * `_images`, keyed by content, because they are part of the text: two notes
 * pasting the same picture want one file. An attachment is the opposite — it
 * belongs to one note, it exists whether or not the text mentions it, and
 * deleting it from that note should mean deleting it. Same kind of bytes, two
 * different lifetimes, two different places.
 *
 * Electron-free: path arithmetic and fs only, so node can exercise it.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ATTACH_DIR = '_files';

const NOTE_EXT = /\.html?$/i;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/** Resolve inside the book, refusing anything that climbs out of it. */
function safeJoin(root, relative) {
  const cleaned = String(relative || '').replace(/\\/g, '/');
  const full = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (!full.startsWith(rootResolved + path.sep) && full !== rootResolved) {
    throw new Error('Path outside book data directory');
  }
  return full;
}

/**
 * Where a note keeps its files, as a book-relative path.
 *
 * The note's extension is dropped so the folder reads as a name in Explorer
 * rather than as a stray document. That leaves one collision — `기록.htm` and
 * `기록.html` side by side would answer to the same folder — which `collides`
 * below exists to catch rather than to let two notes quietly share a drawer.
 */
function attachRelative(noteRelative) {
  const clean = String(noteRelative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) throw new Error('노트 경로가 없습니다.');
  return `${ATTACH_DIR}/${clean.replace(NOTE_EXT, '')}`;
}

/** The same, as a real path. */
function attachDir(bookDir, noteRelative) {
  return safeJoin(bookDir, attachRelative(noteRelative));
}

/**
 * Another note in the same folder that would share this note's drawer.
 *
 * Returns its name, or null when there is no such note. Checked before the
 * first file is put in, which is the last moment the answer is still cheap.
 */
function collides(bookDir, noteRelative) {
  const clean = String(noteRelative).replace(/\\/g, '/');
  const dir = path.dirname(safeJoin(bookDir, clean));
  const mine = path.basename(clean);
  const stem = mine.replace(NOTE_EXT, '');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === mine) continue;
    if (!NOTE_EXT.test(entry.name)) continue;
    if (entry.name.replace(NOTE_EXT, '') === stem) return entry.name;
  }
  return null;
}

/** True for a name whose bytes we can show in the preview pane. */
function isImage(name) {
  return IMAGE_EXT.has(path.extname(String(name)).toLowerCase());
}

/**
 * A file name that is safe to write and keeps its meaning.
 *
 * Whatever the OS handed us, only the base name is kept — a name is not a
 * path, and one arriving with separators in it is either a mistake or an
 * attempt. Characters Windows refuses are replaced rather than dropped so two
 * different names do not collapse into one.
 */
function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return cleaned || '파일';
}

/** `도면.png` beside an existing `도면.png` becomes `도면 (2).png`. */
function freeName(dir, name) {
  const safe = safeName(name);
  if (!fs.existsSync(path.join(dir, safe))) return safe;
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  for (let n = 2; n < 1000; n += 1) {
    const next = `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, next))) return next;
  }
  throw new Error('같은 이름이 너무 많습니다.');
}

/**
 * What this note has attached.
 *
 * A note with no drawer has no attachments, which is not an error — most
 * notes never get one. Sorted by name so the list does not reshuffle itself
 * between visits.
 */
async function listAttachments(bookDir, noteRelative) {
  const dir = attachDir(bookDir, noteRelative);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = await fsp.stat(path.join(dir, entry.name));
    } catch {
      continue;
    }
    out.push({ name: entry.name, bytes: stat.size, image: isImage(entry.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/**
 * The href a note refers one of its own files by.
 *
 * Relative to the note's own folder, like every other link a note carries, so
 * that opening the file in a browser with the program gone still finds it.
 * Percent-encoded per segment: these names come from the user's disk and will
 * contain spaces and Korean.
 */
function hrefFor(noteRelative, fileName) {
  const clean = String(noteRelative).replace(/\\/g, '/');
  const noteDir = path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean);
  const target = `${attachRelative(clean)}/${safeName(fileName)}`;
  const relative = path.posix.relative(noteDir || '.', target);
  return relative.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * Carry a note's files to its new name or folder.
 *
 * Modelled on how the backup follows a note, and for the same reason: the
 * drawer belongs to the note, not to the place the note used to sit. Unlike
 * the backup, deleting a note does not empty it — the same rule pasted images
 * already live by, and an attachment is more likely to be the only copy.
 *
 * Whether the folder moved is the caller's business too, so the pair is
 * returned for the link rewrite that has to follow.
 */
async function relocate(bookDir, fromNote, toNote) {
  const from = attachRelative(fromNote);
  const to = attachRelative(toNote);
  if (from === to) return null;

  const fromFull = attachDir(bookDir, fromNote);
  if (fs.existsSync(fromFull)) {
    const toFull = attachDir(bookDir, toNote);
    await fsp.mkdir(path.dirname(toFull), { recursive: true });
    // A drawer already standing at the new name would be the new note's own.
    // Merging two sets of files silently is worse than leaving this one where
    // it is, so nothing moves and the links keep pointing at what they had.
    if (fs.existsSync(toFull)) return null;
    await fsp.rename(fromFull, toFull);
    await pruneDirs(bookDir, path.dirname(fromFull));
  }
  return { from, to };
}

/** Drop attachment folders that no longer hold anything. */
async function pruneDirs(bookDir, dir) {
  const root = path.join(path.resolve(bookDir), ATTACH_DIR);
  let current = dir;
  while (current.startsWith(root) && current !== root) {
    try {
      if ((await fsp.readdir(current)).length) return;
      await fsp.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

module.exports = {
  ATTACH_DIR,
  attachRelative,
  attachDir,
  collides,
  isImage,
  safeName,
  freeName,
  listAttachments,
  hrefFor,
  relocate,
};
