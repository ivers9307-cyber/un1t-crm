#!/usr/bin/env node
// ORGCONTACTS.4 — the segment change report (decision 3, spec 2026-10-20 §5).
//
// Mig 766 put the stage AT the audience studio on contact_location_audience
// (studio_stage_slug, from contact_studios). Before the audience field
// `pipeline_stage_slug` is flipped onto it, this report shows, for every saved
// audience of one organisation that filters on the stage, how its membership
// changes: the same filter evaluated on the contact-wide column (today) and on
// the studio column (after), scoped the way the send paths scope it
// (audience_location_id + the channel's consent column). Richard reads it
// before the flip merges.
//
//   node scripts/segment-stage-change-report.mjs --org <organisation id> [--out report.md] [--verbose]
//
// Read-only. Service-role env (SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL)
// from process.env or the checkout's .env.local. Pages every read with
// .range() (the 1,000-row cap). Counts only; ids under --verbose.
//
// Audiences read: contact_segments.filter, campaigns.audience_filter,
// whatsapp_broadcasts.audience_filter, email_sequences.audience_filter — any
// row of the organisation's studios whose filter names the stage field,
// nested logic groups included. The Review Focus 4 class (a person on the
// studio's list with NO stage at that studio: `eq` drops them, `neq` picks
// them up) is counted on its own in both directions.

import { register } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const STAGE_FIELD = 'pipeline_stage_slug'
export const STUDIO_STAGE_FIELD = 'studio_stage_slug'
const PAGE = 1000
const SOURCES = [
  { kind: 'segment', table: 'contact_segments', filterCol: 'filter', statusOf: () => 'saved', consentColumn: 'loc_email_marketing' },
  { kind: 'campaign', table: 'campaigns', filterCol: 'audience_filter', statusOf: (r) => r.status ?? null, consentColumn: 'loc_email_marketing' },
  { kind: 'broadcast', table: 'whatsapp_broadcasts', filterCol: 'audience_filter', statusOf: (r) => r.status ?? null, consentColumn: 'loc_whatsapp_marketing' },
  { kind: 'sequence', table: 'email_sequences', filterCol: 'audience_filter', statusOf: (r) => (r.active ? 'active' : 'inactive'), consentColumn: 'loc_email_marketing' },
]

/** The same filter with every stage row pointed at the studio column; nested groups too; never mutates. */
export function rewriteStageField(filter) {
  if (!filter || typeof filter !== 'object') return filter
  if (!Array.isArray(filter.filters)) return { ...filter }
  return {
    ...filter,
    filters: filter.filters.map((f) => {
      if (f && Array.isArray(f.filters)) return rewriteStageField(f)
      if (f && f.field === STAGE_FIELD) return { ...f, field: STUDIO_STAGE_FIELD }
      return f
    }),
  }
}

/** Does the filter (nested groups included) name the stage field? */
export function namesStageField(filter) {
  if (!filter || !Array.isArray(filter.filters)) return false
  return filter.filters.some((f) => (f && Array.isArray(f.filters) ? namesStageField(f) : f?.field === STAGE_FIELD))
}

// Two registries, explicit about the column each lands on, whatever the live
// AUDIENCE_FIELDS.pipeline_stage_slug.column says: "before" is the contact-wide
// stage, "after" is the stage at the audience studio.
let registries = null
async function loadRegistries() {
  if (registries) return registries
  if (!process.env.VITEST) register('./lib/at-alias-loader.mjs', import.meta.url)
  const mod = await import('../src/lib/audience-filter.js')
  const stage = mod.AUDIENCE_FIELDS[STAGE_FIELD]
  const before = { ...mod.AUDIENCE_FIELDS, [STAGE_FIELD]: { ...stage, column: STAGE_FIELD } }
  const after = { ...mod.AUDIENCE_FIELDS, [STUDIO_STAGE_FIELD]: { ...stage, column: STUDIO_STAGE_FIELD } }
  registries = {
    before: (query, filter) => mod.applyAudienceFilter(query, filter, { fields: before }),
    after: (query, filter) => mod.applyAudienceFilter(query, filter, { fields: after }),
  }
  return registries
}

async function readAllIds(build) {
  const ids = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`audience read failed: ${error.message || error}`)
    const page = data || []
    ids.push(...page.map((r) => r.id))
    if (page.length < PAGE) return ids
  }
}

/**
 * One audience, before (contact-wide stage) and after (the stage at the studio).
 * @returns {{ before: string[], after: string[], joined: string[], left: string[], joinedStageNull: string[], leftStageNull: string[] }}
 */
export async function compareAudience(db, { locationId, filter, consentColumn = 'loc_email_marketing' }) {
  const apply = await loadRegistries()
  const base = () => db.from('contact_location_audience').select('id').eq('audience_location_id', locationId).eq(consentColumn, true)
  const run = (f, on) => readAllIds((from, to) => on(base(), f).order('id', { ascending: true }).range(from, to))
  const before = await run(filter, apply.before)
  const after = await run(rewriteStageField(filter), apply.after)
  const b = new Set(before)
  const a = new Set(after)
  const joined = after.filter((id) => !b.has(id))
  const left = before.filter((id) => !a.has(id))
  const nullAt = new Set(await readAllIds((from, to) => base().is(STUDIO_STAGE_FIELD, null).order('id', { ascending: true }).range(from, to)))
  return {
    before, after, joined, left,
    joinedStageNull: joined.filter((id) => nullAt.has(id)),
    leftStageNull: left.filter((id) => nullAt.has(id)),
  }
}

/** Every saved audience of the organisation that names the stage field, with its studio. */
export async function collectAudiences(db, orgId) {
  const { data: locations, error: locErr } = await db.from('locations').select('id, name').eq('organization_id', orgId)
  if (locErr) throw new Error(`locations read failed: ${locErr.message}`)
  const byId = new Map((locations || []).map((l) => [l.id, l.name]))
  const locIds = [...byId.keys()]
  const out = []
  for (const src of SOURCES) {
    const rows = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from(src.table).select('*').in('location_id', locIds).order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) throw new Error(`${src.table} read failed: ${error.message}`)
      rows.push(...(data || []))
      if ((data || []).length < PAGE) break
    }
    for (const r of rows) {
      const filter = r[src.filterCol]
      if (!namesStageField(filter)) continue
      out.push({ kind: src.kind, id: r.id, name: r.name ?? r.subject ?? r.id, status: src.statusOf(r), location_id: r.location_id, studio: byId.get(r.location_id) ?? r.location_id, filter, consentColumn: src.consentColumn })
    }
  }
  return out
}

const n = (xs) => (Array.isArray(xs) ? xs.length : 0)

/** Markdown: one row per audience, counts only; ids appended under --verbose. */
export function renderReport(results, { orgId, verbose = false, generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    `# Segment stage change report — organisation ${orgId}`,
    '',
    `Generated ${generatedAt}. Each saved audience that filters on \`pipeline_stage_slug\`, evaluated on the contact-wide stage (before) and on the stage at the audience studio (after, \`studio_stage_slug\`, mig 766), scoped to the audience studio and the channel's consent column. "stage NULL at studio" = the Review Focus 4 class: a person on the studio's list with no stage there (\`eq\` drops them, \`neq\` picks them up).`,
    '',
    '| kind | audience | studio | status | before | after | joined | left | left: stage NULL at studio | joined: stage NULL at studio |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|',
  ]
  for (const r of results) {
    lines.push(`| ${r.kind} | ${r.name} | ${r.studio} | ${r.status ?? ''} | ${n(r.before)} | ${n(r.after)} | ${n(r.joined)} | ${n(r.left)} | ${n(r.leftStageNull)} | ${n(r.joinedStageNull)} |`)
  }
  if (results.length === 0) lines.push('| — | no saved audience names the stage field | | | | | | | | |')
  if (verbose) {
    lines.push('', '## Ids (--verbose)', '')
    for (const r of results) {
      lines.push(`### ${r.kind} ${r.name} (${r.id}) @ ${r.studio}`, '', `- joined: ${r.joined.join(', ') || '—'}`, `- left: ${r.left.join(', ') || '—'}`, '')
    }
  }
  return lines.join('\n') + '\n'
}

// ─── runner ───────────────────────────────────────────────────────────────
function loadEnv() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) return process.env
  const here = path.dirname(new URL(import.meta.url).pathname)
  for (const rel of ['../.env.local', '../../../../.env.local']) {
    try {
      const env = Object.fromEntries(readFileSync(path.resolve(here, rel), 'utf8').split('\n')
        .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
      if (env.SUPABASE_SERVICE_ROLE_KEY && env.NEXT_PUBLIC_SUPABASE_URL) return env
    } catch {}
  }
  throw new Error('No SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in the environment or a reachable .env.local')
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  const orgId = arg('--org')
  if (!orgId) { console.error('usage: node scripts/segment-stage-change-report.mjs --org <organisation id> [--out report.md] [--verbose]'); process.exit(2) }
  const env = loadEnv()
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const audiences = await collectAudiences(db, orgId)
  const results = []
  for (const a of audiences) results.push({ ...a, ...(await compareAudience(db, { locationId: a.location_id, filter: a.filter, consentColumn: a.consentColumn })) })
  const md = renderReport(results, { orgId, verbose: argv.includes('--verbose') })
  const out = arg('--out')
  if (out) { writeFileSync(out, md); console.error(`wrote ${out} (${results.length} audiences)`) } else process.stdout.write(md)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(1) })
}
