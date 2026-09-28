// CONTACTSELFWRITE.1 guard (mig 653). anon/authenticated hold SELECT only on
// public.contacts, and the only policy is contacts_select. Pinned here:
//
//  1. Browser and phone code never WRITES contacts. Client-run code = shared/,
//     mobile/, and every src/ file that is 'use client' or imports
//     createBrowserClient. A client write would 42501 in production; this
//     catches it at review. Write through a service-role /api route that
//     checks the caller (assertLocationAccess, permission, 404-not-403).
//  2. A later migration may not give a client role (anon, authenticated,
//     PUBLIC) any write privilege on contacts, at table or column level, by
//     name or through ALL TABLES IN SCHEMA public, and may not add a
//     permissive INSERT/UPDATE/DELETE/ALL policy to it.
//
// A floor, not a proof: a builder held in a variable, or a SQL string built at
// runtime, is invisible. Server code (src/ route handlers and libs) is not
// checked: service_role bypasses grants. champ-app is another repo; its three
// contacts writes are service-role (C49 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONTACTS_WRITES_OFF_MIGRATION = 653
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')

const WRITE = /\.from\(\s*['"`]contacts['"`]\s*\)\s*\??\.\s*(insert|update|upsert|delete)\s*\(/g
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
// session on the server (createAuthClient). Either one is refused by mig 653.
function isBrowserFile(text) {
  const code = stripComments(text).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code)
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isBrowserFile(readFileSync(f, 'utf8')))
  return [...phone, ...browser]
}

export function contactsWrites(text) {
  return [...stripComments(text).matchAll(WRITE)].map((m) => m[1])
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

/** Every statement in `sql` that would let a client role write public.contacts again. */
export function contactsWriteReopeners(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  const hits = []
  for (const m of code.matchAll(/\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi)) {
    const [stmt, privs, target, to] = m
    if (!/\b(all|insert|update|delete|truncate|references|trigger)\b/i.test(privs.replace(/\([^)]*\)/g, ' '))) continue
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT_ROLES.includes(g))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|tables|all\s)/i.test(t)) continue
    const tables = splitTop(t.replace(/^table\s+/i, '')).map((x) => ident(x).replace(/^public\./, ''))
    if (tables.includes('contacts')) hits.push(stmt.trim())
  }
  // A role that may hold writes, granted to a client role (GRANT <role> TO …, no ON).
  for (const m of code.matchAll(/\bgrant\s+("?[a-z_][\w]*"?(?:\s*,\s*"?[a-z_][\w]*"?)*)\s+to\s+([^;]+?)(?:;|$)/gi)) {
    const [stmt, roles, to] = m
    if (/\bon\b/i.test(stmt)) continue
    const granted = splitTop(roles).map(ident)
    if (granted.some((r) => ['all', 'select', 'insert', 'update', 'delete', 'usage', 'execute'].includes(r))) continue
    const grantees = splitTop(to.replace(/\s+with\s+(admin|inherit|set)\s+option[\s\S]*$/i, '')).map(ident)
    if (grantees.some((g) => CLIENT_ROLES.includes(g))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(/\bcreate\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+(?:"?public"?\.)?"?contacts"?(?=[\s;])([\s\S]*?)(?:;|$)/gi)) {
    const body = m[1]
    if (/\bas\s+restrictive\b/i.test(body)) continue   // a restrictive policy can only deny
    const f = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)
    if (!f || f[1].toLowerCase() !== 'select') hits.push(m[0].trim())
  }
  return hits
}

describe('client code never writes contacts (CONTACTSELFWRITE.1, mig 653)', () => {
  const files = clientFiles()

  it('scans the files it is meant to police (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/lib/contacts-api.js', 'mobile/lib/member/contact-context.jsx', 'mobile/lib/identity-context.jsx',
      'shared/dashboard-data.js', 'src/components/TasksPage.jsx',
    ]))
    // …and service-role route handlers are not in it: a route is scanned only
    // when it queries with the caller's own session (createAuthClient).
    const routes = files.filter((f) => rel(f).startsWith('src/app/api/'))
    for (const f of routes) expect(/\bcreateAuthClient\s*\(/.test(readFileSync(f, 'utf8')), rel(f)).toBe(true)
  })

  it('no browser or phone file writes contacts', () => {
    const offenders = []
    for (const f of files) for (const op of contactsWrites(readFileSync(f, 'utf8'))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'write contacts through a service-role /api route that checks the caller (mig 653 refuses client writes)').toEqual([])
  })

  it('the detector catches every write shape and ignores reads and comments', () => {
    const bad = `
      await supabase.from('contacts').update({ tags }).eq('id', id)
      await supabase.from("contacts")
        .insert(row)
      await db.from(\`contacts\`).upsert(row, { onConflict: 'id' })
      await supabase.from('contacts') . delete().eq('id', id)
      await supabase?.from('contacts')?.update({ tags })`
    expect(contactsWrites(bad)).toEqual(['update', 'insert', 'upsert', 'delete', 'update'])
    const ok = `
      await supabase.from('contacts').select('id, name').eq('user_id', uid)
      // await supabase.from('contacts').update({ tags })
      await supabase.from('contact_devices').insert(row)
      await supabase.from('contacts_archive').delete()`
    expect(contactsWrites(ok)).toEqual([])
  })
})

describe('later migrations keep contacts read-only for clients (mig 653)', () => {
  it('a server file that queries with the signed-in user\'s session is client-bound', () => {
    expect(isBrowserFile(`import { createAuthClient } from '@/lib/supabase'\nconst db = createAuthClient()`)).toBe(true)
    expect(isBrowserFile(`import { createServerClient } from '@/lib/supabase'`)).toBe(false)
  })

  it('mig 653 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${CONTACTS_WRITES_OFF_MIGRATION}_`))).toBe(true)
  })

  // From 648, not 653: a lower-numbered migration merged AFTER 653 must not
  // escape (648-652 were all in flight when 653 was written). 001-647 predate
  // the rule and hold the legacy grants/policies 653 removes.
  const SCAN_FROM = 648
  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= SCAN_FROM)
  it.each(later)('%s: no client write grant and no permissive write policy on contacts', (file) => {
    expect(contactsWriteReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} reopens client writes on contacts (mig 653). Write through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form and passes the safe ones', () => {
    const bad = [
      'GRANT UPDATE ON public.contacts TO authenticated;',
      'grant insert, update on table contacts to anon, authenticated;',
      'GRANT ALL ON "public"."contacts" TO PUBLIC;',
      'GRANT UPDATE (name, phone) ON public.contacts TO authenticated;',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT DELETE ON public.deals, public.contacts TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.contacts TO authenticated'; END $$;`,
      'CREATE POLICY contacts_self_update ON public.contacts FOR UPDATE TO authenticated USING (true);',
      'create policy "x" on contacts to authenticated using (true);',
      'CREATE POLICY contacts_all ON public.contacts FOR ALL USING (true);',
      // a role that holds writes, handed to a client role (no ON clause)
      'GRANT contacts_writer TO authenticated;',
      'grant "some_role" to anon, authenticated;',
    ]
    for (const sql of bad) expect(contactsWriteReopeners(sql), sql).not.toEqual([])
    const ok = [
      'GRANT SELECT ON public.contacts TO authenticated;',
      'GRANT SELECT (id, name) ON public.contacts TO authenticated;',
      'GRANT ALL ON public.contacts TO service_role;',
      'GRANT UPDATE ON public.contacts_archive TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid) TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'REVOKE INSERT, UPDATE, DELETE ON public.contacts FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public USING (true);',
      'CREATE POLICY contacts_deny ON public.contacts AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY contact_devices_insert ON public.contact_devices FOR INSERT WITH CHECK (true);',
      '-- rollback: GRANT UPDATE ON public.contacts TO authenticated;',
      'GRANT authenticated TO authenticator;',
    ]
    for (const sql of ok) expect(contactsWriteReopeners(sql), sql).toEqual([])
  })
})
