'use strict';

/**
 * Save-pipeline verification.
 *
 * Runs the real read → splice → guard → encode path over a corpus of notes
 * without launching Electron and without writing to any of them. What it
 * proves, per note:
 *
 *   1. round-trip     an unchanged body splices back to a byte-identical file
 *   2. head preserved a real edit leaves <head>, <body> attributes and the
 *                     bytes after </body> untouched
 *   3. edit accepted   an ordinary edit passes the loss guard
 *   4. flatten blocked a schema-style flatten is refused by the guard
 *   5. encoding        decode → encode reproduces the original bytes
 *
 * Usage: node test/verify-save.js [corpus-dir ...]
 *        CSFREENOTE_CORPUS=<dir> node test/verify-save.js
 */

const fs = require('fs');
const path = require('path');

const doc = require('../electron/document');
const { decodeBuffer, encodeDocument } = require('../electron/encoding');

const NOTE_EXT = /\.(htm|html)$/i;

let refused = 0;

const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Corpora to scan. The committed fixtures always run; point
 * CSFREENOTE_CORPUS at a real note folder (path.delimiter separated) to also
 * run the suite over your own notes.
 */
function corpora() {
  const extra = (process.env.CSFREENOTE_CORPUS || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return [FIXTURES, path.join(__dirname, '..', 'BookData'), ...extra];
}

function collect(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (NOTE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** What a schema-based editor does: throw away everything it cannot model. */
function flattenToSchema(bodyHtml) {
  const text = bodyHtml
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/<\/(?:p|div|tr|li|h[1-6])\s*>/i)
    .map((chunk) => chunk.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return text.map((line) => `<p>${line}</p>`).join('');
}

const checks = [];
function check(name, note, ok, detail) {
  checks.push({ name, note, ok, detail });
}

function verifyNote(file, root) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const buffer = fs.readFileSync(file);

  let html;
  try {
    ({ html } = decodeBuffer(buffer));
  } catch (err) {
    // Point the app at somebody else's folder and this is what turns up. The
    // scan has to say so and carry on, not stop on the first one.
    check('refused', rel, err && err.code === 'NOT_UTF8', err && err.message);
    refused += 1;
    return;
  }

  // 5. encoding round-trip
  // 5. the bytes come back as they went in
  check('encoding', rel, encodeDocument(html).equals(buffer), `${buffer.length} B`);

  if (!doc.hasBody(html)) {
    check('has-body', rel, false, 'no <body> — would fall back to a new document');
    return;
  }

  const body = doc.extractBody(html);

  // 1. unchanged body must reproduce the file exactly
  const identity = doc.replaceBody(html, body);
  check('round-trip', rel, identity === html,
    identity === html ? '' : `${html.length} → ${identity.length} chars`);

  // 2. + 3. an ordinary edit
  const editedBody = `${body}\n<p>추가된 문단</p>`;
  const edited = doc.replaceBody(html, editedBody);
  const headBefore = html.slice(0, html.search(/<body\b/i));
  const headAfter = edited.slice(0, edited.search(/<body\b/i));
  const tailBefore = html.slice(html.search(/<\/body\s*>/i));
  const tailAfter = edited.slice(edited.search(/<\/body\s*>/i));
  check('head-preserved', rel, headBefore === headAfter && tailBefore === tailAfter,
    headBefore === headAfter ? 'tail differs' : 'head differs');

  const editVerdict = doc.inspectWrite(body, doc.extractBody(edited));
  check('edit-accepted', rel, editVerdict.safe, doc.describeReasons(editVerdict.reasons));

  // 4. the destructive flatten must be refused — but only for notes that
  //    actually carry structure worth losing.
  const before = doc.documentStats(body);
  const carriesStructure =
    before.table >= 3 || before.span >= 3 || before.font >= 3 ||
    before.styleAttr >= 3 || before.image >= 3;
  if (carriesStructure) {
    const flatVerdict = doc.inspectWrite(body, flattenToSchema(body));
    check('flatten-blocked', rel, !flatVerdict.safe,
      flatVerdict.safe ? 'guard let it through' : doc.describeReasons(flatVerdict.reasons));
  }
}

function main() {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : corpora();
  let notes = 0;

  for (const root of roots) {
    const files = collect(root);
    if (!files.length) {
      console.log(`(건너뜀: ${root} — 노트 없음)`);
      continue;
    }
    console.log(`\n검사 대상: ${root}  (${files.length}개)`);
    for (const file of files) {
      verifyNote(file, root);
      notes += 1;
    }
  }

  const byName = new Map();
  for (const c of checks) {
    const entry = byName.get(c.name) || { pass: 0, fail: 0, failures: [] };
    if (c.ok) entry.pass += 1;
    else {
      entry.fail += 1;
      entry.failures.push(`${c.note}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    byName.set(c.name, entry);
  }

  console.log(`\n노트 ${notes}개 / 검사 ${checks.length}건\n`);
  let failed = 0;
  for (const [name, entry] of byName) {
    const mark = entry.fail === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${name.padEnd(16)} ${entry.pass}/${entry.pass + entry.fail}`);
    for (const f of entry.failures.slice(0, 8)) console.log(`          ${f}`);
    if (entry.failures.length > 8) console.log(`          … 외 ${entry.failures.length - 8}건`);
    failed += entry.fail;
  }

  console.log(failed === 0 ? '\n전부 통과' : `\n실패 ${failed}건`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
