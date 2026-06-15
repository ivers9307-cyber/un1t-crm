// src/lib/person-view.js — UI-FOUND pattern for PERSON-LINK.1
//
// Pure display-logic helpers for the person identity-linking UI.
// Mirrors the styles.js pattern: all branch-y logic lives here so
// it's unit-testable; the .jsx shells stay thin and call these helpers.
// Tested in person-view.test.js.

// ─── Initials ──────────────────────────────────────────────────────────────

/**
 * Derive up to 2 uppercase initials from a display name.
 * - 'Aoife Byrne' → 'AB'
 * - 'aoife'       → 'A'
 * - null / ''     → '?'
 *
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function initials(name) {
  if (!name || typeof name !== 'string' || !name.trim()) return '?'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

// ─── Account status label ──────────────────────────────────────────────────

// Mapping from glofox_membership_status values to human labels.
const STATUS_LABELS = Object.freeze({
  classpass_payg: 'ClassPass',
  member:         'Member',
  credit_member:  'Credit member',
  trial:          'Trial',
  lead:           'Lead',
  cold:           'Cold lead',
  ex_member:      'Ex-member',
  tour:           'Tour',
  no_sale_tour:   'No-sale tour',
  no_sale_trial:  'No-sale trial',
})

/**
 * Return a human-readable label for a glofox_membership_status value.
 * Falls back to title-casing the raw value (replacing underscores with spaces)
 * for unknown statuses, or 'Unknown' when status is empty.
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function accountStatusLabel(status) {
  if (!status) return 'Unknown'
  if (STATUS_LABELS[status]) return STATUS_LABELS[status]
  // Title-case fallback: replace underscores with spaces, capitalise each word.
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Last seen date ────────────────────────────────────────────────────────

/**
 * Format an ISO date string as a short human date: "12 Jun 2026".
 * Returns 'Never' for null/undefined/empty.
 *
 * Dependency-free: uses Intl.DateTimeFormat with en-IE locale so the
 * format stays consistent regardless of the server/browser timezone.
 *
 * @param {string|null|undefined} iso  ISO 8601 date/datetime string
 * @returns {string}
 */
export function formatLastSeen(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return 'Never'
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── Account status tone ───────────────────────────────────────────────────

// Token-class strings for status badges, following the CLAUDE.md
// "-700 text ramp" convention for text on light cards.
// Background is a tinted swatch at /10 opacity; text is the -700 ramp.
const STATUS_TONES = Object.freeze({
  member:         'bg-emerald-500/10 text-emerald-700',
  credit_member:  'bg-emerald-500/10 text-emerald-700',
  classpass_payg: 'bg-blue-500/10 text-blue-700',
  trial:          'bg-amber-500/10 text-amber-700',
  lead:           'bg-sky-500/10 text-sky-700',
  cold:           'bg-slate-500/10 text-slate-700',
  ex_member:      'bg-red-500/10 text-red-700',
  tour:           'bg-violet-500/10 text-violet-700',
  no_sale_tour:   'bg-slate-500/10 text-slate-700',
  no_sale_trial:  'bg-slate-500/10 text-slate-700',
})

const TONE_DEFAULT = 'bg-slate-500/10 text-slate-700'

/**
 * Return a Tailwind class string for a status badge.
 * Uses the -700 text ramp convention for text on light card surfaces.
 * Falls back to a neutral slate tone for unknown statuses.
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function accountStatusTone(status) {
  if (!status) return TONE_DEFAULT
  return STATUS_TONES[status] || TONE_DEFAULT
}
