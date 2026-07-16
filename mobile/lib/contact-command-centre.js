// CC-M.1 — pure helpers for the mobile contact command-centre screen
// (mobile/app/contacts/[id].jsx), mirroring the web command-centre's
// derivations (src/lib/contact-view.js mergeTimeline/timelineFilterGroup,
// GlofoxProfileCard's status/state/tenure/billing logic, and the
// EventRegistrationsCards status colours).
//
// Mobile cannot import src/lib (the shared/ seam is the only bridge and
// none of this is re-exported there), so these are deliberate ports with
// their own tests. Kept free of react-native imports so the repo's Node
// vitest collects mobile/lib/**/*.test.js.
//
// One deliberate divergence from the web mergeTimeline: on web the raw
// activity row spreads LAST, so the activity's own `type` column clobbers
// the 'activity' tag and `item.type === 'activity'` is unreliable. Here
// the meta keys spread last, so `kind` ('note' | 'activity') is a
// trustworthy discriminator alongside `activityType`.

// ── timeline ─────────────────────────────────────────────────────────

const MESSAGE_TYPES = new Set(['whatsapp_sent', 'whatsapp_received', 'sms_sent', 'email'])

/**
 * Unified timeline: notes + activities, newest first.
 * @param {Array|null} notes       rows from the notes table
 * @param {Array|null} activities  rows from the activities table
 * @returns {Array} items tagged { kind, activityType, date, ...row }
 */
export function mergeTimeline(notes, activities) {
  return [
    ...(notes || []).map((n) => ({ ...n, kind: 'note', activityType: 'note', date: n.created_at })),
    ...(activities || []).map((a) => ({ ...a, kind: 'activity', activityType: a.type || 'task', date: a.created_at })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))
}

/** Filter-pill grouping — same mapping as the web contact-view helper. */
export function timelineFilterGroup(item) {
  const t = item?.activityType
  if (t === 'booking') return 'classes'
  if (MESSAGE_TYPES.has(t)) return 'messages'
  if (t === 'note') return 'notes'
  return 'system'
}

export const TIMELINE_FILTERS = Object.freeze([
  { key: 'all', label: 'All' },
  { key: 'classes', label: 'Classes' },
  { key: 'messages', label: 'Messages' },
  { key: 'notes', label: 'Notes' },
  { key: 'system', label: 'System' },
])

/**
 * GLOFOX-NOTES provenance — inbound Glofox interactions sync in as
 * activities rows with source='glofox' (mig 138); CRM notes never carry
 * the column. Mirrors the web timeline's Glofox chip condition.
 */
export function isGlofoxSynced(item) {
  return item?.kind === 'activity' && item?.source === 'glofox'
}

// Ionicons name + light-theme tint per activity type. Labels mirror the
// web ContactTimeline activityIcons map. `color` is a raw hex because
// Ionicons' color prop can't take a NativeWind class (same rationale as
// mobile/lib/colors.js); each is the tailwind -700 ramp matching `bg`.
const TIMELINE_ICON_META = Object.freeze({
  note: { icon: 'chatbubble-ellipses-outline', label: 'Note', bg: 'bg-blue-500/10', color: '#1D4ED8' },
  call: { icon: 'call-outline', label: 'Call', bg: 'bg-yellow-500/10', color: '#A16207' },
  email: { icon: 'mail-outline', label: 'Email', bg: 'bg-purple-500/10', color: '#7E22CE' },
  meeting: { icon: 'calendar-outline', label: 'Meeting', bg: 'bg-green-500/10', color: '#15803D' },
  task: { icon: 'checkbox-outline', label: 'Task', bg: 'bg-orange-500/10', color: '#C2410C' },
  booking: { icon: 'book-outline', label: 'Booking', bg: 'bg-indigo-500/10', color: '#4338CA' },
  pipeline: { icon: 'arrow-forward-outline', label: 'Pipeline', bg: 'bg-emerald-500/10', color: '#047857' },
  whatsapp_sent: { icon: 'logo-whatsapp', label: 'WhatsApp Sent', bg: 'bg-green-500/10', color: '#15803D' },
  whatsapp_received: { icon: 'logo-whatsapp', label: 'WhatsApp Received', bg: 'bg-green-500/10', color: '#15803D' },
  sms_sent: { icon: 'chatbubble-outline', label: 'SMS Sent', bg: 'bg-cyan-500/10', color: '#0E7490' },
})

/** Icon/label/tint for a timeline item's activityType; unknown → task. */
export function timelineIconMeta(activityType) {
  return TIMELINE_ICON_META[activityType] || TIMELINE_ICON_META.task
}

// ── Glofox membership meta ───────────────────────────────────────────
// Chip classes follow the light-theme recipe (bg-<c>-500/10 text-<c>-700)
// — the mobile CRM app renders on white, same rule as web cards.

const GLOFOX_STATUS_META = Object.freeze({
  cold: { label: 'Cold', cls: 'bg-gray-500/10', text: 'text-gray-700' },
  tour: { label: 'Tour booked', cls: 'bg-blue-500/10', text: 'text-blue-700' },
  no_sale_tour: { label: 'No sale (tour)', cls: 'bg-amber-500/10', text: 'text-amber-700' },
  trial: { label: 'Trial', cls: 'bg-blue-500/10', text: 'text-blue-700' },
  no_sale_trial: { label: 'No sale (trial)', cls: 'bg-amber-500/10', text: 'text-amber-700' },
  member: { label: 'Member', cls: 'bg-emerald-500/10', text: 'text-emerald-700' },
  credit_member: { label: 'Credit Member', cls: 'bg-teal-500/10', text: 'text-teal-700' },
  classpass_payg: { label: 'ClassPass PAYG', cls: 'bg-purple-500/10', text: 'text-purple-700' },
  ex_member: { label: 'Ex-member', cls: 'bg-red-500/10', text: 'text-red-700' },
  lead: { label: 'Lead', cls: 'bg-gray-500/10', text: 'text-gray-700' },
})

/** Lead-status chip; unknown-but-present statuses render as-is in gray. */
export function glofoxStatusMeta(status) {
  if (!status) return null
  return GLOFOX_STATUS_META[status]
    || { label: status, cls: 'bg-gray-500/10', text: 'text-gray-700' }
}

// LIVE membership lifecycle state (membership.status) — distinct from
// lead_status above. Glofox 'locked' = frozen on a failed payment, i.e.
// the arrears signal the web card and churn radar key on.
const GLOFOX_STATE_META = Object.freeze({
  active: { label: 'Active', cls: 'bg-emerald-500/10', text: 'text-emerald-700' },
  paused: { label: 'Paused', cls: 'bg-amber-500/10', text: 'text-amber-700' },
  locked: { label: 'Overdue', cls: 'bg-red-500/10', text: 'text-red-700' },
  future: { label: 'Upcoming', cls: 'bg-blue-500/10', text: 'text-blue-700' },
})

/** Live membership-state chip (locked → "Overdue"); unknown → null. */
export function glofoxStateMeta(state) {
  return GLOFOX_STATE_META[state] || null
}

// ── formatting (ports of src/components/contact/format.js) ──────────

export function relativeTime(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  const abs = Math.abs(ms)
  const future = ms < 0
  const days = Math.floor(abs / 86_400_000)
  if (days < 1) {
    const hours = Math.floor(abs / 3_600_000)
    if (hours < 1) return future ? 'in a moment' : 'just now'
    return future ? `in ${hours}h` : `${hours}h ago`
  }
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30.44)
  return future ? `in ${months}mo` : `${months}mo ago`
}

export function formatMoney(cents, currency) {
  if (!Number.isFinite(cents)) return null
  const amount = cents / 100
  const SYM = { EUR: '€', GBP: '£', USD: '$' }
  const sym = SYM[currency] || (currency ? `${currency} ` : '€')
  return sym + amount.toLocaleString('en-IE', { maximumFractionDigits: 0 })
}

export function formatShortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "Joined 3 months ago" — port of GlofoxProfileCard.formatTenure. */
export function formatTenure(joinedAtIso) {
  if (!joinedAtIso) return null
  const ms = Date.now() - new Date(joinedAtIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const days = Math.floor(ms / 86_400_000)
  if (days < 30) return `Joined ${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `Joined ${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(months / 12)
  const remMonths = months % 12
  return `Joined ${years}y${remMonths ? ` ${remMonths}mo` : ''} ago`
}

/** Title-case a Glofox slug-ish value ("direct_debit" → "Direct debit"). */
export function humanise(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const s = value.trim().replace(/[_-]+/g, ' ').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const MEMBERSHIP_TYPE_LABEL = Object.freeze({
  time: 'Subscription',
  num_classes: 'Class pack',
  payg: 'Pay as you go',
})

/** "€120 / 6 months · Subscription" — port of the web card's billing line. */
export function billingLine(contact) {
  const price = Number.isFinite(contact?.glofox_membership_price_cents) && contact.glofox_membership_price_cents > 0
    ? formatMoney(contact.glofox_membership_price_cents, contact.lifetime_currency)
    : null
  const interval = contact?.glofox_billing_interval || null
  const membershipType = MEMBERSHIP_TYPE_LABEL[contact?.glofox_membership_type]
    || humanise(contact?.glofox_membership_type)
  return [
    price && interval ? `${price} / ${interval}` : price || (interval ? `Billed every ${interval}` : null),
    membershipType,
  ].filter(Boolean).join(' · ')
}

// ── bookings ─────────────────────────────────────────────────────────

/**
 * CRM-native event bookings split, mirroring the web page:
 * upcoming = booking_date >= today AND confirmed; everything else is past.
 * booking_date is Dublin wall-clock (repo invariant) — callers pass a
 * local-time todayStr (mobile/lib/dates.js isoDate), never a UTC slice.
 * Upcoming sorts soonest-first, past newest-first (phone reading order).
 */
export function splitCrmBookings(rows, todayStr) {
  const list = rows || []
  const key = (b) => `${b.booking_date || ''}T${b.start_time || ''}`
  const upcoming = list
    .filter((b) => b.booking_date >= todayStr && b.status === 'confirmed')
    .sort((a, b) => key(a).localeCompare(key(b)))
  const past = list
    .filter((b) => b.booking_date < todayStr || b.status !== 'confirmed')
    .sort((a, b) => key(b).localeCompare(key(a)))
  return { upcoming, past }
}

// Mirrors web EventRegistrationsCards' bookingStatusColors, on the
// light-theme chip ramp.
const CRM_BOOKING_STATUS_META = Object.freeze({
  confirmed: { label: 'Confirmed', cls: 'bg-blue-500/10', text: 'text-blue-700' },
  completed: { label: 'Completed', cls: 'bg-green-500/10', text: 'text-green-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-500/10', text: 'text-red-700' },
  no_show: { label: 'No-show', cls: 'bg-yellow-500/10', text: 'text-yellow-700' },
})

export function crmBookingStatusMeta(status) {
  if (!status) return null
  return CRM_BOOKING_STATUS_META[status]
    || { label: humanise(status), cls: 'bg-gray-500/10', text: 'text-gray-700' }
}

/**
 * Glofox class bookings from the denormalised contacts.recent_bookings
 * JSONB (epoch-second time_start) — port of the web card's
 * BookingsSubsection split.
 */
export function splitGlofoxBookings(bookings, nowSec) {
  const list = Array.isArray(bookings) ? bookings : []
  const upcoming = list
    .filter((b) => Number(b.time_start) > nowSec)
    .sort((a, b) => Number(a.time_start) - Number(b.time_start))
  const past = list
    .filter((b) => Number(b.time_start) <= nowSec)
    .sort((a, b) => Number(b.time_start) - Number(a.time_start))
  return { upcoming, past }
}

/** Badge for one Glofox class row — port of the web BookingRow logic. */
export function glofoxBookingBadge(b, when) {
  const status = String(b?.status || '').toUpperCase()
  const isCancelled = status === 'CANCELED' || status === 'CANCELLED'
  if (isCancelled) return { label: 'Cancelled', cls: 'bg-red-500/10', text: 'text-red-700' }
  if (status === 'WAITING') return { label: 'Waitlist', cls: 'bg-purple-500/10', text: 'text-purple-700' }
  if (when === 'past' && status === 'BOOKED') {
    return b.attended === true
      ? { label: 'Attended', cls: 'bg-green-500/10', text: 'text-green-700' }
      : { label: 'No-show', cls: 'bg-amber-500/10', text: 'text-amber-700' }
  }
  if (when === 'future' && status === 'BOOKED') {
    return { label: 'Booked', cls: 'bg-blue-500/10', text: 'text-blue-700' }
  }
  return null
}

/** Epoch-second → "Mon 14 Jul, 07:00" (en-IE, matches the web card). */
export function formatGlofoxBookingTime(timeStartSec) {
  const n = Number(timeStartSec)
  if (!n) return ''
  return new Date(n * 1000).toLocaleString('en-IE', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
