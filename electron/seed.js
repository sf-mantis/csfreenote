'use strict';

/**
 * Filling a user folder from what the installer brought.
 *
 * The first install copies the folder over. After that the folder is the
 * reader's: a file they changed is theirs, and a file they deleted stays
 * deleted. But an update may bring something the first install did not have —
 * a new template — and that has to reach an install that already exists, or it
 * only ever appears for people installing for the first time.
 *
 * So: write what is missing, touch nothing else. It is the narrowest rule that
 * still lets a new template arrive.
 *
 * Notes are never topped up. That folder is the reader's work, not ours.
 */

const fs = require('fs');
const path = require('path');

/** Copy files present in `seed` and absent from `target`. Returns their names. */
function topUpFiles(seed, target) {
  if (!seed || !target) return [];
  if (!fs.existsSync(seed) || !fs.existsSync(target)) return [];
  const added = [];
  for (const entry of fs.readdirSync(seed, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(seed, entry.name), to);
    added.push(entry.name);
  }
  return added;
}

module.exports = { topUpFiles };
