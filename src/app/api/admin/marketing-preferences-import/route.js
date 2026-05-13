// CONSENT.5 — bulk import of marketing preferences from external
// platforms (Mailchimp, Klaviyo, ActiveCampaign, etc.).
//
// Multipart upload of a CSV. Tolerant column matching covers the
// most common header names from real-world exports — the operator
// can see exactly which input columns we mapped to which channels
// before they commit.
//
// Two modes:
//   ?preview=1  → dry-run. Parse the CSV, build the change plan,
//                 return counts + per-row sample. NO writes.
//   (default)   → commit. Same parsing + plan, then apply via the
//                 applyMarketingPreferencesBulk helper. Idempotent —
//                 re-running on the same CSV writes nothing for
//                 rows that already match.
//
// Master only. Synchronous Vercel request — 60s ceiling. UN1T's
// migration is well under 10k rows in practice; if we ever need
// more, switch to a background job.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { parseCsv } from '@/lib/csv-parse'
import { applyMarketingPreferencesBulk } from '@/lib/marketing-consent'
import { getClientIp } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Common column-name aliases from real exports. Keys are the
// canonical fields; values are normalised header strings (lowercase,
// non-alphanumerics → underscore — matches csv-parse's normaliseKey).
const COLUMN_ALIASES = {
  email: [
    'email', 'email_address', 'member_email', 'contact_email',
    'e_mail', 'mail', 'recipient',
  ],
  email_marketing: [
    'email_marketing', 'marketing_email', 'email_opt_in',
    'email_consent', 'newsletter', 'subscribed',
    'marketing_consent_email', 'consent_email',
  ],
  sms_marketing: [
    'sms_marketing', 'marketing_sms', 'sms_opt_in',
    'sms_consent', 'marketing_consent_sms', 'consent_sms',
    'text_marketing',
  ],
  whatsapp_marketing: [
    'whatsapp_marketing', 'marketing_whatsapp', 'whatsapp_opt_in',
    'whatsapp_consent', 'marketing_consent_whatsapp',
    'consent_whatsapp', 'wa_marketing',
  ],
  // A single column that means "this person is fully unsubscribed
  // from all marketing" — Mailchimp's "Unsubscribed" timestamp,
  // Klaviyo's "Suppressed", etc. When present and truthy, all
  // three marketing channels get set to false regardless of
  // per-channel columns.
  unsubscribed: [
    'unsubscribed', 'unsubscribed_at', 'opt_out', 'opted_out',
    'suppressed', 'do_not_contact', 'dnc',
  ],
}

const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const preview = url.searchParams.get('preview') === '1' || url.searchParams.get('preview') === 'true'

  // Parse multipart upload.
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'CSV file required (form field: file)' }, { status: 400 })
  }
  const csvText = await file.text()
  const { headers, rows } = parseCsv(csvText)
  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: 'CSV has no data rows' }, { status: 400 })
  }

  // Map the CSV's normalised column names to our canonical fields.
  // Surface the mapping so the operator can sanity-check ("yes,
  // 'Subscribed' is our email_marketing column").
  const headerKeys = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
  const mapping = {}
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = headerKeys.find((k) => aliases.includes(k))
    if (found) mapping[canonical] = found
  }
  if (!mapping.email) {
    return NextResponse.json({
      success: false,
      error: 'No email column found. Add a column named one of: ' + COLUMN_ALIASES.email.join(', '),
      headers,
    }, { status: 400 })
  }
  // Need at least one preference column to have any effect.
  const hasPreferenceColumn = ['email_marketing', 'sms_marketing', 'whatsapp_marketing', 'unsubscribed']
    .some((k) => mapping[k])
  if (!hasPreferenceColumn) {
    return NextResponse.json({
      success: false,
      error: 'No preference column found. Need one or more of: email_marketing, sms_marketing, whatsapp_marketing, unsubscribed',
      headers,
    }, { status: 400 })
  }

  // Build a contact-id lookup map by email. Paginate to defeat the
  // PostgREST 1k cap (CONSENT.5 fix — same trap as the invoice
  // backfill). Limit to the operator's active location so a
  // master can't accidentally cross-pollinate locations.
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const contactIdByEmail = new Map()
  let pageStart = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('contacts')
      .select('id, email, glofox_membership_status')
      .eq('location_id', locationId)
      .not('email', 'is', null)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error || !page || page.length === 0) break
    for (const c of page) {
      const k = String(c.email).toLowerCase().trim()
      if (!contactIdByEmail.has(k)) {
        contactIdByEmail.set(k, { id: c.id, classpass: c.glofox_membership_status === 'classpass_payg' })
      }
    }
    if (page.length < PAGE_SIZE) break
    if (contactIdByEmail.size >= HARD_LIMIT) break
    pageStart += PAGE_SIZE
  }

  // Build the change plan. One pass over the CSV — for each row
  // resolve the email, parse the boolean columns, look up the
  // contact, and slot the row into the right outcome bucket.
  const stats = {
    total_rows:        rows.length,
    matched_contacts:  0,
    unmatched_email:   0,
    classpass_skipped: 0,
    no_columns:        0,
    bad_email:         0,
  }
  const samples = {
    matched:    [],
    unmatched:  [],
    classpass:  [],
  }
  const planByContact = new Map()  // contactId → { prefs }

  for (const row of rows) {
    const emailRaw = String(row[mapping.email] || '').trim().toLowerCase()
    if (!emailRaw || !emailRaw.includes('@')) {
      stats.bad_email++
      continue
    }
    const hit = contactIdByEmail.get(emailRaw)
    if (!hit) {
      stats.unmatched_email++
      if (samples.unmatched.length < 25) samples.unmatched.push(emailRaw)
      continue
    }
    if (hit.classpass) {
      stats.classpass_skipped++
      if (samples.classpass.length < 25) samples.classpass.push(emailRaw)
      continue
    }

    // Build the desired preferences for this row.
    const prefs = {}
    const unsubFlag = mapping.unsubscribed ? parseBoolean(row[mapping.unsubscribed]) : null
    if (unsubFlag === true) {
      prefs.email_marketing    = false
      prefs.sms_marketing      = false
      prefs.whatsapp_marketing = false
    } else {
      for (const ch of ['email_marketing', 'sms_marketing', 'whatsapp_marketing']) {
        if (mapping[ch]) {
          const b = parseBoolean(row[mapping[ch]])
          if (typeof b === 'boolean') prefs[ch] = b
        }
      }
    }

    if (Object.keys(prefs).length === 0) {
      stats.no_columns++
      continue
    }

    // Last write wins if the same email appears twice.
    planByContact.set(hit.id, { email: emailRaw, prefs })
    stats.matched_contacts++
    if (samples.matched.length < 25) {
      samples.matched.push({ email: emailRaw, prefs })
    }
  }

  // Preview mode — return the plan + samples, write nothing.
  if (preview) {
    return NextResponse.json({
      success: true,
      mode:         'preview',
      mapping,
      headers,
      stats,
      samples,
      contacts_to_change: planByContact.size,
    })
  }

  // Commit mode — apply each contact's preferences via the helper.
  const ip = getClientIp(request)
  let writes = 0
  let unchanged = 0
  let errors = 0
  const errorSample = []
  for (const [contactId, { prefs }] of planByContact) {
    const out = await applyMarketingPreferencesBulk(db, {
      contactId, prefs,
      source:    'bulk_import',
      ipAddress: ip,
    })
    if (!out.ok) {
      errors++
      if (errorSample.length < 10) {
        errorSample.push({ contact_id: contactId, error: out.error })
      }
      continue
    }
    if (out.changed.length > 0) writes++
    else unchanged++
  }

  return NextResponse.json({
    success: true,
    mode:        'commit',
    mapping,
    headers,
    stats,
    samples,
    contacts_seen:    planByContact.size,
    contacts_changed: writes,
    contacts_unchanged: unchanged,
    errors,
    error_sample:     errorSample,
  })
}

/**
 * Parse a CSV cell into a boolean. Tolerant of common formats from
 * different platforms:
 *   true/false, yes/no, y/n, 1/0, x, ✓, ✗
 *   timestamp strings (anything date-like) → true (means "this date
 *     is when they unsubscribed", i.e. the flag is set)
 *   empty string → null (no value, leave the channel untouched)
 *
 * @returns {true | false | null}
 */
function parseBoolean(raw) {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim().toLowerCase()
  if (s === '') return null
  if (['true', 'yes', 'y', '1', 'x', '✓', 'subscribed', 'opted_in', 'opt_in', 'consent'].includes(s)) return true
  if (['false', 'no', 'n', '0', '✗', '-', 'unsubscribed', 'opted_out', 'opt_out'].includes(s)) return false
  // Anything else that looks like a timestamp = "yes there's a date,
  // so this happened" → true. Used for Mailchimp's "Unsubscribed:
  // 2024-03-12 14:30:00" pattern.
  if (/\d{4}-\d{2}-\d{2}/.test(s) || /^\d+$/.test(s)) return true
  return null
}
