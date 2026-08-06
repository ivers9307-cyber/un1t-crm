// scripts/audit-bare-phones.mjs
// ZOOMSYNC.3 — triage the 46 non-ClassPass `contacts` rows whose phone is 8 or
// 10 bare digits with no '+' and no country code (found during the ZOOMSYNC.1
// go-live pilot, measured 2026-08-06). ZOOMSYNC.2 (#1235) rejects them, so they
// are absent from the Zoom caller-ID directory rather than published wrong.
//
// READ-ONLY BY DEFAULT. The point of this script is to show its working so a
// human makes the call — a bare 10-digit number is probably North American but
// could be a mistyped Irish one, and guessing wrong writes a stranger's number
// against a real member's name.
//
//   Triage (writes nothing):
//     node scripts/audit-bare-phones.mjs
//   Apply only the rows whose country code was READ OFF a number we already
//   hold (tier `derived` — no judgement involved):
//     node scripts/audit-bare-phones.mjs --apply
//   Apply specific rows you have reviewed yourself:
//     node scripts/audit-bare-phones.mjs --apply --ids=<uuid>,<uuid>
//
// `ambiguous` rows are never written, with or without --apply. They are listed
// so they can be chased by a human (ask the member) rather than guessed.
//
// Anything repaired is picked up by the next nightly /api/cron/zoom-contact-sync
// run — the reconcile recomputes desired state from `contacts`, so no backfill.
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { inferAll, isBareNoCountryCode } from '../src/lib/zoom/infer-bare-phone.js'
import { normaliseForZoom } from '../src/lib/zoom/normalise-phone.js'

const apply = process.argv.includes('--apply')
const idsArg = process.argv.find(a => a.startsWith('--ids='))
const approvedIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',').map(s => s.trim()).filter(Boolean)) : null
const csvArg = process.argv.find(a => a.startsWith('--csv='))
const csvPath = csvArg ? csvArg.slice('--csv='.length) : null

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set — no silent fallbacks.')
  process.exit(1)
}
const db = createClient(url, key)

// Every .select() caps at 1000 rows regardless of .limit(), so page explicitly
// with a stable .order(). The bare-digit test itself is not expressible in
// PostgREST, so pull the candidates coarsely and refine with the unit-tested
// predicate in infer-bare-phone.js.
const PAGE = 1000
const contacts = []
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from('contacts')
    .select('id, first_name, last_name, name, email, phone, lead_source, wa_phone, lifetime_currency, glofox_member_id, location_id, created_at')
    .not('phone', 'is', null)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) { console.error(error); process.exit(1) }
  contacts.push(...(data || []))
  if (!data || data.length < PAGE) break
}

// ClassPass rows are excluded upstream of the sync and carry a placeholder
// number; they are not a data-quality problem. isBareNoCountryCode() is the
// unit-tested predicate that mirrors the ZOOMSYNC.2 reject, so the rows this
// script triages are exactly the rows the sync refuses — no second definition
// of "bare" to drift out of step.
const candidates = contacts.filter(c =>
  String(c.lead_source || '').toLowerCase() !== 'classpass' && isBareNoCountryCode(c.phone),
)

// WhatsApp threads give a second source of known-good E.164 numbers. Scoped to
// the candidates, so this is one small query rather than a table scan.
const threadsByContact = {}
if (candidates.length) {
  const { data: convos, error } = await db
    .from('whatsapp_conversations')
    .select('contact_id, wa_phone')
    .in('contact_id', candidates.map(c => c.id))
  if (error) { console.error(error); process.exit(1) }
  for (const c of convos || []) {
    if (!c.contact_id || !c.wa_phone) continue
    ;(threadsByContact[c.contact_id] ||= []).push(c.wa_phone)
  }
}

const results = inferAll(candidates, threadsByContact).filter(r => r.tier !== 'out-of-scope')
const byTier = t => results.filter(r => r.tier === t)
const derived = byTier('derived')
const corroborated = byTier('corroborated')
const ambiguous = byTier('ambiguous')

console.log(`${contacts.length} contacts with a phone → ${results.length} bare, no-country-code rows`)
console.log(`  derived      ${derived.length}  (country code read off a number we already hold — no judgement)`)
console.log(`  corroborated ${corroborated.length}  (shape + an independent signal — REVIEW BEFORE APPLYING)`)
console.log(`  ambiguous    ${ambiguous.length}  (left alone by design)`)

const show = (label, rows) => {
  if (!rows.length) return
  console.log(`\n── ${label} ──`)
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.name || '(no name)'} <${r.email}>`)
    console.log(`      stored ${JSON.stringify(r.raw)}${r.e164 ? ` → ${r.e164}` : ''}  [${r.lead_source || 'no lead_source'}]`)
    console.log(`      ${r.reason}`)
    for (const e of r.evidence) console.log(`        · ${e}`)
    for (const c of r.conflicts) console.log(`        ! ${c}`)
  }
}
show('DERIVED — safe to apply mechanically', derived)
show('CORROBORATED — proposals, review each', corroborated)
show('AMBIGUOUS — no confident answer, ask the member', ambiguous)

if (csvPath) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [
    'id,name,email,lead_source,stored_phone,proposed_e164,tier,reason,evidence,conflicts',
    ...results.map(r => [r.id, r.name, r.email, r.lead_source, r.raw, r.e164 || '', r.tier, r.reason, r.evidence.join(' | '), r.conflicts.join(' | ')].map(esc).join(',')),
  ].join('\n')
  writeFileSync(csvPath, csv)
  console.log(`\nWrote ${results.length} rows to ${csvPath}`)
}

if (!apply) {
  console.log('\nDry run — nothing written. Re-run with --apply to write the derived rows.')
  process.exit(0)
}

// Applying. `derived` rows need no review; anything else must be named
// explicitly by id, which is what keeps this from becoming the bulk UPDATE that
// ZOOMSYNC.2 exists to prevent.
const toWrite = approvedIds
  ? results.filter(r => approvedIds.has(r.id) && r.e164)
  : derived
const refused = approvedIds ? [...approvedIds].filter(id => !toWrite.some(r => r.id === id)) : []
for (const id of refused) console.log(`REFUSED ${id} — not a repairable row (ambiguous, out of scope, or no proposal)`)

let ok = 0
for (const r of toWrite) {
  if (normaliseForZoom(r.e164) !== r.e164) { console.log(`REFUSED ${r.id} — ${r.e164} does not round-trip through the normaliser`); continue }
  const { error } = await db.from('contacts').update({ phone: r.e164 }).eq('id', r.id)
  if (error) { console.error(`FAILED ${r.id}: ${error.message}`); continue }
  console.log(`updated ${r.id}  ${JSON.stringify(r.raw)} → ${r.e164}  (${r.tier})`)
  ok++
}
console.log(`\n${ok}/${toWrite.length} rows updated. The next nightly zoom-contact-sync run will publish them.`)
