// CONSENTREAD.1 guard (mig 662). anon/authenticated hold NO privilege on
// public.contact_preferences, public.contact_location_preferences,
// public.consent_log or the view public.contact_location_audience, and the
// three tables have RLS on with no policy. The unsubscribe token in
// contact_preferences is the credential behind the public preference centre;
// a staff browser must never hold it. Pinned here:
//
//  1. Browser and phone code never READS these relations: no .from('<rel>'),
//     no embed of a consent table inside another table's select string, no
//     realtime subscription. Client-run code = shared/, mobile/, and every src/
//     file that is 'use client', imports createBrowserClient, or queries with
//     the caller's own session (createAuthClient). A client read would 42501
//     in production. Read consent through /api/contacts/[id]/marketing-
//     preferences, /api/contacts/[id]/consent-log, or another service-role
//     route that returns only what the screen needs (never the token).
//  2. A later migration may not give a client role (anon, authenticated,
//     PUBLIC) ANY privilege (SELECT included) on them, by name or through ALL
//     TABLES IN SCHEMA public, and may not add a permissive policy to the
//     three tables. A re-created view must restore its ACL from the catalog
//     (the C50 / mig 652 pattern), never with a literal client grant.
//
// A floor, not a proof: a builder held in a variable, or SQL built at runtime,
// is invisible. Server code is not checked: service_role bypasses grants.
// champ-app is another repo and never names these relations (C68 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONSENT_CLOSED_MIGRATION = 662
const TABLES = ['contact_preferences', 'contact_location_preferences', 'consent_log']
const RELS = [...TABLES, 'contact_location_audience']
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')

const FROM = /\.from\(\s*['"`](contact_preferences|contact_location_preferences|consent_log|contact_location_audience)['"`]\s*\)/g
// An embed inside a select string: 'id, contact_preferences(unsubscribe_token)',
// 'prefs:contact_preferences!inner(…)'. Anchored at a quote so plain prose is not matched.
const EMBED = /['"`][^'"`]*?\b(contact_preferences|contact_location_preferences|consent_log)\s*(?:!\s*\w+\s*)?\(/g
const REALTIME = /\btable\s*:\s*['"`](contact_preferences|contact_location_preferences|consent_log)['"`]/g
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function isBrowserFile(text) {
  const code = stripComments(text).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code)
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isBrowserFile(readFileSync(f, 'utf8')))
  return [...phone, ...browser]
}

/** Every client read of a consent relation in `text`, as "<kind>:<relation>". */
export function consentReads(text) {
  const code = stripComments(text)
  return [
    ...[...code.matchAll(FROM)].map((m) => `from:${m[1]}`),
    ...[...code.matchAll(EMBED)].map((m) => `embed:${m[1]}`),
    ...[...code.matchAll(REALTIME)].map((m) => `realtime:${m[1]}`),
  ]
}

// ── migrations ───────────────────────────────────────────────────────────
const CLIENT_ROLES = ['authenticated', 'anon', 'public']
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

/** Every statement in `sql` that would give a client role access to a consent relation again. */
export function consentReopeners(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  const hits = []
  for (const m of code.matchAll(/\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi)) {
    const [stmt, , target, to] = m
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT_ROLES.includes(g))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|tables|all\s)/i.test(t)) continue
    const targets = splitTop(t.replace(/^table\s+/i, '')).map((x) => ident(x).replace(/^public\./, ''))
    if (targets.some((x) => RELS.includes(x))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(/\bcreate\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+(?:"?public"?\.)?"?(contact_preferences|contact_location_preferences|consent_log)"?(?=[\s;])([\s\S]*?)(?:;|$)/gi)) {
    if (/\bas\s+restrictive\b/i.test(m[2])) continue
    hits.push(m[0].trim())
  }
  return hits
}

describe('client code never reads consent (CONSENTREAD.1, mig 662)', () => {
  const files = clientFiles()

  it('scans the files it is meant to police (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'src/components/ContactConsentHistoryCard.jsx', 'src/components/ContactMarketingPreferencesCard.jsx',
      'src/components/UnsubscribePage.jsx', 'mobile/app/(member)/account/notifications.jsx', 'shared/dashboard-data.js',
    ]))
    // …and service-role route handlers are not in it: a route is scanned only
    // when it queries with the caller's own session (createAuthClient).
    const routes = files.filter((f) => rel(f).startsWith('src/app/api/'))
    for (const f of routes) expect(/\bcreateAuthClient\s*\(/.test(readFileSync(f, 'utf8')), rel(f)).toBe(true)
  })

  it('no browser or phone file reads the consent tables or the audience view', () => {
    const offenders = []
    for (const f of files) for (const r of consentReads(readFileSync(f, 'utf8'))) offenders.push(`${rel(f)}: ${r}`)
    expect(offenders, 'read consent through a service-role route (mig 662 refuses client reads)').toEqual([])
  })

  it('the detector catches every read shape and ignores routes, prose and comments', () => {
    const bad = `
      await supabase.from('contact_preferences').select('unsubscribe_token').eq('contact_id', id)
      await supabase.from("consent_log")
        .select('ip_address')
      await db.from(\`contact_location_audience\`).select('id', { count: 'exact', head: true })
      await supabase.from('contacts').select('id, contact_preferences(unsubscribe_token)')
      await supabase.from('contacts').select(\`id,
        prefs:contact_location_preferences!inner(email_marketing)\`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'consent_log' }, cb)`
    expect(consentReads(bad)).toEqual([
      'from:contact_preferences', 'from:consent_log', 'from:contact_location_audience',
      'embed:contact_preferences', 'embed:contact_location_preferences', 'realtime:consent_log',
    ])
    const ok = `
      const res = await fetch(\`/api/contacts/\${id}/consent-log\`)
      await fetch('/api/contacts/' + id + '/marketing-preferences', { method: 'PUT' })
      // await supabase.from('contact_preferences').select('*')
      {/* the consent_log history, via the route */}
      await supabase.from('contacts').select('id, email_marketing')`
    expect(consentReads(ok)).toEqual([])
  })
})

describe('later migrations keep the consent relations closed to clients (mig 662)', () => {
  it('mig 662 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${CONSENT_CLOSED_MIGRATION}_`))).toBe(true)
  })

  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= CONSENT_CLOSED_MIGRATION)
  it.each(later)('%s: no client privilege and no permissive policy on the consent relations', (file) => {
    expect(consentReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} reopens a consent relation to clients (mig 662). Read it through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form and passes the safe ones', () => {
    const bad = [
      'GRANT SELECT ON public.contact_preferences TO authenticated;',
      'grant select (contact_id, email_marketing) on contact_preferences to authenticated;',
      'GRANT SELECT ON public.contact_location_audience TO anon, authenticated;',
      'GRANT ALL ON "public"."consent_log" TO PUBLIC;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON public.contacts, public.contact_location_preferences TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.consent_log TO authenticated'; END $$;`,
      'CREATE POLICY consent_log_select ON public.consent_log FOR SELECT TO authenticated USING (true);',
      'create policy "x" on contact_preferences to authenticated using (true);',
    ]
    for (const sql of bad) expect(consentReopeners(sql), sql).not.toEqual([])
    const ok = [
      'GRANT ALL ON public.contact_preferences TO service_role;',
      'GRANT SELECT ON public.contact_location_audience TO service_role;',
      'GRANT SELECT ON public.contacts TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO service_role;',
      'REVOKE ALL ON public.consent_log FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY d ON public.consent_log AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public USING (true);',
      '-- rollback: GRANT SELECT ON public.consent_log TO authenticated;',
    ]
    for (const sql of ok) expect(consentReopeners(sql), sql).toEqual([])
  })
})
