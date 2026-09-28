// SECFIX.3c guard (mig 648). `authenticated` holds SELECT on only some columns
// of locations / contact_external_integrations, and nothing on
// channel_connections / whatsapp_numbers / xero_connections
// (tests/helpers/credential-column-grants.js). Pinned here:
//  1. Client-run code (shared/, mobile/, and every src/ file that is
//     'use client' or imports createBrowserClient) names granted columns only
//     and never `*`; a no-access table does not appear at all. PostgREST
//     refuses the WHOLE select (42501) when one column is withheld.
//  2. Client writes are an exact list (CLIENT_WRITERS), .update() only.
//  3. A migration after 648 that ADDs a column to a column-granted table
//     decides its grant; one that grants ANY table-level privilege on the five
//     tables to a client role (by name or ALL TABLES IN SCHEMA public) fails.
// What the scanner reads (tests/helpers/postgrest-column-uses.js): every link
// of a `.from()` chain; a select string that is a literal or a same-file const
// (as check:select-columns does); embeds by table or through ANY FK column
// into the five tables (derived from the migrations); `.or()`/`.and()` logic
// trees; JSON-path filter roots. A select or or/and string on a credential
// table that it cannot evaluate FAILS unless reviewed and listed.
// Still a floor, not a proof: `.from(<variable>)`, a chain split across
// statements, and an unevaluable select on ANOTHER table (whose embeds could
// reach a credential table) are invisible. Server code (service_role) is not
// checked because it bypasses grants. The server-side half (a `*` row handed
// to a client component) is tests/location-secrets-to-client.test.js.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  CREDENTIAL_COLUMN_GRANTS, NO_CLIENT_ACCESS_TABLES, CREDENTIAL_GRANT_TABLES, CREDENTIAL_GRANT_MIGRATION, CLIENT_WRITERS,
} from './helpers/credential-column-grants.js'
import { columnUses, fkAliasesInto } from './helpers/postgrest-column-uses.js'
import { collectSchema } from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
// Every FK column that points at one of the five tables (location_id,
// anchor_location_id, master_location_id, sending_location_id,
// channel_connection_id at SECFIX.3c), from the migrations replay.
const FK_ALIASES = fkAliasesInto(collectSchema(path.join(ROOT, 'supabase/migrations')).fks, CREDENTIAL_GRANT_TABLES)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx)$/.test(name) && !/\.test\.(m?js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => {
    const t = readFileSync(f, 'utf8')
    return /^\s*['"]use client['"]/.test(t) || /\bcreateBrowserClient\b/.test(t)
  })
  return [...phone, ...browser]
}

const granted = (table, col) =>
  !NO_CLIENT_ACCESS_TABLES.includes(table) && col !== '*' && CREDENTIAL_COLUMN_GRANTS[table].select.includes(col)

describe('one list for "what a browser may see of a location" (SECFIX.3a/3c)', () => {
  it("getCurrentUser's identity columns equal mig 648's SELECT grant", async () => {
    const { CLIENT_LOCATION_COLUMNS } = await import('../src/lib/location-secrets.js')
    expect([...CLIENT_LOCATION_COLUMNS].sort()).toEqual([...CREDENTIAL_COLUMN_GRANTS.locations.select].sort())
  })
})

describe('client code names only granted credential-table columns (SECFIX.3c)', () => {
  const files = clientFiles()

  it('finds the reads it is meant to police (not vacuous)', () => {
    const uses = (rel) => columnUses(readFileSync(path.join(ROOT, rel), 'utf8'), CREDENTIAL_GRANT_TABLES, FK_ALIASES)
    expect(files.map((f) => path.relative(ROOT, f))).toEqual(expect.arrayContaining([
      'shared/dashboard-data.js', 'mobile/app/(member)/account/integrations.jsx',
      'src/components/LocationForm.jsx', 'src/components/CarDepositSettings.jsx',
    ]))
    expect(uses('shared/dashboard-data.js').reads.map(([t, c]) => `${t}.${c}`))
      .toEqual(expect.arrayContaining(['locations.id', 'locations.name']))
    const member = uses('mobile/app/(member)/account/integrations.jsx')
    expect(member.reads.map(([t, c]) => `${t}.${c}`)).toEqual(expect.arrayContaining([
      'contact_external_integrations.provider', 'contact_external_integrations.contact_id',
      'contact_external_integrations.disconnected_at',
    ]))
    expect(member.writes).toEqual([['contact_external_integrations', 'update'], ['contact_external_integrations', 'update']])
    expect(uses('src/components/LocationForm.jsx').reads.map(([t, c]) => `${t}.${c}`)).toContain('locations.id')
    expect(uses('src/components/CarDepositSettings.jsx').writes).toEqual([['locations', 'update']])
  })

  it('every read is a granted column', () => {
    const offenders = []
    for (const file of files) {
      for (const [table, col] of columnUses(readFileSync(file, 'utf8'), CREDENTIAL_GRANT_TABLES, FK_ALIASES).reads) {
        if (!granted(table, col)) offenders.push(`${path.relative(ROOT, file)}: ${table}.${col}`)
      }
    }
    expect(offenders, 'read it through a service-role /api route that masks, or grant the column in a migration').toEqual([])
  })

  it('every select on a credential table is readable (fail closed)', () => {
    // A select string the scanner cannot evaluate (a parameter, an import, a
    // call, a `let`) could name any column, so it is an offender unless it
    // was reviewed by hand and listed here as `<file>: <table> <arg text>`.
    const REVIEWED_DYNAMIC_SELECTS = []
    const unread = []
    for (const file of files) {
      for (const [table, arg] of columnUses(readFileSync(file, 'utf8'), CREDENTIAL_GRANT_TABLES, FK_ALIASES).unresolved) {
        const key = `${path.relative(ROOT, file)}: ${table} ${arg}`
        if (!REVIEWED_DYNAMIC_SELECTS.includes(key)) unread.push(key)
      }
    }
    expect(unread, 'name the columns in a literal or a same-file const, or review it and list it').toEqual([])
  })

  it('client writes are exactly the reviewed writers, update only', () => {
    const seen = {}
    const nonUpdate = []
    for (const file of files) {
      for (const [table, op] of columnUses(readFileSync(file, 'utf8'), CREDENTIAL_GRANT_TABLES, FK_ALIASES).writes) {
        const rel = path.relative(ROOT, file)
        if (op !== 'update') nonUpdate.push(`${rel}: ${op} on ${table}`)
        ;(seen[table] ||= new Set()).add(rel)
      }
    }
    expect(nonUpdate, 'no client INSERT / UPSERT / DELETE on a credential table: use a service-role route').toEqual([])
    const actual = Object.fromEntries(Object.entries(seen).map(([t, s]) => [t, [...s].sort()]))
    const expected = Object.fromEntries(Object.entries(CLIENT_WRITERS).map(([t, s]) => [t, [...s].sort()]))
    expect(actual, 'a new client writer: move it to a service-role route, or review it and add it to CLIENT_WRITERS').toEqual(expected)
  })

  it('the detector catches withheld columns, `*`, embeds, fk-alias embeds and writes', () => {
    const bad = `
      await supabase.from('locations').select('id, settings').eq('sensibo_api_key', 'x')
      await supabase.from('channel_connections').select('*')
      await supabase.from('shift_blocks').select('id, locations:location_id ( name, thinq_pat )')
      await supabase.from('contacts').select('id, contact_external_integrations ( access_token )')
      await supabase.from('xero_connections').delete().eq('id', 1)
      await supabase.from('locations').update(p).eq('id', x).select().single()
      q = q.eq('locations.twilio_alpha_sender_id', 'x')
      // a comment naming \`locations.color\` is not a read`
    const { reads, writes } = columnUses(bad, CREDENTIAL_GRANT_TABLES, FK_ALIASES)
    const r = reads.map(([t, c]) => `${t}.${c}`)
    expect(r).toEqual(expect.arrayContaining([
      'locations.settings', 'locations.sensibo_api_key', 'channel_connections.*', 'locations.thinq_pat',
      'contact_external_integrations.access_token', 'locations.*', 'locations.twilio_alpha_sender_id',
    ]))
    expect(r).not.toContain('locations.color')
    expect(writes).toEqual(expect.arrayContaining([['xero_connections', 'delete'], ['locations', 'update']]))
  })

  // Review S4 probes: each was a blind spot, found by a probe, before the fix.
  const probe = (src) => columnUses(src, CREDENTIAL_GRANT_TABLES, FK_ALIASES).reads.map(([t, c]) => `${t}.${c}`)

  it('sees a bare FK-column embed with no alias', () => {
    expect(probe(`await supabase.from('shift_blocks').select('id, location_id ( settings )')`)).toContain('locations.settings')
    expect(probe(`await supabase.from('shift_blocks').select('id, location_id!inner(thinq_pat)')`)).toContain('locations.thinq_pat')
  })

  it('sees an embed through every FK column that points at a credential table', () => {
    expect(probe(`await supabase.from('event_hosts').select('id, anchor_location_id ( settings )')`)).toContain('locations.settings')
    expect(probe(`await supabase.from('organizations').select('id, master:master_location_id ( thinq_pat )')`)).toContain('locations.thinq_pat')
    expect(probe(`await supabase.from('race_events').select('id, sending_location_id ( sensibo_api_key )')`)).toContain('locations.sensibo_api_key')
    expect(probe(`await supabase.from('instagram_conversations').select('id, channel_connection_id ( access_token )')`)).toContain('channel_connections.access_token')
  })

  it('reads the select anywhere on the chain, however far from .from()', () => {
    const far = `await supabase.from('locations')
      .eq('organization_id', '${'0'.repeat(450)}')
      .select('id, settings')`
    expect(probe(far)).toContain('locations.settings')
    // …and a later chain's select is never credited to an earlier .from().
    const two = `const a = await supabase.from('locations').eq('id', x)
      const b = await supabase.from('contacts').select('id, settings')`
    expect(probe(two)).not.toContain('locations.settings')
  })

  it('resolves a select held in a same-file const, and reports one it cannot read', () => {
    expect(probe(`const COLS = 'id, settings'\nawait supabase.from('locations').select(COLS)`)).toContain('locations.settings')
    expect(probe("const A = 'id'\nconst B = `${A}, thinq_pat`\nawait supabase.from('locations').select(B)")).toContain('locations.thinq_pat')
    expect(probe(`const SEL = 'id, locations:location_id ( settings )'\nawait supabase.from('shift_blocks').select(SEL)`))
      .toContain('locations.settings')
    const dyn = columnUses(`function f(cols) { return supabase.from('locations').select(cols) }`, CREDENTIAL_GRANT_TABLES, FK_ALIASES)
    expect(dyn.unresolved).toEqual([['locations', 'cols']])
    expect(columnUses(`const S = 'id'\nsupabase.from('locations').select(S)`, CREDENTIAL_GRANT_TABLES, FK_ALIASES).unresolved).toEqual([])
  })

  it('reads the columns inside .or() / .and() logic filters and JSON-path filters', () => {
    const r = probe(`await supabase.from('locations').select('id')
      .or('settings.is.null,and(name.eq.x,not.or(thinq_pat.is.null,id.in.(a,b)))')
      .and('sensibo_api_key.neq.x,email.eq."a,b"')
      .eq('bca_config->>key', 'x')`)
    expect(r).toEqual(expect.arrayContaining([
      'locations.settings', 'locations.name', 'locations.thinq_pat', 'locations.id', 'locations.sensibo_api_key',
      'locations.email', 'locations.bca_config',
    ]))
    expect(r.filter((x) => !/^locations\.[a-z_]+$/.test(x))).toEqual([])
    expect(probe(`await supabase.from('shift_blocks').select('id, locations(id)').or('settings.is.null', { referencedTable: 'locations' })`))
      .toContain('locations.settings')
    expect(probe(`await supabase.from('shift_blocks').select('id').or('settings.is.null')`)).not.toContain('locations.settings')
  })

  it('the FK columns come from the migrations, and a text search finds none the replay missed', () => {
    // The replay (scripts/check-select-columns.mjs) does not learn an FK made
    // inside a DO $$ block; a plain text search of the migrations does not
    // care. Every column it finds that REFERENCES a credential table must be
    // in FK_ALIASES, so a new FK cannot open an unseen embed path.
    const dir = path.join(ROOT, 'supabase/migrations')
    const alt = CREDENTIAL_GRANT_TABLES.join('|')
    const inline = new RegExp(`\\b"?([a-z_]+)"?\\s+uuid\\b[^,;]*?\\breferences\\s+(?:public\\.)?"?(${alt})\\b`, 'gi')
    const tableLevel = new RegExp(`foreign\\s+key\\s*\\(\\s*"?([a-z_]+)"?\\s*\\)\\s*references\\s+(?:public\\.)?"?(${alt})\\b`, 'gi')
    const found = {}
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, ' ')
      for (const m of [...sql.matchAll(inline), ...sql.matchAll(tableLevel)]) found[m[1].toLowerCase()] = m[2].toLowerCase()
    }
    expect(Object.keys(found).length).toBeGreaterThan(3)
    for (const [col, table] of Object.entries(found)) expect(FK_ALIASES[col], `${col} → ${table}`).toBe(table)
    expect(FK_ALIASES).toMatchObject({
      location_id: 'locations', anchor_location_id: 'locations', master_location_id: 'locations',
      sending_location_id: 'locations', channel_connection_id: 'channel_connections',
    })
  })
})

// ── migrations after 648 ──────────────────────────────────────────────
const ident = (s) => s.trim().replace(/["']/g, '').toLowerCase()
function splitTop(list) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Every GRANT of a TABLE-LEVEL privilege (no column list) to a client role on the five tables. */
function tableLevelClientGrants(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  const hits = []
  for (const m of code.matchAll(/\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi)) {
    const [stmt, privs, target, to] = m
    const tableLevel = splitTop(privs).some((p) => !p.includes('('))
    if (!tableLevel) continue
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => ['authenticated', 'anon', 'public'].includes(g))) continue
    const all = target.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(target.trim())) continue
    const tables = splitTop(target.replace(/^\s*table\s+/i, '')).map((t) => ident(t).replace(/^public\./, ''))
    if (tables.some((t) => CREDENTIAL_GRANT_TABLES.includes(t))) hits.push(stmt.trim())
  }
  return hits
}

// ROLLING BACK mig 648: forward-only, so the rollback is a NEW migration named
// `<NNN>_secfix3c_rollback.sql` (NNN > 648). That exact name is exempt from
// the table-level-grant check below and from nothing else; keep this whole
// describe in place (the column checks still bind every other file). Its
// body is the form in mig 648's header: REVOKE ALL then GRANT ALL on the
// five tables, FROM/TO authenticated, anon, one transaction, no column lists.
const isSecfix3cRollback = (file) =>
  /^\d+_secfix3c_rollback\.sql$/.test(file) && parseInt(file, 10) > CREDENTIAL_GRANT_MIGRATION

describe('later migrations keep the credential grants (SECFIX.3c)', () => {
  const dir = path.join(ROOT, 'supabase/migrations')
  const later = readdirSync(dir).filter((f) => f.endsWith('.sql') && parseInt(f, 10) > CREDENTIAL_GRANT_MIGRATION)
  const COLUMN_TABLES = Object.keys(CREDENTIAL_COLUMN_GRANTS).join('|')

  const addedColumns = (sql) => [...sql.matchAll(new RegExp(
    `alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?(?:public\\.)?(${COLUMN_TABLES})\\b([\\s\\S]*?);`, 'gi'))]
    .flatMap((m) => [...m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?/gi)].map((c) => [m[1].toLowerCase(), c[1]]))

  const decided = (sql, table, col) =>
    new RegExp(`grant\\s+select\\s*\\([^)]*\\b${col}\\b[^)]*\\)\\s*on\\s+(?:table\\s+)?(?:public\\.)?${table}\\s+to\\s+authenticated`, 'i').test(sql)
    || new RegExp(`--\\s*column-grant:\\s*withheld\\s+${table}\\.${col}\\b`, 'i').test(sql)

  it('mig 648 itself is on disk and grants no table-level client privilege', () => {
    const file = readdirSync(dir).find((f) => parseInt(f, 10) === CREDENTIAL_GRANT_MIGRATION && /credential_column_grants/.test(f))
    expect(file).toBe('648_credential_column_grants.sql')
    expect(tableLevelClientGrants(readFileSync(path.join(dir, file), 'utf8'))).toEqual([])
  })

  it.each(later.length ? later : ['(none yet)'])('%s: a new column is granted or withheld on purpose', (file) => {
    if (file === '(none yet)') return
    const sql = readFileSync(path.join(dir, file), 'utf8')
    for (const [table, col] of addedColumns(sql)) {
      expect(decided(sql, table, col), `${file} adds ${table}.${col}: GRANT SELECT (${col}) ON public.${table} TO authenticated, or "-- column-grant: withheld ${table}.${col}"`).toBe(true)
      const { select, withheld } = CREDENTIAL_COLUMN_GRANTS[table]
      expect([...select, ...withheld], `add ${col} to tests/helpers/credential-column-grants.js`).toContain(col)
    }
  })

  it.each(later.length ? later : ['(none yet)'])('%s: no table-level client grant on a credential table', (file) => {
    if (file === '(none yet)' || isSecfix3cRollback(file)) return
    expect(tableLevelClientGrants(readFileSync(path.join(dir, file), 'utf8')),
      `${file}: a table-level grant reopens every withheld credential (mig 648). Grant columns instead`).toEqual([])
  })

  it('a SECFIX.3c rollback migration is allow-listed by its file name, and nothing else is', () => {
    expect(isSecfix3cRollback('651_secfix3c_rollback.sql')).toBe(true)
    expect(isSecfix3cRollback('652_secfix3c_rollback.sql')).toBe(true)
    for (const name of ['651_restore_location_grants.sql', '651_secfix3c_rollback_and_more.sql', 'secfix3c_rollback.sql',
      '651_secfix3c_rollback.sql.bak', '647_secfix3c_rollback.sql']) expect(isSecfix3cRollback(name), name).toBe(false)
  })

  it('the column-add detector sees an added column and accepts either decision', () => {
    const undecided = 'ALTER TABLE public.locations ADD COLUMN shelly_token text;'
    expect(addedColumns(undecided)).toEqual([['locations', 'shelly_token']])
    expect(decided(undecided, 'locations', 'shelly_token')).toBe(false)
    expect(decided(`${undecided}\n-- column-grant: withheld locations.shelly_token`, 'locations', 'shelly_token')).toBe(true)
    expect(decided(`${undecided}\nGRANT SELECT (shelly_token) ON public.locations TO authenticated;`, 'locations', 'shelly_token')).toBe(true)
    expect(addedColumns('ALTER TABLE public.location_holidays ADD COLUMN note text;')).toEqual([])
  })

  it('the table-level detector catches every form and passes column grants', () => {
    const bad = [
      'GRANT SELECT ON public.locations TO authenticated;',
      'grant update on table xero_connections to authenticated;',
      'GRANT ALL ON "public"."channel_connections" TO PUBLIC;',
      'GRANT INSERT ON public.whatsapp_numbers TO anon;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT INSERT ON ALL TABLES IN SCHEMA public TO anon;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.contact_external_integrations TO authenticated'; END $$;`,
    ]
    for (const sql of bad) expect(tableLevelClientGrants(sql), sql).not.toEqual([])
    const ok = [
      'GRANT SELECT (colour) ON public.locations TO authenticated;',
      'GRANT UPDATE (colour) ON public.locations TO authenticated;',
      'GRANT SELECT ON public.locations TO service_role;',
      'GRANT SELECT ON public.location_holidays TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
      'REVOKE ALL ON public.locations FROM authenticated, anon;',
      '-- rollback: GRANT ALL ON public.locations TO authenticated;',
    ]
    for (const sql of ok) expect(tableLevelClientGrants(sql), sql).toEqual([])
  })
})
