'use strict';

/**
 * Full-text search over a book.
 *
 * Every keystroke used to re-read and re-decode every note — 11 MB of parsing
 * for a book of 74. The expensive part is turning a file into plain text, and
 * that only changes when the file does, so it is cached against the file's
 * mtime and size. Later searches stat each note and scan strings already in
 * memory.
 *
 * Free of Electron so the verification harness runs the same code the app does.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { decodeBuffer } = require('./encoding');

const NOTE_EXT = /\.html?$/i;
const FOLDER_MARKER = /^___cs_free_note__folder\.html?$/i;

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 60;
const MAX_RESULTS = 200;

/** Visible text of a note, with markup and scripts removed. */
function plainText(html) {
  return String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createSearchIndex({ hiddenDirs = new Set() } = {}) {
  // fullPath -> { mtimeMs, size, text, lower }
  const cache = new Map();
  let hits = 0;
  let misses = 0;

  async function textFor(full, stat) {
    const cached = cache.get(full);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      hits += 1;
      return cached;
    }
    misses += 1;
    const buffer = await fsp.readFile(full);
    let html;
    try {
      ({ html } = decodeBuffer(buffer));
    } catch (err) {
      // Not UTF-8, so there is nothing to read out of it. One such file must
      // not stop the search over everything else.
      if (err && err.code === 'NOT_UTF8') {
        const empty = { mtimeMs: stat.mtimeMs, size: stat.size, text: '', lower: '' };
        cache.set(full, empty);
        return empty;
      }
      throw err;
    }
    const text = plainText(html);
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, text, lower: text.toLowerCase() };
    cache.set(full, entry);
    return entry;
  }

  /**
   * @param {string} bookDir
   * @param {{query: string, scopeRelative?: string, signal?: {cancelled: boolean}}} req
   */
  async function search(bookDir, { query, scopeRelative = '', signal } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const root = scopeRelative
      ? path.join(path.resolve(bookDir), ...scopeRelative.split('/'))
      : path.resolve(bookDir);

    const results = [];
    const seen = new Set();

    async function walk(dir, relative) {
      if (signal?.cancelled || results.length >= MAX_RESULTS) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (signal?.cancelled || results.length >= MAX_RESULTS) return;
        const full = path.join(dir, entry.name);
        const rel = relative ? `${relative}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          if (hiddenDirs.has(entry.name) || entry.name.startsWith('.')) continue;
          await walk(full, rel);
          continue;
        }
        if (!NOTE_EXT.test(entry.name) || FOLDER_MARKER.test(entry.name)) continue;

        seen.add(full);
        const name = entry.name.replace(NOTE_EXT, '');
        const nameHit = name.toLowerCase().includes(needle);

        let snippet = '';
        let contentHit = false;
        try {
          const stat = await fsp.stat(full);
          const { text, lower } = await textFor(full, stat);
          const at = lower.indexOf(needle);
          if (at >= 0) {
            contentHit = true;
            snippet = text
              .slice(Math.max(0, at - SNIPPET_BEFORE), at + needle.length + SNIPPET_AFTER)
              .trim();
          }
        } catch {
          /* unreadable note: fall back to the name match alone */
        }

        if (nameHit || contentHit) {
          results.push({ relativePath: rel.replace(/\\/g, '/'), name, snippet });
        }
      }
    }

    await walk(root, scopeRelative);

    // Notes deleted outside the app would otherwise sit in the cache forever.
    if (!scopeRelative && !signal?.cancelled) {
      for (const key of cache.keys()) {
        if (!seen.has(key)) cache.delete(key);
      }
    }

    return results.slice(0, MAX_RESULTS);
  }

  return {
    search,
    /** Drop a note (or a whole folder) from the cache after it changes. */
    invalidate(fullPath) {
      if (!fullPath) return;
      const target = path.resolve(fullPath);
      if (cache.delete(target)) return;
      const prefix = target + path.sep;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },
    clear() {
      cache.clear();
      hits = 0;
      misses = 0;
    },
    stats() {
      return { entries: cache.size, hits, misses };
    },
  };
}

module.exports = { createSearchIndex, plainText };
