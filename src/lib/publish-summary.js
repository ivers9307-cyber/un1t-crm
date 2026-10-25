// PUBLISH-CONFIRM.1 — what the publish modal says once the publish lands.
//
// THE FINDING: a successful publish showed the operator nothing at all. The
// modal closed the moment the POST resolved, so "published 34 shifts and told
// 6 coaches" and "published nothing, told nobody" were the same two pixels of
// motion, and the "approval requested" panel the modal already had could
// never render — the close beat it to the screen every time.
//
// Counts, not adjectives. `shift_count` is every shift in the period (the
// projection counts them all, including the FTE-staffed and unstaffed ones,
// since ROSTERVIS.1); `coaches_notified` is coaches TARGETED — first publish
// plus the change re-notify — and is never a proof of delivery, so the copy
// says "told", not "received".
//
// Client-safe on purpose: no server import, so the modal can pull it in.

/**
 * @param {{ shift_count?: number, coaches_notified?: number } | null | undefined} summary
 * @param {string} periodLabel  what the operator chose, e.g. "September 2026"
 * @returns {string}
 */
export function publishedSummaryLine(summary, periodLabel) {
  const where = periodLabel ? ` for ${periodLabel}` : ''
  // An older server (or a partial-success response) sends no summary. Saying
  // "0 shifts" there would be a made-up number; say only what is known.
  if (!summary || summary.shift_count == null) {
    return `The roster${where} is live.`
  }
  const shifts = Number(summary.shift_count) || 0
  const coaches = Number(summary.coaches_notified) || 0
  const shiftPart = `${shifts} ${shifts === 1 ? 'shift' : 'shifts'}${where} ${shifts === 1 ? 'is' : 'are'} live.`
  const coachPart = coaches === 0
    ? 'Nothing changed for any coach, so nobody was messaged.'
    : `${coaches} ${coaches === 1 ? 'coach was' : 'coaches were'} told.`
  return `${shiftPart} ${coachPart}`
}
