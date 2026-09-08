'use strict';

/**
 * Notes are UTF-8.
 *
 * A file that is not UTF-8 is refused rather than opened. Reading one without
 * decoding it shows mojibake, and then a save writes that mojibake into the
 * file — worse than not opening it at all. Converting other people's files is
 * not this program's job; saying plainly that it cannot read one is.
 *
 * The check needs nothing but what Node already has. TextDecoder in fatal mode
 * refuses any byte sequence that is not UTF-8, which catches both a note that
 * declares another encoding and one that declares nothing and simply is not
 * UTF-8. That is a stricter test than guessing at the bytes, and it cannot be
 * wrong about a file it accepts.
 */

const DECLARED = /charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)/i;

/** What the file says it is, or null when it says nothing. */
function declaredCharset(buf) {
  const head = buf.slice(0, Math.min(buf.length, 4096)).toString('latin1');
  const match = head.match(DECLARED);
  return match ? match[1].toLowerCase() : null;
}

function notUtf8(name) {
  const err = new Error(name
    ? `이 노트는 ${name.toUpperCase()} 로 저장되어 있습니다. UTF-8 로 변환한 뒤 열어 주십시오.`
    : '이 노트는 UTF-8 이 아닙니다. UTF-8 로 변환한 뒤 열어 주십시오.');
  err.code = 'NOT_UTF8';
  return err;
}

function decodeBuffer(buf) {
  const declared = declaredCharset(buf);
  if (declared && declared !== 'utf-8' && declared !== 'utf8') throw notUtf8(declared);

  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw notUtf8(declared);
  }
  // A byte-order mark is UTF-8, and belongs to the file rather than the text.
  return { html: html.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
}

function encodeDocument(html) {
  return Buffer.from(html, 'utf8');
}

module.exports = { decodeBuffer, encodeDocument, declaredCharset };
