// IG-LINK.1 — matching helpers for attaching an Instagram thread to a CRM
// contact.
//
// Instagram gives us no phone or email, only an opaque IGSID, a handle and a
// display name. The durable link is therefore the IGSID stored on the contact
// (mig 539): a thread is linked once, and every later thread from that person
// resolves automatically.
//
// Richard's call (2026): a display name that matches EXACTLY ONE contact may
// auto-link, everything else is a ranked suggestion a human confirms. The
// accepted risk is a same-name collision, so the guards below are deliberately
// strict and fully unit-tested — a wrong link would put a stranger's
// conversation, consent and history on a member's record.
//
// Pure — no IO.

/**
 * Casefold a human name for comparison: strip accents and punctuation,
 * collapse whitespace. "Séan  O'Brien-Murphy" → "sean o brien murphy".
 */
export function normalizeName(value) {
  if (value == null) return ''
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Every name spelling a contact row can present (full name + first/last). */
export function contactNameVariants(contact) {
  if (!contact) return []
  const parts = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
  return [contact.name, parts]
    .map(normalizeName)
    .filter(Boolean)
}

/**
 * Is this IG display name specific enough to risk auto-linking on?
 * Requires at least two meaningful tokens — a mononym or a handle-ish
 * single word ("dave", "un1tfan92") is far too weak to bind an identity.
 */
export function isAutoLinkableName(displayName) {
  const n = normalizeName(displayName)
  if (!n) return false
  return n.split(' ').filter(t => t.length > 1).length >= 2
}

/**
 * Pick the single contact an IG display name unambiguously identifies, or null.
 *
 * CONTRACT (IG-LINK.2): `candidates` MUST already be the complete set of
 * contacts carrying this normalised name at this location — i.e. the caller
 * queried `name_normalized` (mig 540), not a raw `ilike`. The ambiguity test
 * below counts that set, so a caller that hands over a partial set turns a
 * genuine duplicate into a false unique. That was the original bug: candidates
 * came from raw string equality while matching was normalised, so "Sean Byrne"
 * and "Seán Byrne" looked like one person and auto-linked to whichever row SQL
 * happened to return.
 *
 * Guards, all required:
 *  - the display name must look like a real full name
 *  - exactly ONE candidate (any ambiguity → null, let a human choose)
 *  - that candidate must genuinely carry the name (validates, never narrows —
 *    it can only ever refuse, so it cannot manufacture a unique)
 *  - never steal a contact already bound to a DIFFERENT Instagram account
 */
export function pickAutoLinkContact(candidates, displayName, igsid = null) {
  if (!isAutoLinkableName(displayName)) return null
  const list = candidates || []
  if (list.length !== 1) return null
  const match = list[0]
  if (!contactNameVariants(match).includes(normalizeName(displayName))) return null
  if (match.instagram_igsid && match.instagram_igsid !== igsid) return null
  return match
}

/**
 * Rank contacts to offer a human in the link picker. Never auto-applied —
 * ordering only, so a loose heuristic is safe here.
 *   exact full-name match            → 100
 *   handle matches the contact name  → 80
 *   every display-name token present → 60
 *   some token overlap               → 20..59 by proportion
 */
export function rankContactSuggestions(candidates, { displayName = '', handle = '' } = {}, limit = 5) {
  const target = normalizeName(displayName)
  const handleN = normalizeName(handle)
  const targetTokens = target.split(' ').filter(Boolean)

  const scored = (candidates || []).map(contact => {
    const variants = contactNameVariants(contact)
    let score = 0
    if (target && variants.includes(target)) {
      score = 100
    } else if (handleN && variants.some(v => v.replace(/ /g, '') === handleN.replace(/ /g, ''))) {
      score = 80
    } else if (targetTokens.length) {
      const best = variants.reduce((acc, v) => {
        const vTokens = new Set(v.split(' ').filter(Boolean))
        const hits = targetTokens.filter(t => vTokens.has(t)).length
        return Math.max(acc, hits)
      }, 0)
      if (best === targetTokens.length && best > 0) score = 60
      else if (best > 0) score = 20 + Math.round((best / targetTokens.length) * 39)
    }
    return { contact, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
