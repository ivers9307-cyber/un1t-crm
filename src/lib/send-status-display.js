// COMMS-DETAIL-FIX.4 — ONE status vocabulary for every send-detail header.
//
// Before this the three channels each did their own thing: email looked up a
// private `campaignStatusConfig` and rendered a title-cased label, WhatsApp
// printed the raw lowercase DB value ("sending") in a `bg-green-500/20` pill
// against the repo's `/10` chip recipe, and SMS passed no status at all — so
// a sent, a cancelled and a scheduled SMS broadcast rendered identically in
// exactly the state where an operator is deciding whether to intervene.
//
// Chip recipe is the repo convention (CLAUDE.md; check:guardrails
// no-low-contrast-chip): `bg-<c>-500/10 text-<c>-700`. Text on a light card
// needs the -700 ramp.
//
// Values are byte-identical to the email map this replaces, so the email
// header is unchanged by the consolidation — the other two moved to it.
//
// Deliberately NOT merged with src/app/communications/sent/send-status.js:
// that one styles a dense LIST row (a /15 wash reads better at 11px against
// alternating rows) and carries the last_error tooltip decision. Detail
// headers and list rows are two surfaces; one shared table would have to be
// wrong for one of them.

const STATUS = Object.freeze({
  draft:     { label: 'Draft',     cls: 'bg-slate-500/10 text-slate-700' },
  scheduled: { label: 'Scheduled', cls: 'bg-blue-500/10 text-blue-700' },
  queued:    { label: 'Queued',    cls: 'bg-amber-500/10 text-amber-700' },
  sending:   { label: 'Sending',   cls: 'bg-amber-500/10 text-amber-700' },
  sent:      { label: 'Sent',      cls: 'bg-green-500/10 text-green-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-rose-500/10 text-rose-700' },
  failed:    { label: 'Failed',    cls: 'bg-red-500/10 text-red-700' },
})

const NEUTRAL = 'bg-slate-500/10 text-slate-700'

/**
 * Presentation for one send status, whatever channel produced it.
 *
 * An UNKNOWN status still gets a readable label rather than the raw column
 * value: the three channels' status columns are free-text (no CHECK on
 * whatsapp_broadcasts.status), so "some value we didn't plan for" is a real
 * case, and printing `sending` in lowercase beside email's `Sent` is how the
 * inconsistency looked on screen in the first place.
 *
 * @param {string|null|undefined} status
 * @returns {{ label: string, cls: string } | null}
 */
export function sendStatusDisplay(status) {
  if (!status || typeof status !== 'string') return null
  const key = status.toLowerCase()
  if (STATUS[key]) return STATUS[key]
  return {
    label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
    cls: NEUTRAL,
  }
}

export const SEND_STATUS_KEYS = Object.freeze(Object.keys(STATUS))
