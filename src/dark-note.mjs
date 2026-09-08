/**
 * Render a note for the dark theme without changing the note.
 *
 * Inverting the whole document was the cheap way to do this, and it was wrong:
 * it flips a colour's identity. A blue header came out lighter than it started
 * and its white caption came out black. What people expect is the same colour,
 * darker — #3c62c6 should read as #1e2942, not #7a9aee.
 *
 * So instead the colours a note actually declares are collected and each one
 * is mapped into the dark range with its hue kept. The result is emitted as a
 * stylesheet of !important overrides, which the caller injects into the note's
 * <head> — saving only ever takes <body>, so none of this can reach the file.
 */

/* ------------------------------------------------------------------ *
 * Colour space
 * ------------------------------------------------------------------ */

const NAMED = {
  white: '#ffffff', black: '#000000', red: '#ff0000', blue: '#0000ff',
  green: '#008000', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', navy: '#000080', teal: '#008080', olive: '#808000',
  maroon: '#800000', purple: '#800080', lime: '#00ff00', aqua: '#00ffff',
  fuchsia: '#ff00ff',
};

/** Parse #rgb, #rrggbb, rgb()/rgba() or a basic colour name into [r,g,b]. */
export function parseColor(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;

  const named = NAMED[text];
  const hex = (named || text).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }

  const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) return [1, 2, 3].map((i) => Math.round(Number(rgb[i])));

  return null;
}

export function toHex([r, g, b]) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsl([r, g, b]) {
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((v) => v * 255);
}

/* ------------------------------------------------------------------ *
 * The mapping
 * ------------------------------------------------------------------ */

/**
 * Backgrounds land in a narrow dark band, keeping their hue.
 * White (l=1) becomes near-black; a mid blue keeps reading as blue.
 */
export function darkenBackground(color) {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(rgb);
  // A background that is already dark is left dark; everything else is pulled
  // into the same narrow band so the page reads as one surface.
  const next = l < 0.35 ? l * 0.6 : 0.10 + (1 - l) * 0.20;
  return toHex(hslToRgb([h, s * 0.72, next]));
}

/**
 * Text has to stay legible against those backgrounds. Anything already light
 * stays light; anything dark is lifted to near-white, hue intact, so a blue
 * heading is still recognisably a blue heading.
 */
export function lightenForeground(color) {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(rgb);
  const next = l >= 0.5 ? Math.min(0.92, Math.max(0.72, l)) : 0.95 - l * 0.6;
  return toHex(hslToRgb([h, s * 0.85, next]));
}

/* ------------------------------------------------------------------ *
 * Rule generation
 * ------------------------------------------------------------------ */

const HEX_OR_RGB = '#[0-9a-fA-F]{3,6}|rgba?\\([^)]*\\)';

const BGCOLOR_ATTR = new RegExp(`\\bbgcolor\\s*=\\s*["']?(${HEX_OR_RGB}|[a-z]+)`, 'gi');
const COLOR_ATTR = new RegExp(`\\bcolor\\s*=\\s*["']?(${HEX_OR_RGB}|[a-z]+)`, 'gi');
const STYLE_BG = new RegExp(`background(?:-color)?\\s*:\\s*(${HEX_OR_RGB})`, 'gi');
const STYLE_FG = new RegExp(`(?<!-)\\bcolor\\s*:\\s*(${HEX_OR_RGB})`, 'gi');

function collect(html, pattern) {
  const found = new Set();
  for (const match of String(html).matchAll(pattern)) {
    const value = match[1];
    if (value && parseColor(value)) found.add(value);
  }
  return [...found];
}

const escapeValue = (value) => value.replace(/["\\]/g, '\\$&');

/**
 * Build the stylesheet that renders `html` for the dark theme.
 * Returns CSS text; the caller puts it in a <style> inside <head>.
 */
export function darkNoteCss(html) {
  const rules = [
    // The page itself, and anything that never declared a colour.
    ':root, body { background-color: #16181d !important; color: #d9dde4 !important; }',
    'td, th, div, p, span, li, dd, dt { color: inherit; }',
    'a { color: #7fb3e0 !important; }',
    'a:hover { color: #a8cdf0 !important; }',
    'hr { border-color: #333a45 !important; }',
    'table, td, th { border-color: #333a45 !important; }',
  ];

  const seen = new Set();
  const add = (selector, declaration) => {
    const rule = `${selector} { ${declaration} }`;
    if (seen.has(rule)) return;
    seen.add(rule);
    rules.push(rule);
  };

  for (const value of collect(html, BGCOLOR_ATTR)) {
    const dark = darkenBackground(value);
    if (dark) add(`[bgcolor="${escapeValue(value)}" i]`, `background-color: ${dark} !important;`);
  }

  for (const value of collect(html, COLOR_ATTR)) {
    const light = lightenForeground(value);
    if (light) add(`[color="${escapeValue(value)}" i]`, `color: ${light} !important;`);
  }

  // Inline styles are matched on the declaration text, which is how it was
  // written in the file — that is what the attribute selector can see.
  for (const value of collect(html, STYLE_BG)) {
    const dark = darkenBackground(value);
    if (dark) add(`[style*="${escapeValue(value)}" i]`, `background-color: ${dark} !important;`);
  }

  for (const value of collect(html, STYLE_FG)) {
    const light = lightenForeground(value);
    if (!light) continue;
    // A value used as both a background and a text colour is already covered
    // by the background rule above; setting colour too is harmless.
    add(`[style*="color:${escapeValue(value)}" i], [style*="color: ${escapeValue(value)}" i]`,
      `color: ${light} !important;`);
  }

  return rules.join('\n');
}
