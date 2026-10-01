// CONSENTCLIENTWRITE.1 guard (mig 660). anon/authenticated hold no write
// privilege on public.contact_preferences, public.contact_location_preferences
// and public.consent_log. (Since mig 662, CONSENTREAD.1, they hold no privilege
// at all and the tables have no policy: tests/consent-tables-client-closed-guard.test.js.)
// Pinned here:
//
//  1. Browser and phone code never WRITES these tables. Client-run code =
//     shared/, mobile/, and every src/ file that is 'use client', imports
//     createBrowserClient, or queries with the caller's own session
//     (createAuthClient). A client write would 42501 in production. Change
//     consent through a service-role route that writes consent_log in the same
//     request: /api/contacts/[id]/marketing-preferences (staff),
//     /api/preferences/[token] and /api/unsubscribe/[token] (the customer).
//  2. A later migration may not give a client role (anon, authenticated,
//     PUBLIC) any write privilege (MAINTAIN included) on them, at table or
//     column level, by name or through ALL TABLES IN SCHEMA public, may not
//     hand a client role another role, and may not add a permissive
//     INSERT/UPDATE/DELETE/ALL policy to them.
//
// A floor, not a proof: a builder held in a variable, or SQL built at runtime,
// is invisible. Server code is not checked: service_role bypasses grants.
// champ-app is another repo and never names these tables (C64 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONSENT_WRITES_OFF_MIGRATION = 660
const TABLES = ['contact_preferences', 'contact_location_preferences', 'consent_log']
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')

const WRITE = /\.from\(\s*['"`](contact_preferences|contact_location_preferences|consent_log)['"`]\s*\)\s*\??\.\s*(insert|update|upsert|delete)\s*\(/g
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

// Client-bound: runs in the browser, or queries with the signed-in user's own
// session on the server (createAuthClient). Either one is refused by mig 660.
function isBrowserFile(text) {
  const code = stripComments(text).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code)
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isBrowserFile(readFileSync(f, 'utf8')))
  return [...phone, ...browser]
}

/** Every write to a consent table in `text`, as "<table>.<op>". */
export function consentWrites(text) {
  return [...stripComments(text).matchAll(WRITE)].map((m) => `${m[1]}.${m[2]}`)
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

/** Every statement in `sql` that would let a client role write a consent table again. */
export function consentWriteReopeners(sql) {
  const code = sqlCode(sql)
  const hits = []
  for (const m of code.matchAll(/\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi)) {
    const [stmt, privs, target, to] = m
    if (!/\b(all|insert|update|delete|truncate|references|trigger|maintain)\b/i.test(privs.replace(/\([^)]*\)/g, ' '))) continue
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT_ROLES.includes(g))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|tables|all\s)/i.test(t)) continue
    const tables = splitTop(t.replace(/^table\s+/i, '')).map((x) => ident(x).replace(/^public\./, ''))
    if (tables.some((x) => TABLES.includes(x))) hits.push(stmt.trim())
  }
  // A role that may hold writes, handed to a client role (GRANT <role> TO …, no ON).
  for (const m of code.matchAll(/\bgrant\s+("?[a-z_][\w]*"?(?:\s*,\s*"?[a-z_][\w]*"?)*)\s+to\s+([^;]+?)(?:;|$)/gi)) {
    const [stmt, roles, to] = m
    if (/\bon\b/i.test(stmt)) continue
    const granted = splitTop(roles).map(ident)
    if (granted.some((r) => ['all', 'select', 'insert', 'update', 'delete', 'usage', 'execute', 'maintain'].includes(r))) continue
    const grantees = splitTop(to.replace(/\s+with\s+(admin|inherit|set)\s+option[\s\S]*$/i, '')).map(ident)
    if (grantees.some((g) => CLIENT_ROLES.includes(g))) hits.push(stmt.trim())
  }
  const policyOn = /\bcreate\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+(?:"?public"?\.)?"?(contact_preferences|contact_location_preferences|consent_log)"?(?=[\s;])([\s\S]*?)(?:;|$)/gi
  for (const m of code.matchAll(policyOn)) {
    const body = m[2]
    if (/\bas\s+restrictive\b/i.test(body)) continue   // a restrictive policy can only deny
    const f = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)
    if (!f || f[1].toLowerCase() !== 'select') hits.push(m[0].trim())
  }
  return hits
}

describe('client code never writes consent (CONSENTCLIENTWRITE.1, mig 660)', () => {
  const files = clientFiles()

  it('scans the files it is meant to police (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/app/(member)/account/notifications.jsx', 'shared/dashboard-data.js',
      'src/components/ContactMarketingPreferencesCard.jsx', 'src/components/ContactConsentHistoryCard.jsx',
      'src/components/UnsubscribePage.jsx',
    ]))
    // …and service-role route handlers are not in it: a route is scanned only
    // when it queries with the caller's own session (createAuthClient).
    const routes = files.filter((f) => rel(f).startsWith('src/app/api/'))
    for (const f of routes) expect(/\bcreateAuthClient\s*\(/.test(readFileSync(f, 'utf8')), rel(f)).toBe(true)
  })

  it('no browser or phone file writes a consent table', () => {
    const offenders = []
    for (const f of files) for (const op of consentWrites(readFileSync(f, 'utf8'))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'change consent through a service-role route that writes consent_log (mig 660 refuses client writes)').toEqual([])
  })

  it('the detector catches every write shape and ignores reads and comments', () => {
    const bad = `
      await supabase.from('contact_preferences').update({ email_marketing: true }).eq('contact_id', id)
      await supabase.from("contact_location_preferences")
        .insert(row)
      await db.from(\`consent_log\`).delete().eq('contact_id', id)
      await supabase.from('contact_preferences') . upsert(row, { onConflict: 'contact_id' })
      await supabase?.from('consent_log')?.insert(row)`
    expect(consentWrites(bad)).toEqual([
      'contact_preferences.update', 'contact_location_preferences.insert', 'consent_log.delete',
      'contact_preferences.upsert', 'consent_log.insert',
    ])
    const ok = `
      await supabase.from('contact_preferences').select('email_marketing').eq('contact_id', id)
      // await supabase.from('consent_log').insert(row)
      const r = await fetch(\`/api/contacts/\${id}/marketing-preferences\`, { method: 'PUT' })
      await supabase.from('contacts').select('id, contact_preferences ( email_marketing )')`
    expect(consentWrites(ok)).toEqual([])
  })
})

describe('later migrations keep consent read-only for clients (mig 660)', () => {
  it('a server file that queries with the signed-in user\'s session is client-bound', () => {
    expect(isBrowserFile(`import { createAuthClient } from '@/lib/supabase'\nconst db = createAuthClient()`)).toBe(true)
    expect(isBrowserFile(`import { createServerClient } from '@/lib/supabase'`)).toBe(false)
  })

  it('mig 660 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${CONSENT_WRITES_OFF_MIGRATION}_`))).toBe(true)
  })

  // From 652, not 660: a lower-numbered migration merged AFTER 660 must not
  // escape (652 C50 recreates contact_location_audience and was not yet
  // written; 656-659 were in flight). 001-651 predate the rule and hold the
  // legacy grants/policies 660 removes; 653-655 grant nothing on these tables.
  const SCAN_FROM = 652
  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= SCAN_FROM)
  it.each(later)('%s: no client write privilege and no permissive write policy on a consent table', (file) => {
    expect(consentWriteReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} reopens client writes on consent (mig 660). Write through a service-role route that logs consent_log`).toEqual([])
  })

  // GUARDSTRIP.1 (C74): a '/*' inside a string, or after a DO block's $$, hid
  // the GRANT from the old regex / unpaired stripper.
  it('a /* inside a string or a later $$ literal hides no GRANT (GUARDSTRIP.1)', () => {
    expect(consentWriteReopeners("SELECT '/*';\nGRANT UPDATE ON public.contact_preferences TO authenticated;\nSELECT '*/';"), 'string').not.toEqual([])
    expect(consentWriteReopeners("DO $$ BEGIN PERFORM 1; END $$;\nSELECT $$ /* $$;\nGRANT UPDATE ON public.contact_preferences TO authenticated;\nSELECT $$ */ $$;"), 'dollar').not.toEqual([])
  })

  it('the migration detector catches every form and passes the safe ones', () => {
    const bad = [
      'GRANT UPDATE ON public.contact_preferences TO authenticated;',
      'grant insert, delete on table consent_log to anon, authenticated;',
      'GRANT ALL ON "public"."contact_location_preferences" TO PUBLIC;',
      'GRANT UPDATE (email_marketing) ON public.contact_preferences TO authenticated;',
      'GRANT MAINTAIN ON public.consent_log TO authenticated;',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT DELETE ON public.deals, public.consent_log TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.contact_preferences TO authenticated'; END $$;`,
      'CREATE POLICY cp_staff_update ON public.contact_preferences FOR UPDATE TO authenticated USING (true);',
      'create policy "x" on consent_log to authenticated using (true);',
      'CREATE POLICY clp_all ON public.contact_location_preferences FOR ALL USING (true);',
      'GRANT consent_writer TO authenticated;',
    ]
    for (const sql of bad) expect(consentWriteReopeners(sql), sql).not.toEqual([])
    const ok = [
      'GRANT SELECT ON public.contact_preferences TO authenticated;',
      'GRANT SELECT (id, email_marketing) ON public.contact_preferences TO authenticated;',
      'GRANT ALL ON public.consent_log TO service_role;',
      'GRANT UPDATE ON public.contacts_archive TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'REVOKE INSERT, UPDATE, DELETE, MAINTAIN ON public.consent_log FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY consent_log_select ON public.consent_log FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY cp_deny ON public.contact_preferences AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY contact_devices_insert ON public.contact_devices FOR INSERT WITH CHECK (true);',
      '-- rollback: GRANT UPDATE ON public.contact_preferences TO authenticated;',
      'GRANT authenticated TO authenticator;',
    ]
    for (const sql of ok) expect(consentWriteReopeners(sql), sql).toEqual([])
  })
})
