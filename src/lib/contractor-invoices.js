// Contractor invoice helpers — period math + scheduled-hours rollup.
//
// Used by:
//   - /api/invoices POST (contractor submit) for period validation
//   - /api/invoices/[id] GET (review detail) for the hours/cost
//     comparison panel
//   - /api/invoices/[id]/approve to snapshot the at-review numbers
//     before forwarding to Xero
//
// Hours computation is OVERRIDE-AWARE: assignment.start_time_override
// and end_time_override (mig 099/100) take precedence over the
// parent block's times. So a contractor adjusted to 9-1 on a 9-5
// block contributes 4 hours, not 8 — matches what payroll.js does
// downstream.

import { shiftHours } from './payroll.js'

/**
 * Compute the calendar-month period [start, end] for a given month
 * key like '2026-05'. Returns ISO date strings (YYYY-MM-DD) so
 * Postgres date columns accept them directly.
 */
export function periodForMonth(monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new Error(`Invalid month key "${monthKey}", expected YYYY-MM.`)
  }
  const [y, m] = monthKey.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  // First day of the next month, then back off one day = last day
  // of the requested month. UTC math, no DST surprises.
  const end = new Date(Date.UTC(y, m, 0))
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' }),
  }
}

/**
 * Returns the last 12 month options as { key, label, period_start,
 * period_end } — newest first. UI uses this to build the month
 * picker; default selection is the previous month (typical
 * contractor invoicing cadence).
 */
export function recentMonthOptions(now = new Date(), count = 12) {
  const out = []
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const period = periodForMonth(key)
    out.push({ key, ...period })
  }
  return out
}

/**
 * Default month picker selection — last completed calendar month.
 * If today is May 15, defaults to April. Most contractors invoice
 * for the month just ended.
 */
export function defaultMonthKey(now = new Date()) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Compute the contractor's scheduled hours + estimated cost for a
 * given period. Pulls every shift_assignment where:
 *   - profile_id = contractor
 *   - parent block.location_id = location
 *   - parent block.block_date in [period_start, period_end]
 *
 * Hours are summed using payroll.shiftHours() so the override-aware
 * priority (assignment override → block-vs-template diff → template
 * default) is consistent everywhere.
 *
 * @param {SupabaseClient} db   service-role client
 * @param {object} args
 * @param {string} args.contractor_id
 * @param {string} args.location_id
 * @param {string} args.period_start  YYYY-MM-DD
 * @param {string} args.period_end    YYYY-MM-DD
 * @returns {Promise<{
 *   scheduled_hours: number,
 *   shift_count: number,
 *   hourly_rate: number | null,
 *   estimated_cost: number | null,
 * }>}
 */
export async function computeScheduledForPeriod(db, args) {
  const { contractor_id, location_id, period_start, period_end } = args

  // Pull the contractor's profile for the rate calc.
  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('hourly_rate, employment_type')
    .eq('id', contractor_id)
    .single()
  if (profileErr) throw new Error(`Profile lookup failed: ${profileErr.message}`)

  // Pull every assignment in the period for this contractor at this
  // location. We need the override columns + the parent block's
  // template times to feed shiftHours(). The select shape mirrors
  // what payroll.computeWeeklyCost expects (legacy shift-row shape):
  //   { start_time, end_time, start_time_override, end_time_override,
  //     shift_templates: { start_time, end_time } }
  const { data: rows, error: rowsErr } = await db
    .from('shift_assignments')
    .select(`
      id,
      start_time_override,
      end_time_override,
      shift_blocks!inner (
        block_date,
        start_time,
        end_time,
        location_id,
        shift_templates ( start_time, end_time )
      )
    `)
    .eq('profile_id', contractor_id)
    .eq('shift_blocks.location_id', location_id)
    .gte('shift_blocks.block_date', period_start)
    .lte('shift_blocks.block_date', period_end)
  if (rowsErr) throw new Error(`Assignment lookup failed: ${rowsErr.message}`)

  // Adapt each assignment to the shape shiftHours() expects.
  let totalHours = 0
  for (const row of rows || []) {
    const block = row.shift_blocks
    if (!block) continue
    const tpl = block.shift_templates || {}
    totalHours += shiftHours({
      start_time_override: row.start_time_override,
      end_time_override: row.end_time_override,
      start_time: block.start_time,
      end_time: block.end_time,
      shift_templates: { start_time: tpl.start_time, end_time: tpl.end_time },
    })
  }

  const hourlyRate = Number(profile?.hourly_rate)
  const validRate = Number.isFinite(hourlyRate) && hourlyRate > 0
  const estimated = validRate ? +(totalHours * hourlyRate).toFixed(2) : null

  return {
    scheduled_hours: +totalHours.toFixed(2),
    shift_count: (rows || []).length,
    hourly_rate: validRate ? hourlyRate : null,
    estimated_cost: estimated,
  }
}

/**
 * Format a period as a short label for emails / UI:
 *   '2026-05-01' + '2026-05-31' → 'May 2026'
 */
export function periodLabel(periodStart) {
  const d = new Date(periodStart + 'T00:00:00Z')
  return d.toLocaleDateString('en-IE', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}

/**
 * Build the storage path for an invoice PDF. Folder structure means
 * an operator browsing the bucket via dashboard can find files by
 * contractor → period.
 */
export function buildPdfPath({ contractorId, periodStart, originalFilename }) {
  const safeName = String(originalFilename || 'invoice.pdf')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100)
  // Append a short random suffix so resubmits after decline don't
  // collide on the same path.
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${contractorId}/${periodStart}-${suffix}-${safeName}`
}

/**
 * True when `path` is a contractor-invoice storage key owned by
 * `contractorId` — i.e. shaped like buildPdfPath's output and inside
 * that contractor's own folder. The JSON submit mode accepts a
 * client-supplied pdf_path (minted by /api/invoices/upload-sign), so
 * the route must refuse paths pointing at other contractors' objects
 * or anywhere else in the bucket.
 */
export function isContractorPdfPath(path, contractorId) {
  const s = String(path || '')
  if (!contractorId || !s.startsWith(`${contractorId}/`)) return false
  return /^[0-9a-fA-F-]{32,36}\/[A-Za-z0-9._-]{1,160}$/.test(s)
}

// ── Receipt / invoice attachment types ────────────────────────────
// SPEND.P1 — a contractor can now submit their monthly invoice as a
// photo of a paper receipt taken on the phone, not just a PDF. Mobile
// capture (expo-image-picker) re-encodes to JPEG in practice, but we
// accept the common image types a phone might hand over too. All of
// these render in the web reviewer's iframe and in mobile's in-app
// browser without any extra handling.

export const RECEIPT_MIME_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])

const EXT_TO_MIME = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
}

/**
 * Map a filename's extension to an accepted receipt MIME type, or null
 * if the extension isn't one we take. Case-insensitive. A fallback for
 * clients that don't report a MIME type on the picked asset.
 */
export function mimeFromFilename(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]+)$/)
  if (!m) return null
  return EXT_TO_MIME[m[1].toLowerCase()] || null
}

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1', 'heif',
])

function ascii4(bytes, start) {
  let s = ''
  for (let i = start; i < start + 4; i++) {
    const b = bytes[i]
    if (b === undefined) return ''
    s += String.fromCharCode(b)
  }
  return s
}

/**
 * Sniff a receipt's real MIME type from its leading bytes, returning a
 * value from RECEIPT_MIME_TYPES or null if the signature isn't one we
 * accept. The signed direct-to-storage upload bypasses the API, so the
 * finalise route re-checks the actual bytes here rather than trusting
 * the client-declared Content-Type — magic bytes can't be spoofed by a
 * wrong header. Accepts a Buffer or Uint8Array.
 */
export function sniffReceiptMime(bytes) {
  if (!bytes || bytes.length < 12) return null
  // PDF — "%PDF"
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'
  }
  // JPEG — FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  // WebP — "RIFF"<4-byte size>"WEBP"
  if (ascii4(bytes, 0) === 'RIFF' && ascii4(bytes, 8) === 'WEBP') {
    return 'image/webp'
  }
  // HEIC/HEIF — ISO-BMFF "ftyp" box with a HEIF-family major brand
  if (ascii4(bytes, 4) === 'ftyp') {
    const brand = ascii4(bytes, 8).toLowerCase()
    if (HEIF_BRANDS.has(brand)) {
      return (brand === 'heif' || brand === 'mif1' || brand === 'msf1')
        ? 'image/heif'
        : 'image/heic'
    }
  }
  return null
}
