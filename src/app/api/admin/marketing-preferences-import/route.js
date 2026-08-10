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
//   (default)   → commit. CONSENT.5b: bulk-applies via 4 batched
//                 queries (load current prefs → diff in memory →
//                 bulk upsert + bulk insert audit + bulk update
//                 email_status) instead of per-row Supabase
//                 round-trips. Pre-fix, 4000 rows × 5 round-trips
//                 each blew past the Vercel 60s ceiling.
//
// Master only. maxDuration bumped to 120s post-CONSENT.5b for
// headroom on very large imports — 4k contacts now finishes in
// well under 10s but a future 50k-row migration would still want
// the headroom.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { parseCsv } from '@/lib/csv-parse'
import { getClientIp } from '@/lib/rate-limit'
import { consentActionFor } from '@/lib/consent-actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Common column-name aliases from real exports. Keys are the
// canonical fields; values are normalised header strings (lowercase,
// non-alphanumerics → underscore — matches csv-parse's normaliseKey).
const COLUMN_ALIASES = {
  email: [
    'email', 'email_address', 'member_email', 'contact_email',
    'e_mail', 'mail', 'recipient',
  ],
  // CONSENT.5c — match by phone too. Operator's SMS/WhatsApp consent
  // CSV often has phone numbers without emails. Any column that
  // contains digits gets normalised (non-digits stripped) and matched
  // against the digit-stripped contact phone (last-9-digits index)
  // so format variations don't matter:
  //   "+353 87 068 8181" / "0870688181" / "353-87-068-8181" all match.
  phone: [
    'phone', 'phone_number', 'mobile', 'mobile_number', 'cell',
    'cell_number', 'tel', 'telephone',
    'sms', 'sms_number',
    'whatsapp_number', 'whatsapp_phone', 'wa_number', 'wa_phone',
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

/**
 * Index a phone for matching. Strips all non-digits and returns the
 * last 9 digits — the universally-stable "core" of an Irish mobile
 * (works for "+353 87 068 8181", "0870688181", "871234567" etc.).
 * Returns null for inputs with fewer than 9 digits (too short to be
 * usefully indexed).
 */
function indexPhone(s) {
  const digits = String(s || '').replace(/\D/g, '')
  if (digits.length < 9) return null
  return digits.slice(-9)
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
  // CONSENT.5c — need EITHER an email column OR a phone column to
  // identify the contact. SMS/WhatsApp consent CSVs often carry
  // phone numbers without emails.
  if (!mapping.email && !mapping.phone) {
    return NextResponse.json({
      success: false,
      error: 'Need at least one identifier column. For email matching: ' + COLUMN_ALIASES.email.slice(0, 3).join(', ') + '. For phone matching: ' + COLUMN_ALIASES.phone.slice(0, 4).join(', '),
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

  // CONSENT.5c — load contacts with both email AND phone so the
  // import can match on either. .not('email', 'is', null) was
  // dropped — we want phone-only contacts in the lookup too.
  // Index by both email (case-folded) AND phone (last-9-digits via
  // indexPhone); duplicate phones are first-write-wins (rare —
  // family member sharing a number — operator can de-dupe later).
  const contactIdByEmail = new Map()
  const contactIdByPhone = new Map()
  let pageStart = 0
   
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('contacts')
      .select('id, email, phone, glofox_membership_status')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error || !page || page.length === 0) break
    for (const c of page) {
      const hit = { id: c.id, classpass: c.glofox_membership_status === 'classpass_payg' }
      if (c.email) {
        const k = String(c.email).toLowerCase().trim()
        if (k && !contactIdByEmail.has(k)) contactIdByEmail.set(k, hit)
      }
      if (c.phone) {
        const phk = indexPhone(c.phone)
        if (phk && !contactIdByPhone.has(phk)) contactIdByPhone.set(phk, hit)
      }
    }
    if (page.length < PAGE_SIZE) break
    if ((contactIdByEmail.size + contactIdByPhone.size) >= HARD_LIMIT * 2) break
    pageStart += PAGE_SIZE
  }

  // Build the change plan. One pass over the CSV — for each row
  // resolve the email, parse the boolean columns, look up the
  // contact, and slot the row into the right outcome bucket.
  const stats = {
    total_rows:        rows.length,
    matched_contacts:  0,
    matched_by_email:  0,
    matched_by_phone:  0,
    no_identifier:     0,   // row has neither email nor phone with values
    unmatched:         0,   // CONSENT.5c: renamed from unmatched_email
                            // — covers both unmatched email + unmatched
                            // phone now.
    classpass_skipped: 0,
    no_columns:        0,
  }
  const samples = {
    matched:    [],
    unmatched:  [],
    classpass:  [],
  }
  const planByContact = new Map()  // contactId → { id_label, prefs }

  for (const row of rows) {
    // Pull the identifier values present on this row.
    const emailRaw = mapping.email
      ? String(row[mapping.email] || '').trim().toLowerCase()
      : ''
    const phoneRaw = mapping.phone
      ? String(row[mapping.phone] || '').trim()
      : ''
    const phoneKey = indexPhone(phoneRaw)

    // Try email first (more reliable), then phone.
    let hit = null
    let matchedBy = null
    let label = ''
    if (emailRaw && emailRaw.includes('@')) {
      const h = contactIdByEmail.get(emailRaw)
      if (h) { hit = h; matchedBy = 'email'; label = emailRaw }
    }
    if (!hit && phoneKey) {
      const h = contactIdByPhone.get(phoneKey)
      if (h) { hit = h; matchedBy = 'phone'; label = phoneRaw || phoneKey }
    }

    // No usable identifier on the row at all.
    if (!emailRaw && !phoneKey) {
      stats.no_identifier++
      continue
    }

    if (!hit) {
      stats.unmatched++
      if (samples.unmatched.length < 25) {
        samples.unmatched.push(emailRaw || phoneRaw || '(unknown)')
      }
      continue
    }

    if (hit.classpass) {
      stats.classpass_skipped++
      if (samples.classpass.length < 25) {
        samples.classpass.push(label)
      }
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

    // Last write wins if the same contact appears twice.
    planByContact.set(hit.id, { id_label: label, matched_by: matchedBy, prefs })
    stats.matched_contacts++
    if (matchedBy === 'email') stats.matched_by_email++
    else stats.matched_by_phone++
    if (samples.matched.length < 25) {
      samples.matched.push({ email: matchedBy === 'email' ? label : null, phone: matchedBy === 'phone' ? label : null, matched_by: matchedBy, prefs })
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

  // Commit mode — bulk-apply via 4 batched queries instead of
  // per-contact round-trips.
  //
  // CONSENT.5b (2026-05-13): per-contact applyMarketingPreferencesBulk
  // calls were doing ~5 Supabase round-trips each (load contact, load
  // preferences, upsert prefs, insert audit rows, update email_status).
  // 4000 rows × 5 round-trips × ~50ms = ~1000 seconds — way past the
  // 60s Vercel ceiling. The route was returning a plain-text "An
  // error occurred" page that broke the JSON parser client-side.
  //
  // New shape: build the full plan in memory, then issue:
  //   1. ONE paginated load of all relevant contact_preferences rows
  //   2. Diff in memory
  //   3. ONE bulk upsert (chunked at PAGE_SIZE to dodge URL caps)
  //   4. ONE bulk insert of consent_log rows (chunked)
  //   5. TWO bulk updates of contacts.email_status — one for the
  //      "back to active" set, one for the "now unsubscribed" set
  //
  // Total: ~5-10 queries regardless of CSV size. 4000 rows finishes
  // in seconds, not minutes.
  const ip = getClientIp(request)
  const planEntries = Array.from(planByContact)  // [[contactId, {email,prefs}], ...]
  const contactIds  = planEntries.map(([id]) => id)

  // 1. Bulk-load current preferences for every matched contact.
  const currentPrefByContact = new Map()
  for (let i = 0; i < contactIds.length; i += PAGE_SIZE) {
    const slice = contactIds.slice(i, i + PAGE_SIZE)
    const { data } = await db
      .from('contact_preferences')
      .select('contact_id, email_marketing, sms_marketing, whatsapp_marketing')
      .in('contact_id', slice)
    for (const row of (data || [])) currentPrefByContact.set(row.contact_id, row)
  }

  // 2. Diff in memory. Build the four bulk-write payloads.
  const upsertRows = []
  const logRows    = []
  const emailToActive    = []  // contact_ids whose email_status flips → 'active'
  const emailToUnsub     = []  // contact_ids whose email_status flips → 'unsubscribed'
  let writes = 0
  let unchanged = 0
  const nowIso = new Date().toISOString()

  // Need contact email_status snapshots for the email_status mirror.
  // Re-use the contactByEmail map we already built earlier — it carries
  // glofox status but not email_status. Fetch email_status in one pass.
  const emailStatusByContact = new Map()
  for (let i = 0; i < contactIds.length; i += PAGE_SIZE) {
    const slice = contactIds.slice(i, i + PAGE_SIZE)
    const { data } = await db
      .from('contacts')
      .select('id, email_status')
      .in('id', slice)
    for (const row of (data || [])) emailStatusByContact.set(row.id, row.email_status)
  }

  for (const [contactId, { prefs }] of planEntries) {
    const current = currentPrefByContact.get(contactId) || {}
    const changed = {}
    for (const ch of Object.keys(prefs)) {
      const before = current[ch] === undefined ? true : !!current[ch]
      if (before !== prefs[ch]) changed[ch] = prefs[ch]
    }
    if (Object.keys(changed).length === 0) {
      unchanged++
      continue
    }
    writes++
    upsertRows.push({ contact_id: contactId, ...changed, updated_at: nowIso })
    for (const ch of Object.keys(changed)) {
      logRows.push({
        contact_id: contactId,
        channel: ch,
        action: consentActionFor(changed[ch]),
        source: 'bulk_import',
        ip_address: ip,
      })
    }
    // Email status mirror — same reputation-state guard as the helper.
    if (Object.prototype.hasOwnProperty.call(changed, 'email_marketing')) {
      const cur = emailStatusByContact.get(contactId)
      const flipReputationOk = (cur === 'active' || cur === 'unsubscribed' || cur === null)
      if (flipReputationOk) {
        const target = changed.email_marketing ? 'active' : 'unsubscribed'
        if (cur !== target) {
          if (target === 'active') emailToActive.push(contactId)
          else emailToUnsub.push(contactId)
        }
      }
    }
  }

  // 3-5. Bulk writes. Chunked to dodge the PostgREST URL length cap
  // on .in() and to keep individual statements small.
  let errors = 0
  const errorSample = []

  // 3. Upsert preferences.
  for (let i = 0; i < upsertRows.length; i += PAGE_SIZE) {
    const slice = upsertRows.slice(i, i + PAGE_SIZE)
    const { error: upErr } = await db
      .from('contact_preferences')
      .upsert(slice, { onConflict: 'contact_id' })
    if (upErr) {
      errors += slice.length
      if (errorSample.length < 10) errorSample.push({ stage: 'upsert', error: upErr.message, chunk_size: slice.length })
    }
  }

  // 4. Insert consent_log rows. Append-only, no conflict handling.
  for (let i = 0; i < logRows.length; i += PAGE_SIZE) {
    const slice = logRows.slice(i, i + PAGE_SIZE)
    const { error: logErr } = await db.from('consent_log').insert(slice)
    if (logErr) {
      // Audit failure isn't fatal — the upsert already landed. Surface
      // it so the operator knows to chase the audit gap.
      if (errorSample.length < 10) errorSample.push({ stage: 'audit_log', error: logErr.message, chunk_size: slice.length })
    }
  }

  // 5. Email status mirror — bulk update by .in() per target value.
  for (let i = 0; i < emailToActive.length; i += PAGE_SIZE) {
    const slice = emailToActive.slice(i, i + PAGE_SIZE)
    const { error: emErr } = await db.from('contacts').update({ email_status: 'active' }).in('id', slice)
    if (emErr && errorSample.length < 10) errorSample.push({ stage: 'email_status_active', error: emErr.message })
  }
  // LOCCOMMS.5 — the 'unsubscribed' stamp is retired. email_status carries
  // reputation only (active | bounced | complained); the opt-out these rows
  // represent is written to contact_preferences above, and the mig 489 trigger
  // propagates it to every one of the contact's location rows.
  // emailToUnsub is still computed so the response counts stay meaningful.

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
