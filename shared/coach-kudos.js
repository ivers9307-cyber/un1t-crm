// Coach Kudos — pure formatting/model helpers shared by champ-app
// (customer read side) and un1t-crm (staff send side write to the same
// `public.coach_kudos` table). No IO, no deps beyond Intl — fixture-testable.
//
// SCHEMA CONTRACT (public.coach_kudos, mig 355 — NOT yet applied to prod):
//   id uuid | contact_id uuid (recipient) | location_id uuid |
//   sender_profile_id uuid | sender_name text | message text (1..500) |
//   emoji text|null | session_id uuid|null | created_at timestamptz |
//   seen_at timestamptz|null
//
// The customer only ever reads their OWN rows (RLS: contact_id =
// private.auth_contact_id(), same customer-self pattern as heart_rate_sessions).

// Message length bounds — mirror the CHECK the un1t-crm migration enforces.
// Kept here so both sides validate identically (defence in depth; the DB is
// the source of truth).
export const KUDOS_MESSAGE_MIN = 1
export const KUDOS_MESSAGE_MAX = 500

/**
 * True when the kudos has not yet been seen by the member.
 * @param {{seen_at?: string|null}} kudos
 * @returns {boolean}
 */
export function isUnseen(kudos) {
  return !!kudos && kudos.seen_at == null
}

/**
 * Count of unseen kudos in a list.
 * @param {Array<{seen_at?: string|null}>} list
 * @returns {number}
 */
export function unseenCount(list) {
  return (list || []).reduce((n, k) => (isUnseen(k) ? n + 1 : n), 0)
}

/**
 * Compact, human relative time for a kudos `created_at`, e.g. "just now",
 * "5m ago", "3h ago", "2d ago", "3w ago", or a plain date for older items.
 * Deliberately dependency-free (no date lib) and locale-stable.
 *
 * @param {string|number|Date} isoOrMs  created_at
 * @param {number} [nowMs=Date.now()]   injectable clock for tests
 * @returns {string}
 */
export function kudosRelativeTime(isoOrMs, nowMs = Date.now()) {
  const t =
    isoOrMs instanceof Date
      ? isoOrMs.getTime()
      : typeof isoOrMs === 'number'
        ? isoOrMs
        : Date.parse(isoOrMs)
  if (!Number.isFinite(t)) return ''
  const diffMs = nowMs - t
  // Future timestamps (clock skew) — treat as just now rather than "-3m".
  if (diffMs < 0) return 'just now'

  const sec = Math.floor(diffMs / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w ago`

  // Older than ~a month — show a plain calendar date (Dublin gym, so format
  // in Europe/Dublin for consistency with the rest of the app).
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Dublin',
  }).format(new Date(t))
}

/**
 * Normalise a raw DB row into a display-safe shape. Guards against a null/
 * blank sender_name (falls back to "Your coach") and trims the message.
 * Does NOT truncate — the UI decides how many lines to show.
 *
 * @param {object} row  a coach_kudos row
 * @returns {{
 *   id: string, message: string, emoji: string|null,
 *   senderName: string, createdAt: string|null, seen: boolean
 * }}
 */
export function toKudosView(row) {
  const senderName =
    typeof row?.sender_name === 'string' && row.sender_name.trim()
      ? row.sender_name.trim()
      : 'Your coach'
  return {
    id: row?.id,
    message: typeof row?.message === 'string' ? row.message.trim() : '',
    emoji: row?.emoji || null,
    senderName,
    createdAt: row?.created_at || null,
    seen: !isUnseen(row),
  }
}
