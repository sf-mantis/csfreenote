/**
 * Format the current date and time for stamping into a note.
 *
 * The tokens are Delphi's, so a format string carried over from an older
 * settings file keeps meaning what it meant. The one that surprises people
 * is `nn` for minutes: `mm` is months.
 *
 *   yyyy 2026   yy 26        mm 08   m 8      dd 28   d 28
 *   hh 09       h 9          nn 05   n 5      ss 07   s 7
 *   dddd 금요일  ddd 금        tt 오후  ampm 오후
 *
 * Anything between double quotes is left alone, which is how a format can
 * contain a letter that would otherwise be read as a token.
 */

const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

export const DEFAULT_FORMAT = 'yyyy-mm-dd hh:nn:ss dddd';

// Longest tokens first, so `yyyy` is not read as `yy` twice.
const TOKEN = /"[^"]*"|dddd|ddd|yyyy|ampm|yy|mm|dd|hh|nn|ss|tt|m|d|h|n|s/g;

const pad = (value) => String(value).padStart(2, '0');

/**
 * @param {string} format
 * @param {Date} [at] the moment to render; defaults to now
 */
export function formatDateTime(format, at = new Date()) {
  const hours = at.getHours();
  const replacements = {
    yyyy: String(at.getFullYear()),
    yy: String(at.getFullYear() % 100).padStart(2, '0'),
    mm: pad(at.getMonth() + 1),
    m: String(at.getMonth() + 1),
    dd: pad(at.getDate()),
    d: String(at.getDate()),
    hh: pad(hours),
    h: String(hours),
    nn: pad(at.getMinutes()),
    n: String(at.getMinutes()),
    ss: pad(at.getSeconds()),
    s: String(at.getSeconds()),
    dddd: WEEKDAYS[at.getDay()],
    ddd: WEEKDAYS[at.getDay()].slice(0, 1),
    tt: hours < 12 ? '오전' : '오후',
    ampm: hours < 12 ? '오전' : '오후',
  };

  return String(format ?? '').replace(TOKEN, (token) => {
    if (token.startsWith('"')) return token.slice(1, -1);
    return replacements[token] ?? token;
  });
}
