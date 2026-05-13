// UNSUB.4 — one-off recovery endpoint.
//
// Reconciles contacts whose email-client one-click Unsubscribe was
// silently lost between UNSUB.1 (when we started sending
// List-Unsubscribe headers) and UNSUB.3 (when we fixed the header
// to point at the POST endpoint). Postmark accepted those
// unsubscribes and added the addresses to its broadcast-stream
// suppression list; our DB never flipped contact_preferences,
// so the audience builder kept counting them as opted-in.
//
// Hit with:
//   POST /api/admin/postmark-suppression-backfill
//
// Auth: master/owner only. Idempotent — for any contact whose
// email_marketing is already false, the underlying
// applyMarketingPreferencesBulk is a no-op (returns changed=[]).
// Re-running is safe.
//
// DELETE THIS FILE after a successful run.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { applyMarketingPreferencesBulk } from '@/lib/marketing-consent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const POSTMARK_API = 'https://api.postmarkapp.com'
const SUPPRESSION_PAGE = 500   // Postmark's dump endpoint pages

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden — master/owner only' }, { status: 403 })
  }

  const token = process.env.POSTMARK_API_KEY || process.env.POSTMARK_SERVER_TOKEN
  if (!token) {
    return NextResponse.json({ success: false, error: 'POSTMARK_API_KEY not configured' }, { status: 500 })
  }

  // 1. Pull the entire broadcast-stream suppression list, paged.
  //    Postmark returns up to 500 per call; we loop until a short
  //    page comes back.
  const suppressions = []
  let offset = 0
  while (true) {
    const url = `${POSTMARK_API}/message-streams/broadcast/suppressions/dump?count=${SUPPRESSION_PAGE}&offset=${offset}`
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Postmark-Server-Token': token,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({
        success: false,
        error: `Postmark API ${res.status}: ${text || res.statusText}`,
      }, { status: 502 })
    }
    const data = await res.json()
    const rows = data?.Suppressions || []
    suppressions.push(...rows)
    if (rows.length < SUPPRESSION_PAGE) break
    offset += SUPPRESSION_PAGE
  }

  // 2. Build the email set (lower-case for our case-insensitive match —
  //    contacts.email is stored lowercase already so a plain .in()
  //    on the lowercased addresses is enough).
  const suppressedEmails = Array.from(new Set(
    suppressions
      .map(s => (s.EmailAddress || '').trim().toLowerCase())
      .filter(Boolean)
  ))

  if (suppressedEmails.length === 0) {
    return NextResponse.json({
      success: true,
      message: 'No suppressions on the broadcast stream.',
      postmark_suppressions: 0,
      flipped: 0,
    })
  }

  // 3. Find contacts still opted-in for any of those emails.
  //    Chunk the IN clause so we stay under PostgREST URL-length
  //    limits (~8KB; 500 emails of ~40 chars each fits comfortably).
  const db = createServerClient()
  const optedInMatches = []
  const CHUNK = 500
  for (let i = 0; i < suppressedEmails.length; i += CHUNK) {
    const slice = suppressedEmails.slice(i, i + CHUNK)
    const { data, error } = await db.from('contacts')
      .select('id, email, email_marketing, location_id')
      .in('email', slice)
      .eq('email_marketing', true)
    if (error) {
      return NextResponse.json({
        success: false,
        error: `contacts query failed: ${error.message}`,
      }, { status: 500 })
    }
    optedInMatches.push(...(data || []))
  }

  // 4. Flip each one through the shared helper. ClassPass-skip
  //    + consent_log audit + email_status mirror are handled in
  //    applyMarketingPreferencesBulk.
  let flipped = 0
  let alreadyOptedOut = 0
  let classpassSkipped = 0
  const errors = []
  for (const contact of optedInMatches) {
    const r = await applyMarketingPreferencesBulk(db, {
      contactId: contact.id,
      prefs: { email_marketing: false },
      source: 'postmark_suppression_backfill',
    })
    if (!r.ok) {
      errors.push({ contact_id: contact.id, error: r.error })
      continue
    }
    if (r.skipped === 'classpass') classpassSkipped += 1
    else if (r.changed.length === 0) alreadyOptedOut += 1
    else flipped += 1
  }

  return NextResponse.json({
    success: true,
    postmark_suppressions: suppressedEmails.length,
    matched_contacts_opted_in: optedInMatches.length,
    flipped,
    already_opted_out: alreadyOptedOut,
    classpass_skipped: classpassSkipped,
    errors,
  })
}
