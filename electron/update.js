'use strict';

/**
 * Is there a newer release?
 *
 * This only ever tells the user. It does not download, install, or run
 * anything — the app is not signed, and a path that fetches an executable and
 * runs it has to be able to prove where the executable came from. Until it
 * can, the last step stays in the user's hands.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *   A URL from the network never reaches the shell. The releases page is a
 *   constant in this file. The feed is read only for a version number, and
 *   whatever else it holds is dropped.
 *
 *   A failed check is silent. There is no network here worth interrupting
 *   someone's writing over: no answer, a slow answer, a mangled answer and an
 *   answer that is older than what is installed all mean the same thing —
 *   nothing to say.
 *
 * Electron-free so it can be exercised by node directly.
 */

const https = require('https');

const OWNER = 'sf-mantis';
const REPO = 'csfreenote';

const FEED = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** Where the user is sent. A constant, never a value from the feed. */
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

// A release feed is a few kB. Anything past this is not one, and reading it
// into memory is the only harm an answer can do here.
const SIZE_CAP = 256 * 1024;
const TIMEOUT_MS = 8000;

/** "v1.3.0" or "1.3.0" to [1, 3, 0]. Null when it is not a version. */
function parseVersion(text) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(String(text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 or 1. Null parts sort as older, so an unreadable tag never wins. */
function compareVersions(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/**
 * The feed, reduced to the one thing acted on.
 *
 * Returns null for anything that is not a release newer than `current` —
 * including a draft or prerelease, which is not what an ordinary user should
 * be nudged towards.
 */
function readFeed(body, current) {
  let data;
  try {
    data = JSON.parse(String(body));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.draft === true || data.prerelease === true) return null;

  const latest = parseVersion(data.tag_name);
  if (!latest) return null;
  if (compareVersions(latest, parseVersion(current)) <= 0) return null;

  return { version: latest.join('.') };
}

/** GET the feed as text. Rejects on anything unusual; callers swallow it. */
function fetchFeed(url = FEED) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        // GitHub refuses a request with no user agent.
        'User-Agent': `${REPO}-update-check`,
        Accept: 'application/vnd.github+json',
      },
      timeout: TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > SIZE_CAP) {
          request.destroy();
          reject(new Error('too large'));
        }
      });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

/**
 * Ask once. Resolves with `{ version }` when there is something newer, and
 * with null otherwise — including every failure.
 */
async function checkForUpdate(current, { fetch = fetchFeed } = {}) {
  try {
    return readFeed(await fetch(), current);
  } catch {
    return null;
  }
}

module.exports = {
  FEED,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  readFeed,
  fetchFeed,
  checkForUpdate,
};
