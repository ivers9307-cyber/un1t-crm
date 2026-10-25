// shared/qualifications.js
//
// QUALS.1 — staff qualifications with expiry (first aid, insurance, Garda
// vetting, and whatever else an organisation adds). PURE: no IO, no clock,
// no host timezone. Dates are Dublin calendar days as 'YYYY-MM-DD', compared
// as day numbers built with Date.UTC, so nothing moves with the machine's zone.
//
// One record per (person, type). A record with no expires_on does not expire.
// The status of a record ON a day:
//   missing   no record
//   expired   expires_on is before the day
//   expiring  expires_on is the day itself or within the next windowDays (30)
//   valid     later than that, or no expiry
//   null      a date that cannot be read: unknown, never an all-clear and
//             never an alarm
//
// A template's requirement is ADVISORY. requirementGaps() judges on the
// SHIFT's date, and only `missing` and `expired` are gaps: a certificate
// that expires on the day of the shift still covers it. Nothing here refuses
// anything; the pickers badge.
//
// Web only today (the qualifications page, the template editor, the ranked
// picker via shared/candidates.js). It lives in shared/ so the phone can
// adopt it without a copy.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const QUALIFICATION_EXPIRY_WINDOW_DAYS = 30
export const QUALIFICATION_STATUSES = Object.freeze(['valid', 'expiring', 'expired', 'missing'])
export const QUALIFICATION_STATUS_TONES = Object.freeze({ valid: 'good', expiring: 'warn', expired: 'bad', missing: 'muted' })

// A real calendar day → a whole day number; anything else → null.
// Date.UTC rolls 2026-02-30 over to 2 March, so read the parts back.
function dayNumber(iso) {
  const m = String(iso ?? '').match(ISO_DAY)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(ms / DAY_MS)
}

const hasNoExpiry = (record) => record.expires_on == null || record.expires_on === ''
const cmpText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { sensitivity: 'base' })

function joinList(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Whole days from `fromISO` to `toISO` (negative when `toISO` is earlier); null if either is unreadable. */
export function qualificationDaysUntil(fromISO, toISO) {
  const a = dayNumber(fromISO)
  const b = dayNumber(toISO)
  return a === null || b === null ? null : b - a
}

/** '2026-08-31' → '31 Aug 2026'; '' for an unreadable date. */
export function formatQualificationDate(iso) {
  if (dayNumber(iso) === null) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * 'missing' | 'expired' | 'expiring' | 'valid' | null (unreadable).
 * @param {{ expires_on?: string|null }|null} record
 * @param {string} onISO  the day being judged (today, or a shift's date)
 */
export function qualificationStatus(record, onISO, { windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS } = {}) {
  if (!record) return 'missing'
  if (hasNoExpiry(record)) return 'valid'
  const days = qualificationDaysUntil(onISO, record.expires_on)
  if (days === null) return null
  if (days < 0) return 'expired'
  if (days <= windowDays) return 'expiring'
  return 'valid'
}

/** The row's second line on the qualifications page. */
export function qualificationStatusLabel(record, onISO, opts) {
  const status = qualificationStatus(record, onISO, opts)
  if (status === 'missing') return 'Not on record'
  if (status === null) return 'Expiry date unreadable'
  if (hasNoExpiry(record)) return 'No expiry'
  const days = qualificationDaysUntil(onISO, record.expires_on)
  const when = formatQualificationDate(record.expires_on)
  if (status === 'expired') return days === -1 ? `Expired yesterday (${when})` : `Expired ${when}`
  if (status === 'expiring') {
    if (days === 0) return 'Expires today'
    if (days === 1) return 'Expires tomorrow'
    return `Expires in ${days} days (${when})`
  }
  return `Valid until ${when}`
}

/** The page's "Needs attention" filter: any record expired or expiring on `onISO`. */
export function personNeedsAttention(records, onISO) {
  return (records || []).some((r) => {
    const s = qualificationStatus(r, onISO)
    return s === 'expired' || s === 'expiring'
  })
}

/**
 * What one person lacks for one shift, judged on the shift's date.
 * @param {{ required: Array<{ id, name }>, records: Array<{ qualification_type_id, expires_on }>, onISO: string }} args
 *   `records` are THIS person's.
 * @returns {Array<{ type_id, name, status: 'missing'|'expired', expires_on }>} sorted by name
 */
export function requirementGaps({ required = [], records = [], onISO } = {}) {
  const gaps = []
  for (const t of required || []) {
    if (!t?.id) continue
    const rec = (records || []).find((r) => r?.qualification_type_id === t.id) || null
    // windowDays 0: expiring ON the shift day still covers the shift.
    const status = qualificationStatus(rec, onISO, { windowDays: 0 })
    if (status === 'missing' || status === 'expired') {
      gaps.push({ type_id: t.id, name: t.name || 'Qualification', status, expires_on: rec?.expires_on ?? null })
    }
  }
  return gaps.sort((a, b) => cmpText(a.name, b.name) || String(a.type_id).localeCompare(String(b.type_id)))
}

const gapWords = (g) => (g.status === 'expired'
  ? `expired ${formatQualificationDate(g.expires_on)}`.trim()
  : 'not on record')

/**
 * The web picker's badge for a candidate's gaps, in candidateBadges' shape
 * ({ key, tone, text, title }), or null when nothing is missing.
 */
export function qualificationGapBadge(gaps) {
  const list = (Array.isArray(gaps) ? gaps : []).filter((g) => g && (g.status === 'missing' || g.status === 'expired'))
  if (list.length === 0) return null
  const text = list.length === 1
    ? `${list[0].name}: ${list[0].status === 'expired' ? 'expired' : 'not on record'}`
    : `${list.length} qualifications missing or expired`
  return {
    key: 'qualifications',
    tone: 'warn',
    text,
    title: `This shift asks for ${joinList(list.map((g) => `${g.name} (${gapWords(g)})`))}. Advisory only: you can still assign them.`,
  }
}

/**
 * Copies of ranked candidates, each with `qualification_gaps`. With nothing
 * required, the SAME array comes back (no field is added). Never re-ranks.
 */
export function attachQualificationGaps(candidates, { required = [], records = [], onISO } = {}) {
  if (!Array.isArray(candidates)) return []
  if (!required?.length) return candidates
  const byProfile = new Map()
  for (const r of records || []) {
    if (!r?.profile_id) continue
    if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
    byProfile.get(r.profile_id).push(r)
  }
  return candidates.map((c) => (c?.profile_id
    ? { ...c, qualification_gaps: requirementGaps({ required, records: byProfile.get(c.profile_id) || [], onISO }) }
    : c))
}

/**
 * The owner digest's rows: records of these people, of ACTIVE types, that are
 * expired or expiring on `todayISO`. Expired first (oldest first), then
 * expiring (soonest first), then name, then type.
 */
export function digestRows({ people = [], types = [], records = [], todayISO, windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS } = {}) {
  const names = new Map((people || []).filter((p) => p?.profile_id).map((p) => [p.profile_id, p.full_name ?? null]))
  const typeNames = new Map((types || []).filter((t) => t?.id && t.active !== false).map((t) => [t.id, t.name]))
  const rows = []
  for (const r of records || []) {
    if (!names.has(r?.profile_id) || !typeNames.has(r?.qualification_type_id)) continue
    const status = qualificationStatus(r, todayISO, { windowDays })
    if (status !== 'expired' && status !== 'expiring') continue
    rows.push({
      profile_id: r.profile_id,
      full_name: names.get(r.profile_id),
      type_id: r.qualification_type_id,
      type_name: typeNames.get(r.qualification_type_id),
      expires_on: r.expires_on,
      status,
      days: qualificationDaysUntil(todayISO, r.expires_on),
    })
  }
  const rank = { expired: 0, expiring: 1 }
  return rows.sort((a, b) => rank[a.status] - rank[b.status]
    || a.expires_on.localeCompare(b.expires_on)
    || cmpText(a.full_name, b.full_name)
    || cmpText(a.type_name, b.type_name)
    || String(a.profile_id).localeCompare(String(b.profile_id)))
}

/** '1 qualification has expired and 2 more expire in the next 30 days.' or null. */
export function digestHeadline(rows, windowDays = QUALIFICATION_EXPIRY_WINDOW_DAYS) {
  const expired = (rows || []).filter((r) => r?.status === 'expired').length
  const expiring = (rows || []).filter((r) => r?.status === 'expiring').length
  const some = (n) => (n === 1 ? '1 qualification' : `${n} qualifications`)
  const hasHave = (n) => (n === 1 ? 'has' : 'have')
  const expireVerb = (n) => (n === 1 ? 'expires' : 'expire')
  if (expired && expiring) return `${some(expired)} ${hasHave(expired)} expired and ${expiring} more ${expireVerb(expiring)} in the next ${windowDays} days.`
  if (expired) return `${some(expired)} ${hasHave(expired)} expired.`
  if (expiring) return `${some(expiring)} ${expireVerb(expiring)} in the next ${windowDays} days.`
  return null
}

/**
 * The template editor's reading of GET /api/schedule/template-qualifications.
 * { ok: true, types, requirements } or { ok: false } (not loaded, refused, or
 * a shape it does not know): the editor then shows no field and saves none.
 */
export function parseTemplateQualificationsAnswer(json) {
  if (!json || json.success !== true) return { ok: false }
  const d = json.data
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false }
  if (!Array.isArray(d.types) || !d.requirements || typeof d.requirements !== 'object' || Array.isArray(d.requirements)) return { ok: false }
  const requirements = {}
  for (const [templateId, ids] of Object.entries(d.requirements)) {
    if (Array.isArray(ids)) requirements[templateId] = ids.filter((id) => typeof id === 'string' && id)
  }
  return { ok: true, types: d.types.filter((t) => t && t.id && t.name), requirements }
}
