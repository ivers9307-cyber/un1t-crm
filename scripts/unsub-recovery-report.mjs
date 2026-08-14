// scripts/unsub-recovery-report.mjs
//
// UNSUBRECOVER.1 — READ-ONLY evidence report for the unsubscribe-recovery
// effort. THIS SCRIPT WRITES NOTHING: no INSERT, UPDATE, UPSERT or DELETE
// against Supabase, and it does not touch consent_log or any consent column.
// A SEPARATE, SEPARATELY-APPROVED step decides what to do with the CSV this
// prints — nothing here applies anything.
//
// WHY. Until 2026-08-11 this app dropped customer unsubscribes on the floor
// two ways, neither of which leaves a consent_log row (rate limiters spent
// before the token was read; a confirm-page link nobody had to complete).
// The one durable trace is Postmark's click tracking on the unsubscribe URL,
// in campaign_link_clicks. This script reads that table, plus email_sends
// (for the coverage denominator) and contact_location_audience (for who is
// still mailable), classifies each still-mailable contact's click history
// via src/lib/unsub-recovery.js — coverage of delivered campaigns is the
// verdict signal; a raw click-timing "burst" is evidence only, NOT the
// verdict (that rule was tried and rejected against prod; see that file's
// header) — and prints one CSV row per still-mailable contact.
//
// Usage:
//   node scripts/unsub-recovery-report.mjs > unsub-recovery-2026-08-14.csv
//
// The CSV goes to stdout ONLY. Progress and the summary go to stderr so
// they never corrupt the CSV.

import { createClient } from '@supabase/supabase-js'
import { buildBurstIndex, classifyClickEvidence } from '../src/lib/unsub-recovery.js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set — no silent fallbacks.')
  process.exit(1)
}
const db = createClient(url, key)

const PAGE_SIZE = 1000

// Every .select() in this repo caps at 1000 rows regardless of .limit()
// (repo invariant — see CLAUDE.md). `build` is a factory that returns a
// FRESH query builder each call (so .range() isn't stacked repeatedly onto
// one builder); loop until a page comes back short of PAGE_SIZE — that is
// what actually proves the end was reached, rather than guessing a page
// count that silently truncates once the table grows.
async function loadAll(build) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(error)
      process.exit(1)
    }
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

console.error('Loading unsubscribe-link clicks from campaign_link_clicks…')
// Deliberate substring match — every URL under an unsubscribe path, whatever
// campaign or token it carries.
const clickRows = await loadAll(() =>
  db
    .from('campaign_link_clicks')
    .select('contact_id, campaign_id, clicked_at')
    .ilike('url', '%/unsubscribe/%')
    .order('id', { ascending: true }),
)

// contact_id is ON DELETE SET NULL (mig 510) — a null means the contact was
// later deleted. That click can't be attributed to anyone and the contact
// can't appear in the still-mailable output either, so it carries no
// evidentiary weight here. Drop it before building the burst index, rather
// than let a null value masquerade as an extra "distinct contact" in a
// bucket's count.
const clicks = clickRows.filter(r => r.contact_id)
console.error(
  `${clickRows.length} unsubscribe-link click rows loaded (${clickRows.length - clicks.length} unattributed after a contact delete, dropped)`,
)

// Built across ALL clicks — advisory evidence only (burstClicks below), not
// the verdict; see src/lib/unsub-recovery.js header for why.
const burstIndex = buildBurstIndex(clicks)

const clicksByContact = new Map()
for (const row of clicks) {
  if (!clicksByContact.has(row.contact_id)) clicksByContact.set(row.contact_id, [])
  clicksByContact.get(row.contact_id).push(row)
}
console.error(`${clicksByContact.size} distinct contacts have clicked an unsubscribe link`)

// .in() has practical URL-length limits — chunk the id list. Reused for both
// the email_sends coverage-denominator lookup and the mailability lookup
// below.
const CHUNK_SIZE = 200
const contactIds = [...clicksByContact.keys()]
const idChunks = []
for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) idChunks.push(contactIds.slice(i, i + CHUNK_SIZE))

// ── Coverage denominator: how many campaigns did we actually deliver? ─────
// One click-haver's campaign sends can run past 1000 rows on their own once
// summed across ~161 contacts (measured mean 7.1 campaigns/contact for the
// non-scanner-shaped group — comfortably over the cap in aggregate), so each
// id-chunk gets its OWN loadAll() pagination rather than one unpaginated
// query per chunk.
console.error("Loading each contact's delivered-campaign history from email_sends (source_type = 'campaign')…")
const campaignSendRows = []
for (const chunk of idChunks) {
  const rows = await loadAll(() =>
    db
      .from('email_sends')
      .select('contact_id, campaign_id')
      .eq('source_type', 'campaign')
      .in('contact_id', chunk)
      .order('id', { ascending: true }),
  )
  campaignSendRows.push(...rows)
}
const deliveredCampaignsByContact = new Map()
for (const row of campaignSendRows) {
  if (!row.campaign_id) continue
  if (!deliveredCampaignsByContact.has(row.contact_id)) deliveredCampaignsByContact.set(row.contact_id, new Set())
  deliveredCampaignsByContact.get(row.contact_id).add(row.campaign_id)
}
console.error(`${campaignSendRows.length} campaign email_sends rows loaded across ${deliveredCampaignsByContact.size} contacts`)

// ── Still mailable? ─────────────────────────────────────────────────────
console.error('Looking up which of those contacts are still mailable (contact_location_audience, loc_email_marketing = true)…')
const mailable = new Map()
for (const chunk of idChunks) {
  const { data, error } = await db
    .from('contact_location_audience')
    .select('id, email, name')
    .eq('loc_email_marketing', true)
    .in('id', chunk)
  if (error) {
    console.error(error)
    process.exit(1)
  }
  // A contact can carry more than one audience row (one per location with a
  // preferences row) — dedupe on id so they get exactly one CSV line.
  for (const row of data || []) {
    if (!mailable.has(row.id)) mailable.set(row.id, row)
  }
}
console.error(`${mailable.size} of those are still mailable`)

// ── Classify + emit ─────────────────────────────────────────────────────
const header = 'contact_id,email,name,verdict,coverage,campaigns_clicked,campaigns_delivered,click_count,burst_clicks,span_days,first_click,last_click'
const summary = { human: 0, review: 0, scanner: 0, spanOver30: 0 }
// Sort human first, then review, then scanner — the reviewer reads the
// actionable (non-obvious) rows first, scanner-verdict rows last since
// those need the least attention.
const VERDICT_ORDER = { human: 0, review: 1, scanner: 2 }
const csvRows = []

for (const [contactId, contact] of mailable) {
  const contactClicks = clicksByContact.get(contactId) || []
  const campaignsDelivered = deliveredCampaignsByContact.get(contactId)?.size ?? 0
  const { verdict, coverage, clickedCampaigns, clickCount, burstClicks, spanDays } = classifyClickEvidence({
    clicks: contactClicks,
    campaignsDelivered,
    burstIndex,
  })
  const sortedClicks = [...contactClicks].sort((a, b) => new Date(a.clicked_at) - new Date(b.clicked_at))
  const firstClick = sortedClicks[0]?.clicked_at ?? ''
  const lastClick = sortedClicks[sortedClicks.length - 1]?.clicked_at ?? ''

  summary[verdict] = (summary[verdict] || 0) + 1
  if (spanDays > 30) summary.spanOver30++

  csvRows.push({
    verdict,
    // Only name is quoted (JSON.stringify) — the one free-text field that
    // can carry a comma. Every other column is a uuid, email, verdict,
    // number or ISO timestamp, none of which can contain one.
    line: [
      contactId,
      contact.email ?? '',
      JSON.stringify(contact.name ?? ''),
      verdict,
      coverage === null ? '' : Math.round(coverage * 10000) / 10000,
      clickedCampaigns,
      campaignsDelivered,
      clickCount,
      burstClicks,
      Math.round(spanDays * 100) / 100,
      firstClick,
      lastClick,
    ].join(','),
  })
}

csvRows.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict])
console.log([header, ...csvRows.map(r => r.line)].join('\n'))

console.error('\n── UNSUBRECOVER.1 summary — this script wrote nothing ──')
console.error(`${mailable.size} still-mailable candidates with unsubscribe-click evidence`)
console.error(`  human   ${summary.human || 0}`)
console.error(`  review  ${summary.review || 0}`)
console.error(`  scanner ${summary.scanner || 0}`)
console.error(`${summary.spanOver30} candidates have span_days > 30`)
console.error('A separate, separately-approved step applies this result. Nothing has been written to the database.')
