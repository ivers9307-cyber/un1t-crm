// WAMSGCLIENTWRITE.1 guard (mig 656). anon/authenticated hold SELECT only on
// public.whatsapp_messages, and the only policy is wa_msg_select (realtime
// authorises each postgres_changes row through it). Pinned here:
//
//  1. Browser and phone code never WRITES whatsapp_messages. Client-bound code
//     = shared/, mobile/, and every src/ file that is 'use client', imports
//     createBrowserClient, or queries with the signed-in user's own session on
//     the server (createAuthClient). A client write would 42501 in production.
//     Send through /api/whatsapp/conversations/[id]/send (and friends), which
//     check the caller, call Meta and record it.
//  2. A later migration may not give a client role (anon, authenticated,
//     PUBLIC) any write privilege on whatsapp_messages, at table or column
//     level, by name or through ALL TABLES IN SCHEMA public, may not hand a
//     client role another role, and may not add a permissive
//     INSERT/UPDATE/DELETE/ALL policy to it.
//
// A floor, not a proof: a builder held in a variable, or SQL built at
// runtime, is invisible. Server code is not checked: service_role bypasses
// grants. Same detector shape as tests/contacts-client-writes-guard.test.js
// (mig 653), parameterised by table.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const WA_MSG_WRITES_OFF_MIGRATION = 656
const TABLE = 'whatsapp_messages'
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')

const WRITE = /\.from\(\s*['"`]whatsapp_messages['"`]\s*\)\s*\??\.\s*(insert|update|upsert|delete)\s*\(/g
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
// session on the server (createAuthClient). Either one is refused by mig 656.
function isClientBoundFile(text) {
  const code = stripComments(text).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) || /\bcreateAuthClient\s*\(/.test(code)
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientBoundFile(readFileSync(f, 'utf8')))
  return [...phone, ...browser]
}

export function waMessageWrites(text) {
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

/** Every statement in `sql` that would let a client role write public.whatsapp_messages again. */
export function waMessageWriteReopeners(sql) {
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
    if (tables.includes(TABLE)) hits.push(stmt.trim())
  }
  // A role that may hold writes, handed to a client role (GRANT <role> TO …, no ON).
  for (const m of code.matchAll(/\bgrant\s+("?[a-z_][\w]*"?(?:\s*,\s*"?[a-z_][\w]*"?)*)\s+to\s+([^;]+?)(?:;|$)/gi)) {
    const [stmt, roles, to] = m
    if (/\bon\b/i.test(stmt)) continue
    const granted = splitTop(roles).map(ident)
    if (granted.some((r) => ['all', 'select', 'insert', 'update', 'delete', 'usage', 'execute'].includes(r))) continue
    const grantees = splitTop(to.replace(/\s+with\s+(admin|inherit|set)\s+option[\s\S]*$/i, '')).map(ident)
    if (grantees.some((g) => CLIENT_ROLES.includes(g))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(/\bcreate\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+(?:"?public"?\.)?"?whatsapp_messages"?(?=[\s;])([\s\S]*?)(?:;|$)/gi)) {
    const body = m[1]
    if (/\bas\s+restrictive\b/i.test(body)) continue   // a restrictive policy can only deny
    const f = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)
    if (!f || f[1].toLowerCase() !== 'select') hits.push(m[0].trim())
  }
  return hits
}

describe('client code never writes whatsapp_messages (WAMSGCLIENTWRITE.1, mig 656)', () => {
  const files = clientFiles()

  it('scans the files it is meant to police (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/lib/whatsapp-api.js', 'shared/dashboard-data.js',
      'src/components/WAInbox.jsx', 'src/components/UnifiedInbox.jsx',
    ]))
    // …and service-role route handlers are not in it: a route is scanned only
    // when it queries with the caller's own session (createAuthClient).
    const routes = files.filter((f) => rel(f).startsWith('src/app/api/'))
    for (const f of routes) expect(/\bcreateAuthClient\s*\(/.test(readFileSync(f, 'utf8')), rel(f)).toBe(true)
    expect(names).not.toContain('src/app/api/whatsapp/conversations/[id]/send/route.js')
  })

  it('no browser or phone file writes whatsapp_messages', () => {
    const offenders = []
    for (const f of files) for (const op of waMessageWrites(readFileSync(f, 'utf8'))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'send through /api/whatsapp/conversations/[id]/send (mig 656 refuses client writes)').toEqual([])
  })

  it('the detector catches every write shape and ignores reads, realtime and comments', () => {
    const bad = `
      await supabase.from('whatsapp_messages').update({ body }).eq('id', id)
      await supabase.from("whatsapp_messages")
        .insert(row)
      await db.from(\`whatsapp_messages\`).upsert(row)
      await supabase.from('whatsapp_messages') . delete().eq('id', id)
      await supabase?.from('whatsapp_messages')?.update({ status })`
    expect(waMessageWrites(bad)).toEqual(['update', 'insert', 'upsert', 'delete', 'update'])
    const ok = `
      await supabase.from('whatsapp_messages').select('id, body').eq('conversation_id', c)
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' }, cb)
      // await supabase.from('whatsapp_messages').update({ body })
      await supabase.from('whatsapp_conversations').update({ unread_count: 0 })
      await supabase.from('whatsapp_messages_archive').delete()`
    expect(waMessageWrites(ok)).toEqual([])
  })

  it("a server file that queries with the signed-in user's session is client-bound", () => {
    expect(isClientBoundFile(`import { createAuthClient } from '@/lib/auth'\nconst db = await createAuthClient()`)).toBe(true)
    expect(isClientBoundFile(`import { createServerClient } from '@/lib/supabase'`)).toBe(false)
  })
})

describe('later migrations keep whatsapp_messages read-only for clients (mig 656)', () => {
  it('mig 656 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${WA_MSG_WRITES_OFF_MIGRATION}_`))).toBe(true)
  })

  // From 652, not 656: a lower-numbered migration merged AFTER 656 must not
  // escape (652 and 654 were in flight when 656 was written). 001-651 predate
  // the rule and hold the legacy grants/policies 656 removes.
  const SCAN_FROM = 652
  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= SCAN_FROM)
  it.each(later)('%s: no client write privilege and no permissive write policy on whatsapp_messages', (file) => {
    expect(waMessageWriteReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} reopens client writes on whatsapp_messages (mig 656). Write through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form and passes the safe ones', () => {
    const bad = [
      'GRANT INSERT ON public.whatsapp_messages TO authenticated;',
      'grant update on table whatsapp_messages to anon, authenticated;',
      'GRANT ALL ON "public"."whatsapp_messages" TO PUBLIC;',
      'GRANT UPDATE (body, status) ON public.whatsapp_messages TO authenticated;',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT DELETE ON public.whatsapp_conversations, public.whatsapp_messages TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.whatsapp_messages TO authenticated'; END $$;`,
      'CREATE POLICY wa_msg_update_own ON public.whatsapp_messages FOR UPDATE TO authenticated USING (true);',
      'create policy "x" on whatsapp_messages to authenticated using (true);',
      'CREATE POLICY wa_msg_all ON public.whatsapp_messages FOR ALL USING (true);',
      // a role that holds writes, handed to a client role (no ON clause)
      'GRANT wa_writer TO authenticated;',
      'grant "some_role" to anon, authenticated;',
    ]
    for (const sql of bad) expect(waMessageWriteReopeners(sql), sql).not.toEqual([])
    const ok = [
      'GRANT SELECT ON public.whatsapp_messages TO authenticated;',
      'GRANT SELECT (id, body) ON public.whatsapp_messages TO authenticated;',
      'GRANT ALL ON public.whatsapp_messages TO service_role;',
      'GRANT UPDATE ON public.whatsapp_conversations TO authenticated;',
      'GRANT UPDATE ON public.whatsapp_messages_archive TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.whatsapp_spend_rollup(uuid, timestamptz) TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_messages FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY wa_msg_select ON public.whatsapp_messages FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY wa_msg_deny ON public.whatsapp_messages AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY wa_conv_insert ON public.whatsapp_conversations FOR INSERT WITH CHECK (true);',
      '-- rollback: GRANT INSERT ON public.whatsapp_messages TO authenticated;',
      'GRANT authenticated TO authenticator;',
    ]
    for (const sql of ok) expect(waMessageWriteReopeners(sql), sql).toEqual([])
  })
})
