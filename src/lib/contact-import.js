// Contact CSV import (mig 095).
//
// Three responsibilities:
//
//   1. parseCsv(text) — minimal RFC-4180 reader. Avoids a Papa Parse
//      dependency for the one use case. Header row → object keys,
//      body rows → objects. Quoted fields, escaped quotes, CRLF and
//      LF endings all handled.
//
//   2. autoMapHeaders(headers) — best-effort exact-match mapping
//      from CSV header → contact field. Covers the common spellings
//      operators use (Email, Email Address, email, e_mail, etc.).
//      The wizard's Map step is the manual override.
//
//   3. validateRow(row, mappedFields, opts) — pure validator. Given
//      a CSV row + the mapping, return either a normalised contact
//      payload OR a structured error. Used by both the dry-run and
//      the commit path so the two stay in lock-step.
//
// The orchestration (DB lookups, batch insert, before_snapshot
// capture) lives in the API routes — keeping this lib pure means
// every branch is unit-testable without standing up Supabase.

import { z } from 'zod'
import { leadSourceSchema, email as emailSchema, phone as phoneSchema } from './schemas'

// Fields the import is authoritative for. Anything outside this
// list is silently dropped. Order matters for the CSV template
// download — operators see the columns in this order.
export const IMPORT_FIELDS = Object.freeze([
  { key: 'first_name',         label: 'First name',         hint: '' },
  { key: 'last_name',          label: 'Last name',          hint: '' },
  { key: 'email',              label: 'Email',              hint: 'Required. Match key for update vs create.' },
  { key: 'phone',              label: 'Phone',              hint: 'E.164 format ideally (+353871234567).' },
  { key: 'lead_source',        label: 'Lead source',        hint: 'booking / meta / tiktok / walkin / referral / website / whatsapp / other' },
  { key: 'label',              label: 'Label',              hint: 'Free-form bucket — e.g. VIP, deposit-paid.' },
  { key: 'glofox_member_id',   label: 'Glofox member ID',   hint: '' },
  { key: 'tags',               label: 'Tags',               hint: 'Comma-separated. Merged with the batch tag if set.' },
])

export const IMPORT_FIELD_KEYS = Object.freeze(IMPORT_FIELDS.map(f => f.key))

// Header strings we'll auto-map without operator intervention.
// Lower-cased + collapsed-whitespace key → contact field.
const AUTO_MAP = {
  'first name': 'first_name',     'firstname': 'first_name',     'fname': 'first_name',  'given name': 'first_name',
  'last name': 'last_name',       'lastname': 'last_name',       'lname': 'last_name',   'surname': 'last_name',  'family name': 'last_name',
  'email': 'email',               'email address': 'email',      'e-mail': 'email',      'mail': 'email',
  'phone': 'phone',                'phone number': 'phone',       'mobile': 'phone',      'mobile number': 'phone', 'tel': 'phone',
  'lead source': 'lead_source',    'source': 'lead_source',
  'label': 'label',
  'glofox member id': 'glofox_member_id', 'glofox id': 'glofox_member_id', 'member id': 'glofox_member_id',
  'tags': 'tags',                  'tag': 'tags',
}

/**
 * Best-effort header → field mapping. Returns
 *   { [csvHeader]: 'contact_field_or_null' }
 * Caller's UI lets the operator override anything we got wrong, or
 * fill in the nulls.
 */
export function autoMapHeaders(headers) {
  const out = {}
  for (const h of headers || []) {
    const norm = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ')
    out[h] = AUTO_MAP[norm] || null
  }
  return out
}

/**
 * RFC-4180 ish CSV parser. Returns { headers, rows } where rows is
 * an array of objects keyed by the header strings.
 *
 * Limitations (acceptable for the import use case):
 *   - Assumes UTF-8 input (callers handle decoding).
 *   - Doesn't accept a custom delimiter — comma only. Operators with
 *     semicolon CSVs from Excel-on-EU should re-export.
 *   - A row whose field count doesn't match the header count is
 *     padded with empty strings (extra columns dropped silently).
 */
export function parseCsv(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!src.trim()) return { headers: [], rows: [] }

  const rows = []
  let i = 0
  const len = src.length
  while (i < len) {
    const { fields, next } = parseLine(src, i)
    rows.push(fields)
    i = next
    if (i < len && src[i] === '\n') i += 1
  }
  // Drop a trailing empty row if the file ended with \n.
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop()
  }
  if (rows.length === 0) return { headers: [], rows: [] }

  const headers = rows.shift().map((h) => String(h || '').trim())
  const objects = rows.map((cells) => {
    const obj = {}
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] != null ? String(cells[c]) : ''
    }
    return obj
  })
  return { headers, rows: objects }
}

// One line of CSV starting at index `start`. Returns
// { fields: string[], next: indexOfNewlineOrEnd }.
function parseLine(src, start) {
  const fields = []
  let i = start
  let cur = ''
  let inQuotes = false
  while (i < src.length) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote (`""`) → literal quote.
        if (i + 1 < src.length && src[i + 1] === '"') {
          cur += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      cur += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      fields.push(cur)
      cur = ''
      i += 1
      continue
    }
    if (ch === '\n') {
      fields.push(cur)
      return { fields, next: i }
    }
    cur += ch
    i += 1
  }
  fields.push(cur)
  return { fields, next: i }
}

// Validation schemas reused from src/lib/schemas.js so the import
// path doesn't drift from the rest of the contact write surface.
const RowSchema = z.object({
  first_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional().nullable(),
  email: emailSchema,
  phone: phoneSchema.optional().nullable(),
  lead_source: leadSourceSchema.optional().nullable(),
  label: z.string().max(100).optional().nullable(),
  glofox_member_id: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
})

/**
 * Convert a raw CSV row + mapping into either a validated contact
 * payload OR a structured error. Pure — no DB access. The caller
 * runs the email-dedupe lookup and decides create vs update.
 *
 * @param {object} rawRow         CSV row (header → cell value)
 * @param {object} mapping        { csvHeader: contactField }
 * @param {object} [opts]
 * @param {string[]} [opts.batchTags]  added to every row's tags
 * @returns {{ ok: true, payload }} | { ok: false, error: string }
 */
export function validateRow(rawRow, mapping, opts = {}) {
  // Project the raw row through the mapping into contact-field
  // shape. Anything unmapped is dropped.
  const projected = {}
  for (const [csvHeader, field] of Object.entries(mapping || {})) {
    if (!field || !IMPORT_FIELD_KEYS.includes(field)) continue
    const v = rawRow[csvHeader]
    if (v == null) continue
    const trimmed = String(v).trim()
    if (trimmed === '') continue
    projected[field] = trimmed
  }

  // Tags: split on comma, dedupe, merge with batch tags.
  const csvTags = (projected.tags || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const batchTags = (opts.batchTags || []).map(s => String(s).trim()).filter(Boolean)
  const allTags = [...new Set([...csvTags, ...batchTags])]
  if (allTags.length > 0) projected.tags = allTags
  else delete projected.tags

  // Lowercase email so dedupe works regardless of casing.
  if (projected.email) projected.email = projected.email.toLowerCase()

  const parsed = RowSchema.safeParse(projected)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue.path?.length ? issue.path.join('.') : '(row)'
    return { ok: false, error: `${path}: ${issue.message}` }
  }
  return { ok: true, payload: parsed.data }
}

/**
 * Build the full-name field from first + last + a fallback.
 *   ('Alice', 'Smith') → 'Alice Smith'
 *   ('Alice', null)    → 'Alice'
 *   (null, null) + fallback='a@x.com' → 'a@x.com'
 */
export function deriveName(firstName, lastName, fallback) {
  const f = (firstName || '').trim()
  const l = (lastName || '').trim()
  const joined = [f, l].filter(Boolean).join(' ')
  return joined || (fallback || '').trim() || 'Imported contact'
}

/**
 * Utility: which field-keys did the operator's mapping actually
 * write to? Used to scope `before_snapshot` so rollback only
 * restores what was touched.
 */
export function fieldsTouchedByMapping(mapping) {
  const keys = new Set()
  for (const v of Object.values(mapping || {})) {
    if (v && IMPORT_FIELD_KEYS.includes(v)) keys.add(v)
  }
  // tags is special — even if not mapped, a batch_tag might add it.
  // Caller passes `includeTags: true` as needed.
  return [...keys]
}

/**
 * CSV template content as a string. One header row, no body. Used
 * by the wizard's "Download template" button so operators see the
 * exact column names autoMapHeaders will recognise.
 */
export function buildCsvTemplate() {
  const headers = IMPORT_FIELDS.map(f => f.label)
  return headers.join(',') + '\n'
}
