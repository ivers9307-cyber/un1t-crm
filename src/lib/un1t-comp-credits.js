// UN1TCOMP.1 — complimentary un1t.online credits from the contact page
// (Richard's decision 28 Oct 2026). The rules the Hatch card's form and the
// staff route share, so the browser shows exactly what the server enforces:
// the limits, the fixed reasons, the team note's rules, and the use-by maths.
//
// Pure and client-safe (the card imports it): no database, no write module.
//
// The use-by date is a CALENDAR day on the studio's clock (its
// locations.timezone, via @shared/zoned-time). "Today" is todayStrIn(zone),
// never a UTC date, and the days until a use-by date are counted on date keys
// (zone-free once "today" is known), so a DST change never adds or loses a
// day. un1t.online takes `expiresInDays` and answers with its own expires_at,
// which is what staff are shown after the grant.

import { todayStrIn, addDaysISO, DAY_MS } from '@shared/zoned-time'

export const COMP_CREDIT_LIMITS = Object.freeze({ minCredits: 1, maxCredits: 10, minDays: 1, maxDays: 365, noteMax: 200 })

/** The reasons staff pick from (required). Keys are stored on the ledger (mig 787 CHECK). */
export const COMP_CREDIT_REASONS = Object.freeze([
  Object.freeze({ key: 'goodwill', label: 'Goodwill' }),
  Object.freeze({ key: 'injury', label: 'Injury' }),
  Object.freeze({ key: 'class_cancelled', label: 'Class cancelled by us' }),
  Object.freeze({ key: 'referral_reward', label: 'Referral reward' }),
  Object.freeze({ key: 'other', label: 'Other' }),
])
export const COMP_CREDIT_REASON_KEYS = Object.freeze(COMP_CREDIT_REASONS.map((r) => r.key))

export const compReasonLabel = (key) => COMP_CREDIT_REASONS.find((r) => r.key === key)?.label ?? 'Other'

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/
function utcOf(key) {
  const m = typeof key === 'string' ? DATE_KEY.exec(key) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return t
}

/** A real 'YYYY-MM-DD' calendar day. */
export const isDateKey = (v) => utcOf(v) != null

/**
 * The studio's today, and the earliest (tomorrow) and latest (a year ahead)
 * use-by date the form offers and the route accepts.
 * @returns {{ today: string, min: string, max: string }}
 */
export function compUseByBounds(zone, nowMs = Date.now()) {
  const today = todayStrIn(zone, nowMs)
  return { today, min: addDaysISO(today, COMP_CREDIT_LIMITS.minDays), max: addDaysISO(today, COMP_CREDIT_LIMITS.maxDays) }
}

/**
 * Whole calendar days from the studio's today to `useBy` (1 = tomorrow);
 * null for anything that is not a calendar day. This is un1t.online's
 * expiresInDays.
 */
export function compDaysUntil(useBy, zone, nowMs = Date.now()) {
  const end = utcOf(useBy)
  if (end == null) return null
  return Math.round((end - utcOf(todayStrIn(zone, nowMs))) / DAY_MS)
}

/** A quick pick ('week' | 'two_weeks' | 'month') as a use-by date key; null for anything else. */
export function compQuickPick(pick, zone, nowMs = Date.now()) {
  const today = todayStrIn(zone, nowMs)
  if (pick === 'week') return addDaysISO(today, 7)
  if (pick === 'two_weeks') return addDaysISO(today, 14)
  if (pick !== 'month') return null
  // The same day next month, or that month's last day when it is shorter.
  const [y, m, d] = today.split('-').map(Number)
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'Thu 5 Nov' for a date key (a calendar day: no zone applies); '' for anything else. */
export function formatUseBy(key) {
  const t = utcOf(key)
  if (t == null) return ''
  const d = new Date(t)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export const compCreditsPhrase = (n) => `${n} complimentary credit${n === 1 ? '' : 's'}`

/**
 * The form's live line: "Adds N credits in un1t.online, usable until
 * <Day D Mon> (X days)." null while the date is not inside the window.
 */
export function compSummary({ amount, useBy, zone, nowMs = Date.now() }) {
  const days = compDaysUntil(useBy, zone, nowMs)
  if (days == null || days < COMP_CREDIT_LIMITS.minDays || days > COMP_CREDIT_LIMITS.maxDays) return null
  if (!Number.isInteger(amount) || amount < COMP_CREDIT_LIMITS.minCredits || amount > COMP_CREDIT_LIMITS.maxCredits) return null
  return `Adds ${amount} credit${amount === 1 ? '' : 's'} in un1t.online, usable until ${formatUseBy(useBy)} (${days} day${days === 1 ? '' : 's'}).`
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/
// Seven or more digits, allowing the spaces, dots, dashes and brackets a phone
// number is written with (a year or a class count is shorter).
const PHONE = /(?:\+?\d[\s().-]*){7,}/
const MARKUP = /[<>]/

/**
 * Why a team note cannot be stored, or null when it can. It is plain text
 * for the team; the ledger never holds an email address or a phone number.
 */
export function compNoteProblem(note) {
  const text = typeof note === 'string' ? note.trim() : ''
  if (!text) return null
  if (Array.from(text).length > COMP_CREDIT_LIMITS.noteMax) return `The note can be at most ${COMP_CREDIT_LIMITS.noteMax} characters.`
  if (MARKUP.test(text)) return 'The note must be plain text.'
  if (EMAIL.test(text)) return 'Leave email addresses out of the note.'
  if (PHONE.test(text)) return 'Leave phone numbers out of the note.'
  return null
}
