'use strict';

/**
 * Keep a note's own links pointing at the same files after it moves.
 *
 * A pasted image is stored once in the book's `_images` and referenced by a
 * path relative to the note's own folder — `_images/ab12.png` from the root,
 * `../_images/ab12.png` from one folder down. That has to stay relative: the
 * promise is that a note opens in a browser with the program gone, and a
 * browser resolves against the file's own folder with no <base> to help it.
 *
 * So moving the note changes what its links mean. Before this, a note dragged
 * into a subfolder kept `_images/ab12.png` and started pointing at
 * `subfolder/_images/ab12.png`, which is nothing. The picture went blank and
 * the file it wanted was still sitting where it always was.
 *
 * The rewrite is string surgery on attribute values, not a reparse. Every
 * other byte of the document stays where it was, which is the same reason
 * saving splices <body> instead of rebuilding the file.
 *
 * Pure path arithmetic and text: no fs, no Electron.
 */

const path = require('path');

// Only inside a tag. A <style> block or ordinary prose that happens to
// contain "href=" is not markup and is left alone.
const TAG = /<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/g;
// The whitespace before the name is required, not decoration: a word boundary
// also sits after the hyphen in data-src, and that is somebody else's
// attribute to look after. srcset falls outside for the same reason, and is
// left alone deliberately — nothing here writes one.
const ATTR = /(\s(?:src|href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

// <base> says where everything else resolves from. Rewriting a link and its
// base would move the target twice.
const SKIP_TAG = /^<\s*base\b/i;

/** True for a link this has no business touching. */
function isFixed(url) {
  const text = String(url).trim();
  if (!text) return true;
  if (text.startsWith('#')) return true;      // same document
  if (text.startsWith('/')) return true;      // root- or protocol-relative
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text);  // has a scheme (http:, data:, file:)
}

/** Split "a/b.png?x=1#y" into its path and the rest. */
function splitUrl(url) {
  const cut = url.search(/[?#]/);
  return cut === -1 ? [url, ''] : [url.slice(0, cut), url.slice(cut)];
}

/** Percent-decode each segment. Null when the escaping is malformed. */
function decodePath(text) {
  try {
    return text.split('/').map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return null;
  }
}

/** Re-encode the way a browser would accept, segment by segment. */
function encodePath(text) {
  return text.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * The same target, expressed from a new folder.
 *
 * `fromDir` and `toDir` are the note's folder before and after, relative to
 * the book root ('' for the root itself). Returns null when the link should be
 * left exactly as it is — fixed, malformed, or reaching outside the book,
 * where we cannot know what it meant.
 */
function relink(url, fromDir, toDir) {
  if (isFixed(url)) return null;

  const [body, rest] = splitUrl(String(url));
  const decoded = decodePath(body);
  if (decoded === null || !decoded) return null;

  // Where it points now, as a book-relative path.
  const target = path.posix.normalize(path.posix.join(fromDir || '.', decoded));
  if (target === '..' || target.startsWith('../')) return null;   // outside the book

  const next = path.posix.relative(toDir || '.', target);
  if (!next) return null;

  const encoded = encodePath(next) + rest;
  return encoded === String(url) ? null : encoded;
}

/**
 * Rewrite every relative link in the document for the note's new folder.
 *
 * Returns the document unchanged — the same string — when nothing needed to
 * move, so a caller can tell without comparing and skip the write.
 */
function rewriteLinks(html, fromDir, toDir) {
  if (fromDir === toDir) return String(html);

  return String(html).replace(TAG, (tag) => {
    if (SKIP_TAG.test(tag)) return tag;
    return tag.replace(ATTR, (whole, lead, dq, sq, bare) => {
      const value = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
      const next = relink(value, fromDir, toDir);
      if (next === null) return whole;
      if (dq !== undefined) return `${lead}"${next}"`;
      if (sq !== undefined) return `${lead}'${next}'`;
      return `${lead}"${next}"`;   // an unquoted value may gain characters
    });
  });
}

module.exports = { isFixed, relink, rewriteLinks };
