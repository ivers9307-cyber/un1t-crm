// ANONCONTACTS.1 guard (mig 657). anon holds NOTHING on public.contacts, and
// public.consent_drift_rows() is EXECUTE-able by service_role only. Pinned:
//
//  1. A migration after 657 may not give anon or PUBLIC any privilege on
//     contacts (by name, column list, or ALL TABLES IN SCHEMA public).
//  2. A migration after 657 may not give anon, authenticated or PUBLIC
//     EXECUTE on consent_drift_rows (by name or ALL FUNCTIONS IN SCHEMA
//     public), and one that CREATEs the function must REVOKE its EXECUTE from
//     PUBLIC in the same file: DROP + CREATE resets the ACL to the default
//     (PUBLIC + anon + authenticated, via Postgres and pg_default_acl).
//  3. No client-run code (shared/, mobile/, 'use client' / createBrowserClient
//     src files) calls rpc('consent_drift_rows').
// A floor, not a proof.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const ANON_CONTACTS_MIGRATION = 657
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

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
const GRANT_RE = /\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi
const granteesOf = (to) => splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)

/** GRANTs that give anon/PUBLIC anything on public.contacts. */
export function anonContactsGrants(sql) {
  const hits = []
  for (const [stmt, , target, to] of sqlCode(sql).matchAll(GRANT_RE)) {
    if (!granteesOf(to).some((g) => g === 'anon' || g === 'public')) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|tables|all\s)/i.test(t)) continue
    if (splitTop(t.replace(/^table\s+/i, '')).map((x) => ident(x).replace(/^public\./, '')).includes('contacts')) hits.push(stmt.trim())
  }
  return hits
}

/** GRANT EXECUTE on consent_drift_rows to a client role, or a CREATE with no same-file REVOKE. */
export function consentDriftReopeners(sql) {
  const code = sqlCode(sql)
  const hits = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_RE)) {
    if (!/\b(execute|all)\b/i.test(privs)) continue
    if (!granteesOf(to).some((g) => ['anon', 'authenticated', 'public'].includes(g))) continue
    const t = target.trim()
    const allFns = t.match(/^all\s+(functions|routines)\s+in\s+schema\s+([\s\S]+)$/i)
    if (allFns) { if (splitTop(allFns[2]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(function|routine)\s+(?:"?public"?\.)?"?consent_drift_rows"?\s*\(/i.test(t)) hits.push(stmt.trim())
  }
  const creates = /\bcreate\s+(or\s+replace\s+)?function\s+(?:"?public"?\.)?"?consent_drift_rows"?\s*\(/i.test(code)
  const revokes = /\brevoke\s+(execute|all)[\s\S]*?\bon\s+function\s+(?:"?public"?\.)?"?consent_drift_rows"?\s*\([^)]*\)\s+from\s+[^;]*\bpublic\b/i.test(code)
  if (creates && !revokes) hits.push('CREATE FUNCTION consent_drift_rows without REVOKE EXECUTE … FROM PUBLIC in the same file')
  return hits
}

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
const isBrowserFile = (text) => {
  const code = stripComments(text).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code)
}

describe('later migrations keep anon off contacts and consent_drift_rows server-only (mig 657)', { timeout: 120_000 }, () => {
  it('mig 657 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${ANON_CONTACTS_MIGRATION}_`))).toBe(true)
  })

  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= ANON_CONTACTS_MIGRATION)
  it.each(later)('%s gives anon/PUBLIC nothing on contacts and no client EXECUTE on consent_drift_rows', (file) => {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
    expect(anonContactsGrants(sql), `${file}: anon holds nothing on contacts (mig 657)`).toEqual([])
    expect(consentDriftReopeners(sql), `${file}: consent_drift_rows is service_role only (mig 657)`).toEqual([])
  })

  // GUARDSTRIP.1 (C74): a '/*' inside a string, or after a DO block's $$, hid
  // the GRANT from the old regex / unpaired stripper.
  it('a /* inside a string or a later $$ literal hides no GRANT (GUARDSTRIP.1)', () => {
    expect(anonContactsGrants("SELECT '/*';\nGRANT SELECT ON public.contacts TO anon;\nSELECT '*/';"), 'string').not.toEqual([])
    expect(anonContactsGrants("DO $$ BEGIN PERFORM 1; END $$;\nSELECT $$ /* $$;\nGRANT SELECT ON public.contacts TO anon;\nSELECT $$ */ $$;"), 'dollar').not.toEqual([])
  })

  it('the contacts detector catches every form and passes the safe ones', () => {
    for (const sql of [
      'GRANT SELECT ON public.contacts TO anon;',
      'grant select (id, name) on table contacts to anon;',
      'GRANT ALL ON "public"."contacts" TO PUBLIC;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      'GRANT SELECT ON public.deals, public.contacts TO authenticated, anon;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.contacts TO anon'; END $$;`,
    ]) expect(anonContactsGrants(sql), sql).not.toEqual([])
    for (const sql of [
      'GRANT SELECT ON public.contacts TO authenticated;',
      'GRANT ALL ON public.contacts TO service_role;',
      'GRANT SELECT ON public.contacts_archive TO anon;',
      'REVOKE ALL ON TABLE public.contacts FROM anon, PUBLIC;',
      '-- rollback: GRANT SELECT ON public.contacts TO anon;',
    ]) expect(anonContactsGrants(sql), sql).toEqual([])
  })

  it('the function detector catches every form and passes the safe ones', () => {
    for (const sql of [
      'GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO authenticated;',
      'grant all on function consent_drift_rows() to anon;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;',
      'CREATE OR REPLACE FUNCTION public.consent_drift_rows() RETURNS TABLE(contact_id uuid) LANGUAGE sql AS $$ select 1 $$;',
    ]) expect(consentDriftReopeners(sql), sql).not.toEqual([])
    for (const sql of [
      'GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO service_role;',
      'GRANT EXECUTE ON FUNCTION public.whatsapp_spend_rollup(uuid, timestamptz) TO service_role;',
      `CREATE OR REPLACE FUNCTION public.consent_drift_rows() RETURNS TABLE(contact_id uuid) LANGUAGE sql AS $$ select 1 $$;
       REVOKE EXECUTE ON FUNCTION public.consent_drift_rows() FROM PUBLIC, anon, authenticated;`,
      'REVOKE EXECUTE ON FUNCTION public.consent_drift_rows() FROM PUBLIC, anon, authenticated;',
    ]) expect(consentDriftReopeners(sql), sql).toEqual([])
  })
})

describe('no client-run code calls consent_drift_rows (mig 657)', { timeout: 120_000 }, () => {
  it('finds none, and the one real caller is a server route', () => {
    const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
    const src = walk(path.join(ROOT, 'src'))
    const callers = [...phone, ...src].filter((f) => /\brpc\(\s*['"`]consent_drift_rows['"`]/.test(stripComments(readFileSync(f, 'utf8'))))
    const clientCallers = callers.filter((f) => phone.includes(f) || isBrowserFile(readFileSync(f, 'utf8')))
    expect(clientCallers.map(rel)).toEqual([])
    expect(callers.map(rel)).toEqual(['src/app/api/cron/consent-drift-check/route.js'])
  })
})
