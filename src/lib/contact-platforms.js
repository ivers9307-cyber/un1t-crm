// CARDLENS.1 — which membership platform a contact page may show for a
// person. Pure; the page reads the studio's membership_source
// (membershipSourceState) and passes the key in.

/**
 * The Glofox card's mode on the contact page.
 *  'linked'   — the contact has a Glofox account: show it, whatever the
 *               primary studio runs (a Hatch-primary person who trains at
 *               Stillorgan keeps their Stillorgan record).
 *  'pushable' — no account yet and the primary studio runs Glofox: offer
 *               "Create in Glofox". An unreadable source (null) lands here too,
 *               as before CARDLENS.1; the push route refuses it on its own read.
 *  'hidden'   — no account and the studio runs un1t.online or nothing: a Glofox
 *               card there is an empty box with a button that cannot work.
 *
 * @param {{ contact: object, primarySource: string|null }} a
 * @returns {'linked'|'pushable'|'hidden'}
 */
export function glofoxCardMode({ contact, primarySource }) {
  if (contact?.glofox_member_id) return 'linked'
  if (primarySource === 'glofox' || primarySource == null) return 'pushable'
  return 'hidden'
}
