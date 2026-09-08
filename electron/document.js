'use strict';

/**
 * Document surgery for csFreeNote notes.
 *
 * These notes are arbitrary legacy HTML: table layouts, <font>, inline
 * styles, a <head> carrying the note's own stylesheet. Saving must therefore
 * never rebuild the document — it replaces the contents of <body> and leaves
 * every other byte of the file exactly where it was.
 *
 * This module is deliberately free of Electron and fs so it can be exercised
 * directly by the verification harness.
 */

const BODY_RE = /(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i;

/** Inner HTML of <body>, or the whole document when it has no body element. */
function extractBody(html) {
  const match = String(html).match(BODY_RE);
  return match ? match[2] : String(html);
}

/** True when the document has a <body>…</body> pair we can splice into. */
function hasBody(html) {
  return BODY_RE.test(String(html));
}

/**
 * Replace only the contents of <body>, preserving the doctype, <head>,
 * the <body> tag's own attributes, and anything after </body>.
 *
 * The new inner content is spliced in verbatim — no trimming, no added
 * newlines — so passing back an unmodified body reproduces the file byte for
 * byte. Callers that supply freshly serialised markup add their own padding.
 *
 * Returns null when there is no body to splice — the caller decides what to do.
 */
function replaceBody(originalDoc, newBodyInner) {
  const doc = String(originalDoc);
  const match = doc.match(BODY_RE);
  if (!match) return null;
  const start = match.index;
  const [full, openTag, , closeTag] = match;
  return (
    doc.slice(0, start) +
    openTag +
    String(newBodyInner ?? '') +
    closeTag +
    doc.slice(start + full.length)
  );
}

/** Build a fresh document. Only ever used for notes csFreeNote itself creates. */
/** Every note starts from these. A template may add to them, not replace them. */
const BASE_CSS = [
  'body, td { font-size: 9pt; font-family: "Malgun Gothic", "맑은 고딕", sans-serif; line-height: 1.2; }',
  'p { margin: 0; }',
  'a { color: #4077a0; text-decoration: none; font-weight: bold; }',
  'a:hover { color: #990000; }',
];

/**
 * What a template says about its own appearance, beyond the rules every note
 * already has.
 *
 * A note keeps only its <body> after this: saving reads <body> and the head is
 * never written again. So whatever a template needs in the head has to be
 * carried across the moment the note is made, or it is lost — which is what
 * happened to the calendar, whose cell colours all live in one rule each.
 *
 * Rules the base already states are dropped rather than repeated. Templates are
 * standalone HTML and carry the full set so they look right opened on their own.
 */
function templateStyle(html) {
  const blocks = String(html).match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || [];
  const base = new Set(BASE_CSS.map((line) => line.trim()));
  const extra = [];
  for (const block of blocks) {
    const body = block.replace(/^<style\b[^>]*>/i, '').replace(/<\/style>$/i, '');
    for (const line of body.split('\n')) {
      const rule = line.trim();
      if (!rule || base.has(rule) || extra.includes(rule)) continue;
      extra.push(rule);
    }
  }
  return extra;
}

function wrapDocument(bodyInner, extraCss = []) {
  const css = [...BASE_CSS, ...extraCss].join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="generator" content="csFreeNote">
<style type="text/css">
${css}
</style>
</head>
<body>
${bodyInner}
</body>
</html>
`;
}

// Any <meta> that declares a charset, in either the http-equiv or the HTML5
// form, with attributes in either order.
const CHARSET_META = /<meta\b[^>]*charset\s*=\s*["']?[a-z0-9_-]+[^>]*>/gi;


/* ------------------------------------------------------------------ *
 * Loss detection
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (NAMED_ENTITIES[key] !== undefined) return NAMED_ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Visible text of a body fragment, whitespace removed so reflowing is invisible. */
function visibleText(bodyHtml) {
  return decodeEntities(
    String(bodyHtml)
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, '');
}

// Constructs that carry meaning a note author put there on purpose. An editor
// that cannot represent them will silently return zero of them.
const STRUCTURE = {
  table: /<table\b/gi,
  row: /<tr\b/gi,
  cell: /<t[dh]\b/gi,
  image: /<img\b/gi,
  anchor: /<a\s[^>]*href/gi,
  font: /<font\b/gi,
  span: /<span\b/gi,
  listItem: /<li\b/gi,
  heading: /<h[1-6]\b/gi,
  styleAttr: /\bstyle\s*=/gi,
  colorAttr: /\b(?:bg)?color\s*=/gi,
};

function documentStats(bodyHtml) {
  const html = String(bodyHtml);
  const stats = { textLength: visibleText(html).length };
  for (const [key, pattern] of Object.entries(STRUCTURE)) {
    stats[key] = (html.match(pattern) || []).length;
  }
  return stats;
}

// A note may legitimately lose a single table or a couple of spans while being
// edited. What must never happen is a construct being wiped out wholesale,
// which is the signature of an editor dropping what its schema cannot hold.
const WIPEOUT_FLOOR = 3;
const TEXT_SURVIVAL_RATIO = 0.5;
const TEXT_GUARD_FLOOR = 200;

/**
 * Compare the body about to be written against the body currently on disk.
 * Returns { safe, reasons, before, after }.
 */
function inspectWrite(previousBody, nextBody) {
  const before = documentStats(previousBody);
  const after = documentStats(nextBody);
  const reasons = [];

  for (const key of Object.keys(STRUCTURE)) {
    if (before[key] >= WIPEOUT_FLOOR && after[key] === 0) {
      reasons.push({ kind: key, before: before[key], after: 0 });
    }
  }

  if (
    before.textLength >= TEXT_GUARD_FLOOR &&
    after.textLength < before.textLength * TEXT_SURVIVAL_RATIO
  ) {
    reasons.push({ kind: 'text', before: before.textLength, after: after.textLength });
  }

  return { safe: reasons.length === 0, reasons, before, after };
}

const REASON_LABELS = {
  table: '표', row: '표 행', cell: '표 칸', image: '이미지', anchor: '링크',
  font: '글꼴 지정', span: '서식 구간', listItem: '목록 항목', heading: '제목',
  styleAttr: 'style 속성', colorAttr: '색 지정', text: '본문 텍스트',
};

function describeReasons(reasons) {
  return reasons
    .map((r) => `${REASON_LABELS[r.kind] || r.kind} ${r.before} → ${r.after}`)
    .join(', ');
}

// Block-level tags: whitespace between two of these is not rendered, so a
// newline can go there without changing how the note looks.
const BLOCK = 'p|div|table|thead|tbody|tfoot|tr|td|th|caption|colgroup'
  + '|ul|ol|li|dl|dt|dd|h[1-6]|blockquote|pre|hr|address'
  + '|section|article|aside|header|footer|nav|main'
  + '|form|fieldset|legend|center|figure|figcaption';

// String.raw, not a plain template: `\s` in one is just the letter s, which
// quietly turned the whitespace class into [s>/] and left every tag that
// carries an attribute — every real one — joined to its neighbour.
const BLOCK_TAG = new RegExp(String.raw`^</?(?:${BLOCK})(?=[\s>/])`, 'i');
const VOID_BLOCK = /^<(?:hr|col)\b/i;
const PRE_RUN = /<pre\b[\s\S]*?<\/pre\s*>/gi;
const TAG_OR_TEXT = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
const INDENT = '  ';

/**
 * Put each block on its own line.
 *
 * Chromium serialises siblings with nothing between them, so a note typed in
 * the editor comes back as one endless line and the source tab is unreadable.
 * Notes written by hand are not laid out that way, and a table made here
 * has three kinds of join to undo: `</p><table>` between siblings,
 * `<tbody><tr>` on the way in, and `</td></tr>` on the way out.
 *
 * Only the gap between two block-level tags is touched, which no renderer shows
 * — a run of block boxes lays out the same whether or not there is whitespace
 * between them — and `visibleText` strips whitespace before the loss guard
 * counts, so neither the page nor the guard can notice. Anything inside `<pre>`
 * is left exactly as it is, because there whitespace is the content.
 *
 * Whitespace that is already there is never rewritten: a note that came in
 * indented keeps its own shape, and only the joins get opened up. Idempotent
 * for the same reason.
 */
function breakBlocks(bodyInner) {
  const text = String(bodyInner ?? '');
  if (!text) return text;

  const split = (chunk) => {
    let out = '';
    let depth = 0;
    let previousWasBlock = false;
    let held = '';           // whitespace waiting to see what follows it
    TAG_OR_TEXT.lastIndex = 0;

    for (let piece; (piece = TAG_OR_TEXT.exec(chunk)) !== null; ) {
      const token = piece[0];
      if (token[0] !== '<' && !token.trim()) {
        held += token;
        continue;
      }

      const isTag = token[0] === '<' && !token.startsWith('<!--');
      const isBlock = isTag && BLOCK_TAG.test(token);
      const closing = isBlock && token[1] === '/';
      if (closing) depth = Math.max(0, depth - 1);

      // Between two block tags the whitespace is ours to set: none of it is
      // drawn, and leaving what was there is how a deleted row left a blank
      // line behind and a moved one kept the indentation of where it used to
      // be. Everywhere else it is the document's and stays untouched.
      if (isBlock && previousWasBlock && out) {
        out += `\n${INDENT.repeat(depth)}`;
      } else {
        out += held;
      }
      held = '';
      out += token;

      if (isBlock && !closing && !VOID_BLOCK.test(token) && !token.endsWith('/>')) {
        depth += 1;
      }
      previousWasBlock = isBlock;
    }
    return out + held;
  };

  let out = '';
  let last = 0;
  PRE_RUN.lastIndex = 0;
  for (let run; (run = PRE_RUN.exec(text)) !== null; ) {
    out += split(text.slice(last, run.index));
    out += run[0];
    last = run.index + run[0].length;
  }
  return out + split(text.slice(last));
}

module.exports = {
  extractBody,
  hasBody,
  replaceBody,
  breakBlocks,
  wrapDocument,
  templateStyle,
  visibleText,
  documentStats,
  inspectWrite,
  describeReasons,
};
