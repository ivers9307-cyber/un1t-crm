// MOBILE-SIGHINT.1 — what the phone is ABOUT TO SIGN, as data.
//
// The mobile reply screen and the compose sheet both append a signature
// SERVER-SIDE (the reply/compose routes resolve it themselves) and, until
// this module, showed no trace of it: a coach signed invisibly from the
// phone, typed their name a second time, or trusted a composer that
// disagreed with what the member received. Web has carried the
// "Added automatically…" hint since EMAIL-TICKET.5 and MAILFIX-SIGTRUTH.1
// widened it to the EFFECTIVE signature — the one that actually sends once
// the sending studio's name, phone and links are applied.
//
// 🔴 THIS MODULE RESOLVES NOTHING. It reads `effective_text` off the wire
// and renders it VERBATIM. Mobile cannot import `src/lib` (CLAUDE.md
// Web/mobile boundary) and the signature renderer has NO `shared/` twin —
// which is exactly why GET /api/me/preferences renders the text server-side
// per location (src/lib/signature-context.js → withEffectiveText). If you
// ever find yourself reaching for `effectiveRichSignature`,
// `renderRichSignature` or a studio-name/phone/links merge in here, stop:
// that is the drift the server rendering exists to prevent, and a second
// implementation on a lane that ships by OTA is the worst place to keep it.
//
// THE THREE-VALUE CONTRACT on `effective_text`, per entry:
//   a non-empty string   — exactly the text part a send appends
//   ''  with rich: true  — an HTML-ONLY block goes out (a photo-only rich
//                          signature: no text part, and the send appends NO
//                          "-- " separator), so show the label and the
//                          suffix line and NO separator block
//   null                 — nothing appends at all, and the hint must HIDE
//
// WHY THE HINT HIDES RATHER THAN GUESSES. The send always resolves a real
// studio, so a preview of an unresolved signature is a preview of an email
// that will never exist (src/lib/signature-context.js, "THE RULE"). No
// location, no entry for it, or a null `effective_text` all answer null
// here and the screens render nothing — never the person's raw values, and
// never an empty labelled box.
//
// 🔴 NO MODULE-LEVEL CACHE OF THE PREFERENCES FETCH, ANYWHERE. Web built
// one and REMOVED it on review: a module memo is per TAB, not per VIEWER,
// so after a client-side sign-out on a shared machine it showed user B the
// previous user's signature. A staff phone at the front desk is MORE likely
// to be shared, not less. The screens fetch per mount (three bounded reads
// per composer mount is the right cost) and this module holds no state at
// all — it is pure, which is also why it is the tested unit: these screens
// have no render-test harness in this repo.

/**
 * The plain-text sign-off separator, RFC 3676 §4.3 — a mirror of
 * SIGNATURE_SEPARATOR in src/lib/email-signature.js, which mobile cannot
 * import. The trailing space is load-bearing (it is what mail clients
 * recognise), so it is written as a literal here rather than trimmed copy.
 */
export const SIGNATURE_SEPARATOR = '-- '

/**
 * The suffix naming exactly what THIS studio's rich send carries — picked
 * from the (hasPhoto, hasLinks) pair, so a photo-only signature never
 * promises links and a links-only one never promises a photo. Wording
 * matches src/components/tickets/SignatureHint.jsx word for word: two
 * surfaces describing the same email must not describe it differently.
 *
 * @param {{hasPhoto?: boolean, hasLinks?: boolean}} hint
 * @returns {string}
 */
export function richSuffix({ hasPhoto, hasLinks } = {}) {
  if (hasPhoto && hasLinks) return 'The email carries the rich layout — photo and links included.'
  if (hasPhoto) return 'The email carries the rich layout — photo included.'
  if (hasLinks) return 'The email carries the rich layout — links included.'
  return 'The email carries the rich layout.'
}

/**
 * What a send from `locationId` will append for this viewer, ready to
 * render — or NULL when the hint must not appear at all.
 *
 * `locationId` IS THE SENDING CONTEXT: the ticket's `location_id` on a
 * reply, the SELECTED From mailbox's location on a compose (the same
 * expression those screens hand the send call, so switching the From
 * account re-resolves the hint exactly as the send would). A compose with
 * no From account selected has no sending context and passes null — nothing
 * can send, so there is nothing truthful to preview.
 *
 * Returned shape (a superset of the raw wire flags, so the screens stay
 * thin — every copy decision is made and tested HERE, not in JSX):
 *   text      string   the appended text part; '' for a photo-only rich block
 *   rich      boolean  the rich path won
 *   hasPhoto  boolean  a photo rides the email
 *   hasLinks  boolean  the effective links list is non-empty
 *   body      string|null  the separator block to render, or NULL when there
 *                          is no text part (photo-only) — the send appends
 *                          no separator there, so neither may the hint
 *   suffix    string|null  the rich-layout line, or null on a plain signature
 *
 * NEVER THROWS: a null, undefined or non-array payload is "no contexts",
 * which is the same answer as "no entry for this studio" — hide.
 *
 * @param {Array|null|undefined} contexts  `signature_contexts` off
 *        GET /api/me/preferences, each entry already server-rendered
 * @param {string|null|undefined} locationId  the SENDING location
 * @returns {{text: string, rich: boolean, hasPhoto: boolean, hasLinks: boolean,
 *           body: string|null, suffix: string|null}|null}
 */
export function resolveSignatureHint(contexts, locationId) {
  if (!locationId) return null
  const row = (Array.isArray(contexts) ? contexts : [])
    .find(c => c?.location_id === locationId)
  if (!row) return null

  // null (and a missing/!string field, which is the same fact arriving
  // degraded) means NOTHING is appended — hide. Read the requested studio's
  // own entry or none: falling back to "the first context" would sign a
  // Stillorgan reply with Hatch Street's phone number.
  const text = row.effective_text
  if (typeof text !== 'string') return null

  const rich = row.rich === true
  const hasPhoto = row.has_photo === true
  const hasLinks = row.has_links === true

  // '' + rich → an HTML-only block: label and suffix, NO separator. '' with
  // no rich block is a shape the server does not emit (it answers null
  // there); treat it as nothing-appends rather than render an empty box
  // under an "Added automatically" label, which would be a different lie.
  if (text.length === 0 && !rich) return null

  return {
    text,
    rich,
    hasPhoto,
    hasLinks,
    body: text.length > 0 ? `${SIGNATURE_SEPARATOR}\n${text}` : null,
    suffix: rich ? richSuffix({ hasPhoto, hasLinks }) : null,
  }
}
