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
//  3. (WAANONREAD.1, mig 673) anon and PUBLIC hold NOTHING on
//     whatsapp_messages: a migration may not GRANT them any privilege (SELECT
//     and MAINTAIN included, column lists too, by name or through ALL TABLES
//     IN SCHEMA public), hand anon a role (GRANT <role> TO anon: it inherits
//     whatever the role holds), add a permissive policy that admits them (TO
//     anon, TO public, or no TO clause at all, which means PUBLIC), re-point
//     an existing policy at them (ALTER POLICY … TO), or CREATE or RENAME a
//     table or view to the name (the default ACL re-grants ALL to anon). The
//     one exemption, for rule 3 only, is a rollback migration named
//     `<NNN>_waanonread1_rollback.sql`.
//
// A floor, not a proof: a builder held in a variable, or SQL built at
// runtime, is invisible. Server code is not checked: service_role bypasses
// grants. Same detector shape as tests/contacts-client-writes-guard.test.js
// (mig 653), parameterised by table. SQL comments are blanked by one quote-
// and dollar-aware pass that pairs each $tag$ body with its own closing tag
// (sqlCode, tests/function-execute-guard.test.js), never by a regex; a GRANT
// run from EXECUTE '…' counts.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const WA_MSG_WRITES_OFF_MIGRATION = 656
const WA_ANON_CLOSED_MIGRATION = 673
const TABLE = 'whatsapp_messages'
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ANON_ROLLBACK_FILE = /^\d+_waanonread1_rollback\.sql$/

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
  const code = sqlCode(sql)
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

// One statement each: no part may cross a ';', and the role list also ends
// at a quote or a dollar sign (a GRANT run from EXECUTE '…'). ALTER DEFAULT
// PRIVILEGES statements are removed first: they change future tables only.
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_ON = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const NAME = '(?:"?public"?\\s*\\.\\s*)?"?whatsapp_messages"?'
// A role list ends at WITH … (GRANT/ADMIN/INHERIT/SET OPTION, or PG 16's
// WITH INHERIT TRUE) or GRANTED BY.
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+(grant|admin|inherit|set)\b|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
const admitsAnon = (list) => rolesOf(list).some((r) => r === 'anon' || r === 'public')
// A policy's head: everything before USING / WITH CHECK, so a literal in the
// expression ('to customer') is never read as its TO clause.
const policyHead = (body) => body.split(/\b(?:using|with\s+check)\b/i)[0]
// GRANT <role>[, …] TO … (no ON): these words would make it a privilege grant.
const PRIV_WORDS = ['all', 'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'usage', 'execute', 'create', 'connect', 'temporary', 'temp']

/** Every statement in `sql` that would give anon or PUBLIC anything on public.whatsapp_messages again (mig 673). */
export function waMessageAnonReopeners(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, , target, to] of code.matchAll(GRANT_ON)) {
    if (!rolesOf(to).some((r) => r === 'anon' || r === 'public')) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(t)) continue
    if (splitTop(t.replace(/^table\s+/i, '')).map((x) => ident(x).replace(/^public\s*\.\s*/, '')).includes(TABLE)) hits.push(stmt.trim())
  }
  // Role membership: anon inherits everything the granted role holds.
  for (const [stmt, roles, to] of code.matchAll(/\bgrant\s+("?[a-z_]\w*"?(?:\s*,\s*"?[a-z_]\w*"?)*)\s+to\s+([^;'$]+)/gi)) {
    if (splitTop(roles).map(ident).some((r) => PRIV_WORDS.includes(r))) continue
    if (admitsAnon(to)) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+policy\\s+(?:"[^"]+"|\\S+)\\s+on\\s+${NAME}(?=[\\s;])([^;]*)`, 'gi'))) {
    const head = policyHead(m[1])
    if (/\bas\s+restrictive\b/i.test(head)) continue   // a restrictive policy can only deny
    const to = head.match(/\bto\s+([\s\S]+)$/i)
    if (!to || admitsAnon(to[1])) hits.push(m[0].trim())   // no TO clause means PUBLIC
  }
  // ALTER POLICY … TO re-points an existing policy (it cannot change its kind,
  // so this flags a restrictive one too: a floor, stop and look).
  for (const m of code.matchAll(new RegExp(`\\balter\\s+policy\\s+(?:"[^"]+"|\\S+)\\s+on\\s+${NAME}(?=[\\s;])([^;]*)`, 'gi'))) {
    const head = policyHead(m[1])
    if (/^\s*rename\b/i.test(head)) continue
    const to = head.match(/\bto\s+([\s\S]+)$/i)
    if (to && admitsAnon(to[1])) hits.push(m[0].trim())
  }
  // A table or view created under the name gets the default ACL (anon: ALL).
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:(?:unlogged|materialized|recursive)\\s+)*(?:table|view)\\s+(?:if\\s+not\\s+exists\\s+)?${NAME}(?=[\\s(;])`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(/\balter\s+(?:table|view|materialized\s+view)\s+[^;]*?\brename\s+to\s+"?whatsapp_messages"?(?=[\s;]|$)/gi)) hits.push(m[0].trim())
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

describe('later migrations keep whatsapp_messages closed to anon (WAANONREAD.1, mig 673)', () => {
  it('mig 673 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${WA_ANON_CLOSED_MIGRATION}_`))).toBe(true)
  })

  // From 631, not 673: migration numbers are reserved ahead of time and a
  // lower number can merge later (631 is the HELD #1774, 663 PR #1849 when
  // 673 was written). 631-672 give anon nothing on the table (checked).
  const ANON_SCAN_FROM = 631
  const later = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= ANON_SCAN_FROM && !ANON_ROLLBACK_FILE.test(f))
  it.each(later)('%s: gives anon/PUBLIC nothing on whatsapp_messages', (file) => {
    expect(waMessageAnonReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} re-opens whatsapp_messages to anon/PUBLIC (mig 673). Nothing reads it signed out; read it signed in or through a route`).toEqual([])
  })

  it('the anon detector catches every form', () => {
    const bad = [
      'GRANT SELECT ON public.whatsapp_messages TO anon;',
      'grant select on table whatsapp_messages to authenticated, anon;',
      'GRANT MAINTAIN ON "public"."whatsapp_messages" TO PUBLIC;',
      'GRANT SELECT (id, body) ON public.whatsapp_messages TO anon;',
      'GRANT ALL ON public.whatsapp_conversations, public.whatsapp_messages TO anon;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.whatsapp_messages TO anon'; END $$;`,
      `DO $x$ BEGIN EXECUTE 'GRANT SELECT ON public.whatsapp_messages TO public'; END $x$;`,
      'CREATE POLICY wa_msg_peek ON public.whatsapp_messages FOR SELECT TO anon USING (true);',
      'create policy "p" on whatsapp_messages for select to authenticated, public using (true);',
      'CREATE POLICY wa_msg_open ON public.whatsapp_messages FOR SELECT USING (true);',
      'CREATE TABLE IF NOT EXISTS public.whatsapp_messages (id uuid);',
      'ALTER TABLE public.whatsapp_messages_v2 RENAME TO whatsapp_messages;',
      "SELECT '/*';\nGRANT SELECT ON public.whatsapp_messages TO anon;\nSELECT '*/';",
      // a '/*' inside a dollar body ends with that body: only $tag$ pairing sees the GRANT
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT SELECT ON public.whatsapp_messages TO anon;\nSELECT $d$ */ $d$;",
      // an existing policy re-pointed at anon/PUBLIC
      'ALTER POLICY wa_msg_select ON public.whatsapp_messages TO anon, authenticated;',
      'alter policy "p" on whatsapp_messages to public using (true);',
      `DO $$ BEGIN EXECUTE 'ALTER POLICY wa_msg_select ON public.whatsapp_messages TO anon'; END $$;`,
      // role membership: anon inherits whatever the role holds (no ON clause)
      'GRANT authenticated TO anon;',
      'grant "wa_reader" to anon;',
      'GRANT wa_reader TO anon WITH INHERIT TRUE;',
      // no TO clause (= PUBLIC), with a literal that reads like one
      "CREATE POLICY p ON public.whatsapp_messages FOR SELECT USING (direction = 'to customer');",
      // a view under the name inherits the default ACL (anon: ALL)
      'CREATE VIEW public.whatsapp_messages AS SELECT 1;',
      'create or replace view whatsapp_messages as select 1;',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS public.whatsapp_messages AS SELECT 1;',
      'ALTER VIEW public.wa_msg_v RENAME TO whatsapp_messages;',
    ]
    for (const sql of bad) expect(waMessageAnonReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT SELECT ON public.whatsapp_messages TO authenticated;',
      'GRANT ALL ON public.whatsapp_messages TO service_role;',
      'GRANT SELECT ON public.whatsapp_messages_archive TO anon;',
      'GRANT SELECT ON public.public_things TO anon;',
      'REVOKE ALL ON public.whatsapp_messages FROM anon, PUBLIC;',
      'CREATE POLICY wa_msg_select ON public.whatsapp_messages FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY wa_msg_deny ON public.whatsapp_messages AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY p ON public.whatsapp_messages_archive FOR SELECT TO anon USING (true);',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;',
      'ALTER TABLE public.whatsapp_messages RENAME COLUMN body TO text_body;',
      'CREATE TABLE public.whatsapp_messages_archive (id uuid);',
      '-- rollback: GRANT SELECT ON public.whatsapp_messages TO anon;',
      '/* GRANT ALL ON public.whatsapp_messages TO anon; */',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
         -- GRANT SELECT ON public.whatsapp_messages TO anon;
       END $$;`,
      "SELECT has_table_privilege('anon', 'public.whatsapp_messages', 'SELECT');",
      'ALTER POLICY wa_msg_select ON public.whatsapp_messages RENAME TO wa_msg_read;',
      "ALTER POLICY wa_msg_select ON public.whatsapp_messages TO authenticated USING (direction = 'to anon');",
      "CREATE POLICY p ON public.whatsapp_messages FOR SELECT TO authenticated USING (direction = 'to public');",
      'ALTER POLICY p ON public.whatsapp_messages_archive TO anon;',
      'GRANT anon TO authenticator;',
      'GRANT authenticated TO service_role;',
      'CREATE VIEW public.whatsapp_messages_v AS SELECT 1;',
      'ALTER VIEW public.whatsapp_messages_v RENAME COLUMN a TO whatsapp_messages;',
    ]
    for (const sql of ok) expect(waMessageAnonReopeners(sql), sql).toEqual([])
  })

  it('the rollback exemption is by exact name, and covers the anon rule only', () => {
    expect(ANON_ROLLBACK_FILE.test('674_waanonread1_rollback.sql')).toBe(true)
    expect(ANON_ROLLBACK_FILE.test('674_whatsapp_messages_anon_regrant.sql')).toBe(false)
    // the write rule still reads a rollback file
    expect(waMessageWriteReopeners('GRANT INSERT ON public.whatsapp_messages TO anon;')).not.toEqual([])
  })
})
