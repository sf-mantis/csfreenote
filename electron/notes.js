'use strict';

/**
 * The note write path, free of Electron so the verification harness exercises
 * exactly the code the app runs.
 *
 * Saving a note never rebuilds the document. It reads the file that is on
 * disk right now, splices the new body into it, refuses the write if that
 * would annihilate structure the note had, keeps a backup, and only then
 * replaces the file atomically.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const doc = require('./document');
const { decodeBuffer, encodeDocument } = require('./encoding');
const { rewriteLinks } = require('./links');

/** Resolve a book-relative path, refusing anything that escapes the book. */
function safeJoin(root, relativePath) {
  const cleaned = String(relativePath || '').replace(/\\/g, '/');
  const full = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (!full.startsWith(rootResolved + path.sep) && full !== rootResolved) {
    throw new Error('Path outside book data directory');
  }
  return full;
}

async function writeFileAtomic(full, data) {
  const tmp = `${full}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  // Rename is atomic on NTFS, so a power cut leaves either the old file or
  // the new one — never a half-written note.
  await fsp.rename(tmp, full);
}

// Backups live in one folder rather than beside every note, so the book stays
// readable in Explorer.
const BACKUP_DIR = '_backup';

/** Where a note's backup lives: the same path, under _backup/. */
function backupPath(bookDir, relativePath) {
  const cleaned = String(relativePath || '').replace(/\\/g, '/');
  return path.join(path.resolve(bookDir), BACKUP_DIR, ...cleaned.split('/'));
}

/**
 * Backups mirror the tree, so they have to follow it. A note that is renamed,
 * moved or deleted and leaves its backup behind turns that backup into an
 * orphan — and a later note at the same path would inherit it.
 */
async function relocateBackup(bookDir, fromRelative, toRelative) {
  const from = backupPath(bookDir, fromRelative);
  if (!fs.existsSync(from)) return;
  if (!toRelative) {
    await fsp.rm(from, { recursive: true, force: true });
    await pruneBackupDirs(bookDir, path.dirname(from));
    return;
  }
  const to = backupPath(bookDir, toRelative);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { recursive: true, force: true });
  await fsp.rename(from, to);
  await pruneBackupDirs(bookDir, path.dirname(from));
}

/** Drop backup folders that no longer hold anything. */
async function pruneBackupDirs(bookDir, dir) {
  const root = path.join(path.resolve(bookDir), BACKUP_DIR);
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

/**
 * Keep the last known-good version of a note, mirroring its path under
 * _backup/. One generation is enough: it is the version to fall back to when
 * a save turns out to have been a mistake.
 */
async function backupBeforeWrite(bookDir, full, currentBuffer) {
  const relative = path.relative(path.resolve(bookDir), full);
  const target = path.join(path.resolve(bookDir), BACKUP_DIR, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, currentBuffer);
}

/** Remove a note or folder's backup, used when the original is deleted. */
async function dropBackup(bookDir, relativePath) {
  await relocateBackup(bookDir, relativePath, null);
}

async function readNote(bookDir, relativePath) {
  const full = safeJoin(bookDir, relativePath);
  const buf = await fsp.readFile(full);
  const { html, encoding } = decodeBuffer(buf);
  const stat = await fsp.stat(full);
  return {
    bytes: stat.size,
    relativePath: String(relativePath).replace(/\\/g, '/'),
    fullPath: full,
    // Relative links inside a note resolve against the note's own folder.
    baseUrl: `${pathToFileURL(path.dirname(full)).href}/`,
    html,
    body: doc.extractBody(html),
    encoding,
    mtime: stat.mtimeMs,
  };
}

/**
 * @param {object} req
 * @param {string} req.bookDir        book data root
 * @param {string} req.relativePath   note path inside the book
 * @param {string} [req.body]         new <body> contents (edit mode)
 * @param {string} [req.html]         whole document (source mode)
 * @param {boolean} [req.fullDocument] true when `html` is the whole document
 * @param {number} [req.baseMtime]    mtime the editor last saw
 * @param {boolean} [req.force]       write even if the guard objects
 * @returns {Promise<{ok:boolean, reason?:string, message?:string, mtime?:number}>}
 */
/**
 * Is this the body the file already holds?
 *
 * Compared after both have been through the same formatting, so a note whose
 * blocks happen to be laid out differently is not rewritten just to restyle it.
 * Opening a file still never touches it; the layout is only applied once the
 * content itself changes.
 */
function sameBody(next, current) {
  if (next === current) return true;
  return next === doc.breakBlocks(current);
}

async function writeNote(req) {
  const {
    bookDir, relativePath, html, body, fullDocument, baseMtime, force,
  } = req;

  const full = safeJoin(bookDir, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });

  const exists = fs.existsSync(full);
  let currentBuffer = null;
  let currentDoc = '';

  if (exists) {
    const stat = await fsp.stat(full);
    if (Number.isFinite(baseMtime) && Math.abs(stat.mtimeMs - baseMtime) > 1 && !force) {
      return {
        ok: false,
        reason: 'conflict',
        message: '이 노트가 csFreeNote 밖에서 바뀌었습니다. 다시 불러온 뒤 편집하세요.',
        mtime: stat.mtimeMs,
      };
    }
    currentBuffer = await fsp.readFile(full);
    currentDoc = decodeBuffer(currentBuffer).html;
  }

  // Editor output arrives as one line. Break it up before anything else so
  // that the comparison below is against what would actually be written.
  // Source mode is left alone — that HTML was typed by hand.
  const bodyOut = doc.breakBlocks(String(body ?? '').trim());

  // Nothing actually changed — leave the file, and its timestamp, alone.
  if (exists) {
    const unchanged = fullDocument
      ? String(html ?? '') === currentDoc
      : sameBody(bodyOut, doc.extractBody(currentDoc).trim());
    if (unchanged) {
      const stat = await fsp.stat(full);
      return {
        ok: true, unchanged: true, html: currentDoc,
        bytes: stat.size, mtime: stat.mtimeMs,
      };
    }
  }

  let outHtml;
  if (fullDocument) {
    outHtml = html ?? '';
  } else if (exists && doc.hasBody(currentDoc)) {
    outHtml = doc.replaceBody(currentDoc, `\n${bodyOut}\n`);
  } else {
    outHtml = doc.wrapDocument(bodyOut || html || '');
  }

  // Source mode hands us hand-typed HTML. If it no longer has a <body> the
  // note stops being spliceable, and the next edit-mode save would rebuild the
  // document from scratch — losing the <head>, its stylesheet and everything
  // splicing was there to protect. Catch it here, while the file is still good.
  if (exists && fullDocument && !force
      && doc.hasBody(currentDoc) && !doc.hasBody(outHtml)) {
    return {
      ok: false,
      reason: 'malformed',
      message: '저장을 중단했습니다 — <body> 태그를 찾을 수 없습니다. 여는/닫는 태그를 확인하세요.',
      mtime: (await fsp.stat(full)).mtimeMs,
    };
  }

  if (exists && !force) {
    const verdict = doc.inspectWrite(doc.extractBody(currentDoc), doc.extractBody(outHtml));
    if (!verdict.safe) {
      return {
        ok: false,
        reason: 'loss',
        message: `저장을 중단했습니다 — 원본 구조가 사라집니다 (${doc.describeReasons(verdict.reasons)}).`,
        reasons: verdict.reasons,
        mtime: (await fsp.stat(full)).mtimeMs,
      };
    }
  }

  if (exists) await backupBeforeWrite(bookDir, full, currentBuffer);
  const data = encodeDocument(outHtml);
  await writeFileAtomic(full, data);

  // Hand back what was actually written so the source view can show the file
  // as it now is, without re-reading it.
  const stat = await fsp.stat(full);
  return { ok: true, html: outHtml, bytes: stat.size, mtime: stat.mtimeMs };
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

// Windows reserves these regardless of extension: CON.html is not creatable.
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const ILLEGAL = /[<>:"/\\|?*]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_NAME = 120;

/**
 * Check a name the user typed, before it becomes a file name.
 *
 * Rejects rather than silently rewriting: Windows quietly drops trailing dots
 * and spaces, so a name that looks accepted would land on disk as something
 * else and the path the app hands back would not match the file.
 *
 * @returns {{ok: true, name: string} | {ok: false, message: string}}
 */
function validateName(raw, { isFolder = false } = {}) {
  const name = String(raw ?? '').trim();
  const what = isFolder ? '폴더' : '노트';

  if (!name) return { ok: false, message: `${what} 이름을 입력하세요.` };
  if (CONTROL.test(name)) return { ok: false, message: '이름에 제어 문자를 쓸 수 없습니다.' };
  if (ILLEGAL.test(name)) {
    return { ok: false, message: '이름에 \\ / : * ? " < > | 를 쓸 수 없습니다.' };
  }
  if (/[.\s]$/.test(name)) {
    return { ok: false, message: '이름 끝에 점이나 공백을 쓸 수 없습니다.' };
  }
  if (RESERVED.test(name.replace(/\.[^.]*$/, ''))) {
    return { ok: false, message: `'${name}' 은(는) 윈도우가 예약한 이름입니다.` };
  }
  if (name.length > MAX_NAME) {
    return { ok: false, message: `이름이 너무 깁니다 (${name.length}자, 최대 ${MAX_NAME}자).` };
  }
  return { ok: true, name };
}

/**
 * Follow a path through a rename, a move or a deletion.
 *
 * Returns the new path, or '' when the item is gone. Anything under the moved
 * path moves with it, which an exact-match check missed: deleting a folder
 * left the remembered page addressing a note inside it.
 */
function remapPath(current, fromRelative, toRelative) {
  const from = String(fromRelative || '').replace(/\\/g, '/');
  const here = String(current || '').replace(/\\/g, '/');
  if (!from || !here) return here;

  if (here !== from && !here.startsWith(`${from}/`)) return here;
  return toRelative ? toRelative + here.slice(from.length) : '';
}

/** Pick a name that does not collide, appending " (2)", " (3)" … */
function uniqueName(dir, base, ext = '') {
  let candidate = path.join(dir, base + ext);
  let n = 1;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

const NOTE_EXT = /\.html?$/i;

/**
 * Move or copy a note or folder into another folder.
 *
 * Refuses to drop a folder inside itself, which would otherwise delete the
 * subtree being moved. Name collisions get a numbered suffix rather than
 * silently overwriting an existing note.
 */
async function moveItem(bookDir, { relativePath, targetFolder, copy = false }) {
  const source = safeJoin(bookDir, relativePath);
  const destDir = targetFolder ? safeJoin(bookDir, targetFolder) : path.resolve(bookDir);

  if (!fs.existsSync(source)) throw new Error('원본을 찾을 수 없습니다.');
  if (!fs.existsSync(destDir)) throw new Error('대상 폴더를 찾을 수 없습니다.');

  const stat = await fsp.stat(source);
  const resolvedDest = path.resolve(destDir);

  if (path.dirname(source) === resolvedDest) {
    return { ok: false, reason: 'same', message: '이미 그 폴더에 있습니다.' };
  }
  if (stat.isDirectory() && (resolvedDest === source || resolvedDest.startsWith(source + path.sep))) {
    return { ok: false, reason: 'descendant', message: '폴더를 자기 자신의 하위로 옮길 수 없습니다.' };
  }

  const base = path.basename(source);
  const ext = stat.isDirectory() ? '' : (base.match(NOTE_EXT) || [''])[0];
  const stem = ext ? base.slice(0, -ext.length) : base;
  const target = uniqueName(resolvedDest, stem, ext);

  const targetRelative = path.relative(path.resolve(bookDir), target)
    .split(path.sep).join('/');

  if (copy) {
    await fsp.cp(source, target, { recursive: true });
  } else {
    await fsp.rename(source, target);
    // The backup belongs to the note, not to the place it used to sit.
    await relocateBackup(bookDir, relativePath, targetRelative);
  }

  // A note's own links are relative to its folder, so the folder changing is
  // the links changing meaning. Done after the move, on what is now there.
  const relinked = await relinkMoved(bookDir, relativePath, targetRelative);

  return { ok: true, relativePath: targetRelative, relinked };
}

/** Every note under a book-relative folder, skipping the hidden folders. */
async function listNotes(bookDir, folderRelative) {
  const out = [];
  const walk = async (relative) => {
    const full = safeJoin(bookDir, relative);
    for (const entry of await fsp.readdir(full, { withFileTypes: true })) {
      if (entry.name === BACKUP_DIR || entry.name === ASSET_DIR) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (NOTE_EXT.test(entry.name)) out.push(next);
    }
  };
  await walk(folderRelative);
  return out;
}

/**
 * Fix the links of everything that just moved.
 *
 * No backup is taken. Every other write to a note keeps one, but this write
 * differs from the file it replaces only inside attribute values, and taking
 * the slot would spend the user's one previous version on a drag of the mouse.
 * Losing a real earlier draft to a tidy-up is worse than not being able to
 * undo a link repair.
 *
 * A note that cannot be read or written is left alone: the move itself has
 * already happened and is not worth failing over a picture.
 */
async function relinkMoved(bookDir, fromRelative, toRelative) {
  const pairs = [];
  const full = safeJoin(bookDir, toRelative);
  if ((await fsp.stat(full)).isDirectory()) {
    for (const now of await listNotes(bookDir, toRelative)) {
      pairs.push([`${fromRelative}/${now.slice(toRelative.length + 1)}`, now]);
    }
  } else if (NOTE_EXT.test(toRelative)) {
    pairs.push([fromRelative, toRelative]);
  }

  const dirOf = (relative) => {
    const cut = relative.lastIndexOf('/');
    return cut === -1 ? '' : relative.slice(0, cut);
  };

  let changed = 0;
  for (const [was, now] of pairs) {
    try {
      /* eslint-disable no-await-in-loop */
      const file = safeJoin(bookDir, now);
      const { html } = decodeBuffer(await fsp.readFile(file));
      const next = rewriteLinks(html, dirOf(was), dirOf(now));
      if (next === html) continue;
      await writeFileAtomic(file, encodeDocument(next));
      changed += 1;
    } catch {
      // Unreadable, or not UTF-8. The move stands.
    }
  }
  return changed;
}

// Pasted images live in the book so they travel with the notes; the folder is
// hidden from the tree the same way folder markers are.
const ASSET_DIR = '_images';

const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/**
 * Store an image pasted into a note and return the href to reference it by.
 *
 * The href is relative to the book root and the note document carries a
 * <base> pointing at its own folder, so it keeps resolving when the whole
 * folder is moved to another machine.
 */
async function saveImage(bookDir, { relativePath, mimeType, data }) {
  const ext = IMAGE_EXT[String(mimeType).toLowerCase()];
  if (!ext) throw new Error(`지원하지 않는 이미지 형식입니다: ${mimeType}`);

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buffer.length) throw new Error('빈 이미지입니다.');

  const dir = path.join(path.resolve(bookDir), ASSET_DIR);
  await fsp.mkdir(dir, { recursive: true });

  // Content hash: pasting the same picture twice reuses one file.
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const full = path.join(dir, hash + ext);
  if (!fs.existsSync(full)) await writeFileAtomic(full, buffer);

  // Href is relative to the note's own folder, which is what <base> resolves.
  const noteDir = path.dirname(safeJoin(bookDir, relativePath || 'x.html'));
  const href = path.relative(noteDir, full).split(path.sep).join('/');
  return { href, bytes: buffer.length, fileName: hash + ext };
}

module.exports = {
  safeJoin,
  readNote,
  writeNote,
  writeFileAtomic,
  backupBeforeWrite,
  relocateBackup,
  dropBackup,
  backupPath,
  BACKUP_DIR,
  moveItem,
  relinkMoved,
  listNotes,
  saveImage,
  validateName,
  remapPath,
  uniqueName,
  ASSET_DIR,
};
