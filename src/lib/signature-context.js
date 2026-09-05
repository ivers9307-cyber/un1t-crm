// MAILFIX-SIGTRUTH.1 — the READ side of "the signature people see IS the
// signature that sends".
//
// Every real send resolves the person's rich signature through
// effectiveRichSignature(personRich, ctx) with the SENDING studio's context
// (src/app/api/email/tickets/_helpers.js → loadSignatureContext): the note
// line is always replaced by the studio name, and phone/links whenever the
// studio's own card (company_settings.email_signature, MAIL-SIG.2) defines
// them. Two audit findings (both upheld 3-0) were preview surfaces rendering
// the UN-resolved input instead — the /account preview showed exactly what
// was typed, and the composers' hint read only the plain column.
//
// 🔴 THE RULE: NEVER RENDER A KNOWN-UNRESOLVED SIGNATURE ANYWHERE. The send
// resolves the studio for ANY location it is handed (loadSignatureContext
// reads locations.name unconditionally), so a preview that falls back to the
// person's raw values — stored note, own phone/links — is a preview of an
// email that will never exist. Where this module cannot resolve, it answers
// null and the surface hides; it never answers personRich verbatim.
//
// This module is that resolution made available to the surfaces that SHOW a
// signature, without touching what sends:
//
//   • loadSignatureContexts(db, user) — the server half. One entry per
//     location where the caller holds `email_inbox` (the resolver INPUTS:
//     studio name off user.locations + the studio's signature card), each
//     flagged `has_mailbox` (≥1 active email_mailboxes row) so the /account
//     editor can offer chips only for studios the caller can actually send
//     from — a master account's user.locations is estate-wide. EVERY
//     permitted location is present, because a reply on a mailbox-less
//     orphan ticket at studio X still resolves X at send. Best-effort by
//     contract: a blipped card read degrades that field to null; a blipped
//     (or full-page, i.e. possibly truncated) mailbox read leaves
//     has_mailbox TRUE for all — over-offer, never hide; neither ever errors
//     the GET.
//
//   • withEffectiveText(contexts, profile) — the server-RENDERED half. Per
//     entry it adds `effective_text`, `rich`, `has_photo` and `has_links`.
//     THIS IS THE MOBILE CONTRACT: mobile cannot import src/lib (CLAUDE.md
//     boundary — the renderer has no shared/ twin), so it renders
//     effective_text VERBATIM and never resolves anything. Three values:
//       string (non-empty) — the exact text part a send appends
//       ''  with rich:true — an HTML-ONLY block goes out (photo-only rich
//                            signature: no text part, no "-- " separator),
//                            so show the label/suffix and no text
//       null               — nothing appends at all
//
//   • signatureContextFor / resolveSignatureHint / signatureStudiosToOffer —
//     the pure half, client-safe. THIS IS THE WEB CONTRACT: the /account
//     editor resolves the LIVE draft per keystroke and the composers' hint
//     re-resolves per From switch, both client-side over the entry's INPUTS
//     ({location_name, studio_signature}) — which is why the inputs ride the
//     wire alongside the rendered text. resolveSignatureHint mirrors the
//     send routes' decision EXACTLY (richSignatureFromProfile gate on the
//     RAW rich value, then renderRichSignature(effectiveRichSignature(…)),
//     else the plain column) — and answers null for a location it has no
//     entry for (see THE RULE). The server half calls the SAME function, so
//     the two contracts cannot disagree.
//
// GET /api/me/preferences carries all of it as `signature_contexts`, so the
// /account editor, every composer and the mobile hint read ONE payload.
//
// READ-ONLY BY DESIGN. Nothing in here is imported by a send path, and the
// resolvers are the send paths' own exported pure functions — imported, not
// duplicated, so the preview and the send cannot drift.

//
// MAIL-SIGDEFAULT.1 — the studio signature is on for everyone. The decision
// itself now lives in ONE exported function, resolveSendSignature
// (email-signature.js), which the three send routes call directly and
// resolveSignatureHint below calls for the previews: personal rich when
// enabled, else the STUDIO block wherever the studio has configured one
// (with the plain column as the person's sign-off above it), else the plain
// column, else nothing. THE RULE widens accordingly: because every send may
// now carry the studio's block, a location this module has NO entry for is
// unresolved even for a plain-only person — null, hide — where it used to
// show the plain column alone.

import { hasPermissionForLocation } from '@/lib/permissions'
import { resolveSendSignature, normalizeSignature } from '@/lib/email-signature'

/**
 * The stated per-studio ceiling on email_mailboxes rows — mirrors
 * MAILBOX_LIMIT in src/app/api/email/tickets/_helpers.js, which is a
 * module-private const there (not exported, and that file is outside this
 * change's ownership). The mailbox read below is bounded in THIS unit:
 * studios × per-studio ceiling, capped at PostgREST's 1,000-row hard cap.
 */
export const PER_STUDIO_MAILBOX_CEILING = 200

// company_settings holds one row per location, so the caller's handful of
// studios is the bound; stated rather than implicit (every .select() caps at
// 1,000 rows whatever the caller asks for).
const CARD_LIMIT = 50

/**
 * The locations whose signature context matters to this caller: everywhere
 * they hold `email_inbox` — the same per-location resolution /account's
 * `worksAQueue` uses (a manager at one studio who is staff at another must
 * not lose their own preview because their session points at the second).
 *
 * @param {object} user  getCurrentUser() result
 * @returns {Array<{id: string, name: string|null}>}
 */
export function eligibleSignatureLocations(user) {
  return (user?.locations || [])
    .filter((l) => l?.id && hasPermissionForLocation(user, l.id, 'email_inbox'))
    .map((l) => ({ id: l.id, name: l.name || null }))
}

/**
 * The per-studio signature context for every PERMITTED location, wire-shaped:
 *   [{ location_id, location_name, studio_signature, has_mailbox }]
 *
 * `studio_signature` is company_settings.email_signature (the MAIL-SIG.2
 * portal-editable card: { phone?, links? }) or null — exactly the
 * `locationSignature` the send-side loadSignatureContext feeds
 * effectiveRichSignature. `location_name` comes off user.locations (the
 * same `locations` rows getCurrentUser already joined), so a blipped read
 * can only ever cost the studio card, never the studio line.
 *
 * `has_mailbox` says whether the studio runs an active mailbox — i.e.
 * whether the caller could actually SEND from it. It is a hint for the
 * editor's chips only; the hint/preview resolve against every entry, because
 * a send at a mailbox-less studio (an orphan ticket) still resolves that
 * studio. Unknown (blipped or possibly-truncated read) → true: offering a
 * chip for a studio one cannot send from is the smaller harm; hiding a
 * studio one can is the louder failure (CLAUDE.md: removing a silent
 * failure must never create a louder one).
 *
 * NEVER THROWS, NEVER ERRORS THE CALLER.
 *
 * @param {object} db  service-role client
 * @param {object} user  getCurrentUser() result
 * @returns {Promise<Array<{location_id: string, location_name: string|null, studio_signature: object|null, has_mailbox: boolean}>>}
 */
export async function loadSignatureContexts(db, user) {
  const permitted = eligibleSignatureLocations(user)
  if (permitted.length === 0) return []
  const ids = permitted.map((l) => l.id)
  // Bounded in the unit it returns: rows, at most the per-studio ceiling
  // per studio, never past PostgREST's hard cap.
  const mailboxLimit = Math.min(1000, ids.length * PER_STUDIO_MAILBOX_CEILING)

  // Two batched reads over the SAME id list, in parallel, each degrading on
  // its own. Both failures are a degrade, not an error — see the header.
  // Swallowed deliberately, the same way the send side's loadSignatureContext
  // swallows its own blip: this feeds previews only, and noise at error level
  // for a cosmetic miss is how real errors get ignored (CLAUDE.md,
  // POSTMARK-RACE).
  const [mailboxRows, cardRows] = await Promise.all([
    settle(() => db
      .from('email_mailboxes')
      .select('location_id')
      .eq('active', true)
      .in('location_id', ids)
      .limit(mailboxLimit)),
    settle(() => db
      .from('company_settings')
      .select('location_id, email_signature')
      .in('location_id', ids)
      .limit(CARD_LIMIT)),
  ])

  // A FULL page is a blip too: the read may have been truncated, so a
  // studio's rows could be the ones missing — the answer is unknown, and
  // unknown means offer.
  const mailboxesKnown = mailboxRows !== null && mailboxRows.length < mailboxLimit
  const withMailbox = mailboxesKnown ? new Set(mailboxRows.map((m) => m.location_id)) : null
  // Same guard on the card read: a full page could have cut a studio's card
  // off, and attaching SOME cards while silently missing others would show
  // one studio resolved and another not. Unknown → no cards (every
  // studio_signature null), which is the same degraded shape a blip gives.
  const cardsKnown = cardRows !== null && cardRows.length < CARD_LIMIT
  const cards = new Map(
    (cardsKnown ? cardRows : []).map((r) => [r.location_id, r.email_signature || null])
  )

  return permitted.map((l) => ({
    location_id: l.id,
    location_name: l.name,
    studio_signature: cards.get(l.id) || null,
    has_mailbox: withMailbox ? withMailbox.has(l.id) : true,
  }))
}

/**
 * Run one best-effort read: the rows on success, null on a PostgREST error
 * OR a thrown query. Null (not []) so callers can tell "nothing matched"
 * from "could not find out" — the two opposite answers CLAUDE.md warns
 * about collapsing.
 */
async function settle(run) {
  try {
    const { data, error } = await run()
    if (error) return null
    return data || []
  } catch {
    return null
  }
}

/**
 * The studios the /account editor offers as preview chips: those the
 * caller can actually send from (has_mailbox). If NONE has a mailbox the
 * whole permitted list stands — the preview must still resolve for SOME
 * real studio rather than fall back to the typed values.
 *
 * @param {Array} contexts  signature_contexts off the wire
 * @returns {Array}
 */
export function signatureStudiosToOffer(contexts) {
  const list = Array.isArray(contexts) ? contexts : []
  const withMailbox = list.filter((c) => c?.has_mailbox === true)
  return withMailbox.length > 0 ? withMailbox : list
}

/**
 * The server-RENDERED half — the mobile contract. Per entry, what a send
 * from that studio would append for THIS profile, already resolved:
 *   effective_text  string|null   the exact appended text part; '' when the
 *                                 rich block is HTML-only (photo, no text);
 *                                 null = nothing appends at all
 *   rich            boolean       the rich path won (else plain column / nothing)
 *   has_photo       boolean       a renderer-embeddable photo rides the email
 *   has_links       boolean       the effective links list is non-empty
 *
 * Goes through resolveSignatureHint — the SAME function the web hint runs
 * client-side — so the two clients cannot disagree about a single studio.
 * Pure CPU over data the GET already holds; never throws on a null profile.
 *
 * @param {Array} contexts  loadSignatureContexts() output
 * @param {{email_signature?: string|null, email_signature_rich?: object|null}|null} profile
 */
export function withEffectiveText(contexts, profile) {
  return (Array.isArray(contexts) ? contexts : []).map((c) => {
    const hint = resolveSignatureHint(
      {
        email_signature: profile?.email_signature ?? null,
        email_signature_rich: profile?.email_signature_rich ?? null,
        signature_contexts: [c],
      },
      c.location_id
    )
    return {
      ...c,
      effective_text: hint ? hint.text : null,
      rich: hint ? hint.rich : false,
      has_photo: hint ? hint.hasPhoto : false,
      has_links: hint ? hint.hasLinks : false,
    }
  })
}

/**
 * One wire entry → the ctx shape effectiveRichSignature takes, or null when
 * there is NO entry for the location (not permitted, or no location given).
 *
 * @param {Array|null|undefined} contexts  signature_contexts off the wire
 * @param {string|null|undefined} locationId
 * @returns {{locationName: string|null, locationSignature: object|null}|null}
 */
export function signatureContextFor(contexts, locationId) {
  if (!locationId) return null
  const row = (Array.isArray(contexts) ? contexts : []).find((c) => c?.location_id === locationId)
  if (!row) return null
  return {
    locationName: row.location_name || null,
    locationSignature: row.studio_signature || null,
  }
}

/**
 * What a send from `locationId` would actually append for this person — the
 * composers' hint, as data.
 *
 * IS THE SEND ROUTES' DECISION (reply/compose/forward), not a mirror of it:
 *   1. With NO ctx for this location the answer is null (THE RULE, file
 *      header): the send WILL resolve a studio there — and since
 *      MAIL-SIGDEFAULT.1 that studio may add its own block to ANY send — so
 *      neither personRich verbatim nor the plain column alone is a truthful
 *      preview.
 *   2. resolveSendSignature(prefs, ctx) — the very function the routes call
 *      — answers the rich {text, html} block: the personal rich signature
 *      when enabled and renderable (an enabled-but-empty one is "no personal
 *      part", exactly as at send), else the STUDIO block wherever the studio
 *      has configured one, with the plain column stacked above it.
 *   3. Otherwise the plain column, normalised; '' means NOTHING will be
 *      appended and the hint must not render.
 *
 * `text` is '' (with rich:true) for a photo-only rich signature: the send
 * appends no text part and no separator, only the HTML block.
 *
 * @param {{email_signature?: string|null, email_signature_rich?: object|null,
 *          signature_contexts?: Array}|null} prefs  GET /api/me/preferences data
 * @param {string|null|undefined} locationId  the SENDING location — the
 *        ticket's for a reply/forward, the chosen From mailbox's for a compose
 * @returns {{text: string, rich: boolean, hasPhoto: boolean, hasLinks: boolean}|null}
 */
export function resolveSignatureHint(prefs, locationId) {
  if (!prefs) return null
  const ctx = signatureContextFor(prefs.signature_contexts, locationId)
  if (!ctx) return null
  const block = resolveSendSignature(prefs, ctx)
  if (block) {
    // hasPhoto/hasLinks come off the same resolver — the photo only when the
    // renderer would embed it, the links off the EFFECTIVE list — so the
    // suffix names what this studio's send carries, not what was typed.
    return { text: block.text, rich: true, hasPhoto: block.hasPhoto, hasLinks: block.hasLinks }
  }
  const plain = normalizeSignature(prefs.email_signature)
  return plain ? { text: plain, rich: false, hasPhoto: false, hasLinks: false } : null
}
