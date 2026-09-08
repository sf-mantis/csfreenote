/**
 * What the file has taken, and what it has not.
 *
 * The write guard can turn a save away, and then the note in front of the
 * user is not the note on disk. Every decision that follows from that gap
 * lives here — which document the source view is built from, what the status
 * is allowed to claim, and what a forced write actually writes — so it can be
 * checked without running the app.
 *
 * Source mode shows the file as it is on disk, so a note that changed
 * underneath shows the file rather than a stale copy. That is right for every
 * case but one: an edit the file has not taken yet — a save the write guard
 * refused, or source-mode work not written out. It lives only in the editor,
 * and rebuilding from disk drops it.
 *
 * What disappears is the <head>, because the body is spliced back in from the
 * live editor either way. A <style> typed in source mode would come back to
 * an unstyled note on the next visit, without a word, with the markup it
 * styled still sitting there.
 *
 * These two decisions are all there is to it, kept here so they can be checked
 * without running the app.
 */

/** The document to rebuild the source view from. */
export function sourceBase(diskHtml, pendingDoc) {
  return pendingDoc ?? diskHtml;
}

/**
 * What to hold on to when leaving source mode.
 *
 * Null once the file has it — matching disk is how we know the save landed,
 * and holding a copy past that point would outlive the file it came from.
 */
export function pendingDocument(text, diskHtml) {
  return text === diskHtml ? null : text;
}

/**
 * A held document after the file has taken a body-only save.
 *
 * Only its <head> is worth holding — the body always comes from the editor or
 * from the file. Left alone it goes stale, and source mode would then show the
 * words as they were before that save, ready to be written back over the good
 * ones. `splice` is the caller's own body replacement, which keeps this free
 * of the DOM.
 */
export function refreshHeld(pendingDoc, body, splice) {
  return pendingDoc ? splice(pendingDoc, body) : null;
}

export const HOLD = '저장 보류';
export const SAVED = '저장됨';

/**
 * What the status may say when there is nothing new to write.
 *
 * Nothing new is not the same as everything saved. Saying 저장됨 while the
 * file is still missing an edit is how a note came to look settled in every
 * mode while the work sat unwritten, with no sign anything was wrong.
 */
export function settledLabel(pendingDoc) {
  return pendingDoc ? HOLD : SAVED;
}

/**
 * Whether the status can be pressed to write anyway.
 *
 * Only 저장 보류 offers this, and only while we still know what the file
 * objected to — that message is what the user is asked to agree to.
 */
export function canForce(statusText, holdMessage) {
  return statusText === HOLD && Boolean(holdMessage);
}

/**
 * Which write a save makes.
 *
 * 'body'     — replace the contents of <body>, the ordinary edit-mode save
 * 'document' — write the whole file, what source mode always does
 * 'held'     — write the held document whole, carrying the words as they
 *              stand now
 *
 * The last one is why this is a decision and not an if. Forcing from edit
 * mode has to write the document, not the body: a body write leaves the head
 * behind, and the head is the part the file has been turning away — the very
 * thing being forced.
 */
export function writeShape({ mode, force = false, pendingDoc = null }) {
  if (force && mode !== 'source' && pendingDoc) return 'held';
  return mode === 'source' ? 'document' : 'body';
}
