// WATPLCLIENTWRITE.1 guard (mig 669). authenticated holds SELECT only on
// public.whatsapp_templates and public.whatsapp_template_events, anon holds
// nothing, and each table keeps one SELECT policy (wa_tmpl_select feeds the
// phone's template picker and the web template list's realtime). Pinned here:
//
//  1. Browser and phone code never WRITES these tables and never calls
//     increment_whatsapp_template_sent. Client-bound code = shared/, mobile/,
//     and every src/ file that is 'use client' (after any header comment),
//     names createBrowserClient, calls createAuthClient() or holds the anon
//     key. A client write is a 42501 after 669. Act through
//     /api/whatsapp/templates* (sync, create, PUT, resubmit, DELETE,
//     upload-media), which check the caller's role (C79).
//  2. A later migration may not give authenticated any write privilege
//     (MAINTAIN included) on them, give anon or PUBLIC anything at all, do
//     either through ALL TABLES IN SCHEMA public, hand a client role another
//     role, add a permissive INSERT/UPDATE/DELETE/ALL policy (no FOR = ALL),
//     or CREATE/RENAME a table to one of the two names (the default ACL
//     re-grants ALL to anon and authenticated). A GRANT run from EXECUTE '…'
//     counts. The one exemption is a rollback migration named
//     `<NNN>_watplclientwrite1_rollback.sql`.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex; JSX text is never read as a comment), SQL comments by one quote-
// and dollar-aware pass that pairs each $tag$ body with its own closing tag
// (sqlCode, tests/function-execute-guard.test.js). A floor, not a proof: a
// builder held in a variable, a `.from(<variable>)` or SQL built at runtime
// is invisible. Server code is not checked: service_role bypasses grants.
// champ-app is another repo and never names these tables (C89 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments, stripCommentsOfFile as codeOfFile } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const WA_TPL_WRITES_OFF_MIGRATION = 669
// Scanned from 631, not 669: migration numbers are reserved ahead of time and
// a lower number can merge later (663 is PR #1849, 631 the HELD #1774 when
// 669 was written). 631-668 hold nothing the detector flags (checked).
const SCAN_FROM = 631
const TABLES = ['whatsapp_templates', 'whatsapp_template_events']
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_watplclientwrite1_rollback\.sql$/
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

// ── client code ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function isClientCode(code) {
  return /^['"]use client['"]/.test(code.trimStart()) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
export const isClientFile = (text, file) => isClientCode(stripComments(text, file))

let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

const WRITE = /\.from\(\s*['"`](whatsapp_templates|whatsapp_template_events)['"`]\s*\)\s*\??\.\s*(insert|update|upsert|delete)\s*\(/g
const RPC = /\.rpc\(\s*['"`](increment_whatsapp_template_sent)['"`]/g
const READ = /\.from\(\s*['"`](whatsapp_templates|whatsapp_template_events)['"`]\s*\)\s*\??\.\s*select\s*\(/g

/** Every client write in already-stripped code, as "<table>.<op>" or "rpc:<name>". */
function writesIn(code) {
  return [
    ...[...code.matchAll(WRITE)].map((m) => `${m[1]}.${m[2]}`),
    ...[...code.matchAll(RPC)].map((m) => `rpc:${m[1]}`),
  ]
}
/** Every client write in `text` (comments excluded). */
export const waTemplateWrites = (text, file) => writesIn(stripComments(text, file))

// ── migrations ───────────────────────────────────────────────────────────

const ident = (s) => s.trim().replace(/"/g, '').toLowerCase()
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
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+(grant|admin|inherit|set)\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
const tableName = (s) => ident(s).replace(/^public\s*\.\s*/, '')
const NAMES = '(?:"?public"?\\s*\\.\\s*)?"?(whatsapp_templates|whatsapp_template_events)"?'

// One statement each: no part may cross a ';', and the role list also ends
// at a quote or a dollar sign (a GRANT run from EXECUTE '…'). ALTER DEFAULT
// PRIVILEGES statements are removed first: they change future tables only.
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_ON = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const GRANT_ROLE = /\bgrant\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const WRITE_PRIV = /\b(all|insert|update|delete|truncate|references|trigger|maintain)\b/i
const PRIV_WORDS = ['all', 'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'usage', 'execute', 'create', 'connect', 'temporary', 'temp']

/** Every statement in `sql` that would re-open one of the two tables to a client role. */
export function waTemplateReopeners(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_ON)) {
    const roles = rolesOf(to)
    const toAnon = roles.some((r) => r === 'anon' || r === 'public')
    const toAuthWrite = roles.includes('authenticated') && WRITE_PRIV.test(privs.replace(/\([^)]*\)/g, ' '))
    if (!toAnon && !toAuthWrite) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(t)) continue
    if (splitTop(t.replace(/^table\s+/i, '')).map(tableName).some((x) => TABLES.includes(x))) hits.push(stmt.trim())
  }
  for (const [stmt, granted, to] of code.matchAll(GRANT_ROLE)) {
    if (/\s+on\s+/i.test(stmt)) continue
    if (splitTop(granted).map(ident).some((r) => PRIV_WORDS.includes(r))) continue
    if (rolesOf(to).some((r) => ['anon', 'authenticated', 'public'].includes(r))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+policy\\s+(?:"[^"]+"|\\S+)\\s+on\\s+${NAMES}(?=[\\s;])([^;]*)`, 'gi'))) {
    const body = m[2]
    if (/\bas\s+restrictive\b/i.test(body)) continue
    const f = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)
    if (!f || f[1].toLowerCase() !== 'select') hits.push(m[0].trim())
  }
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAMES}(?=[\\s(;])`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(/\balter\s+table\s+[^;]*?\brename\s+to\s+"?(whatsapp_templates|whatsapp_template_events)"?(?=[\s;]|$)/gi)) hits.push(m[0].trim())
  return hits
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))

// The whole-repo scans are parse-bound; give them room on a slow runner.
describe('client code never writes WhatsApp templates or their events (WATPLCLIENTWRITE.1, mig 669)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police, and sees their reads (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/lib/whatsapp-api.js', 'shared/wa-template-send.js',
      'src/components/WhatsappTemplatesList.jsx', 'src/components/WATemplateEditor.jsx',
      'src/components/settings/integrations/WhatsAppIntegrationTab.jsx',
    ]))
    expect(names).not.toContain('src/app/api/whatsapp/templates/route.js')
    expect(names).not.toContain('src/lib/whatsapp-template-events.js')
    // the phone's picker read and the web list's realtime subscription are seen
    const phone = codeOfFile(path.join(ROOT, 'mobile/lib/whatsapp-api.js'))
    expect([...phone.matchAll(READ)].map((m) => m[1])).toEqual(['whatsapp_templates'])
    expect(codeOfFile(path.join(ROOT, 'src/components/WhatsappTemplatesList.jsx'))).toMatch(/table:\s*'whatsapp_templates'/)
  })

  it('no browser or phone file writes the two tables or calls the send counter', () => {
    const offenders = []
    for (const f of clientFiles()) for (const op of writesIn(codeOfFile(f))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'act through /api/whatsapp/templates* (mig 669 refuses client writes)').toEqual([])
  })

  it('the detector catches every write shape and ignores reads, realtime, storage and comments', () => {
    const bad = `
      await supabase.from('whatsapp_templates').update({ header_media_url: u }).eq('id', id)
      await supabase.from("whatsapp_templates")
        .insert({ name, status: 'APPROVED' })
      await db.from(\`whatsapp_template_events\`).upsert(row)
      await supabase.from('whatsapp_templates') . delete().eq('id', id)
      await supabase?.from('whatsapp_template_events')?.insert(row)
      await supabase.rpc('increment_whatsapp_template_sent', { p_template_id: id, p_delta: 1 })`
    expect(waTemplateWrites(bad)).toEqual([
      'whatsapp_templates.update', 'whatsapp_templates.insert', 'whatsapp_template_events.upsert',
      'whatsapp_templates.delete', 'whatsapp_template_events.insert', 'rpc:increment_whatsapp_template_sent',
    ])
    const ok = `
      let q = supabase.from('whatsapp_templates').select('id, name, status, components, header_media_url')
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_templates' }, cb)
      // await supabase.from('whatsapp_templates').update({ status: 'APPROVED' })
      /* await supabase.from('whatsapp_template_events').insert(row) */
      await supabase.storage.from('whatsapp-templates').uploadToSignedUrl(p, t, file)
      await fetch(\`/api/whatsapp/templates/\${id}\`, { method: 'PUT' })
      await supabase.from('whatsapp_templates_archive').delete()`
    expect(waTemplateWrites(ok)).toEqual([])
  })

  it("a '/*' in a string, a regex or JSX text hides nothing; a real JSX comment is a comment", () => {
    expect(waTemplateWrites("const a = 'image/*'\nsupabase.from('whatsapp_templates').update(p)\nconst b = '*/'\n"))
      .toEqual(['whatsapp_templates.update'])
    expect(waTemplateWrites("const r = /\\/*/\nsupabase.from('whatsapp_templates').delete()\nconst s = '*/'\n"))
      .toEqual(['whatsapp_templates.delete'])
    expect(waTemplateWrites("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.from('whatsapp_templates').update(p)}<p>end */</p></div>\n}\n"))
      .toEqual(['whatsapp_templates.update'])
    expect(waTemplateWrites("'use client'\nexport default function P() {\n  return <div>\n    {/* supabase.from('whatsapp_templates').update(p) */}\n  </div>\n}\n"))
      .toEqual([])
  })

  it('finds every client-bound file: a comment header, createAuthClient, the anon key; not a comment', () => {
    expect(isClientFile("/* header */\n'use client'\nexport const x = 1\n")).toBe(true)
    expect(isClientFile("// line one\n//\n\"use client\"\nexport const x = 1\n")).toBe(true)
    expect(isClientFile("import { createAuthClient } from '@/lib/auth'\nconst db = await createAuthClient()\n")).toBe(true)
    expect(isClientFile("const c = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)\n")).toBe(true)
    expect(isClientFile("// 'use client'\nimport { createServerClient } from '@/lib/supabase'\n")).toBe(false)
    expect(isClientFile("/* was createBrowserClient() before */\nexport const y = 1\n")).toBe(false)
  })
})

describe('later migrations keep the two tables closed to clients (mig 669)', () => {
  it('mig 669 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${WA_TPL_WRITES_OFF_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM && !ROLLBACK_FILE.test(f))
  it.each(later)('%s: no client write, no anon grant, no permissive write policy on the two tables', (file) => {
    expect(waTemplateReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} re-opens whatsapp_templates/whatsapp_template_events to a client role (mig 669). Write through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form', () => {
    const bad = [
      'GRANT INSERT ON public.whatsapp_templates TO authenticated;',
      'grant update on table whatsapp_template_events to anon, authenticated;',
      'GRANT ALL ON "public"."whatsapp_templates" TO PUBLIC;',
      'GRANT UPDATE (header_media_url) ON public.whatsapp_templates TO authenticated;',
      'GRANT MAINTAIN ON public.whatsapp_templates TO authenticated;',
      'GRANT SELECT ON public.whatsapp_templates TO anon;',
      'GRANT SELECT (id, name) ON public.whatsapp_template_events TO PUBLIC;',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      'GRANT DELETE ON public.whatsapp_messages, public.whatsapp_templates TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.whatsapp_templates TO authenticated'; END $$;`,
      `DO $x$ BEGIN EXECUTE 'GRANT INSERT ON public.whatsapp_template_events TO authenticated'; END $x$;`,
      'CREATE POLICY wa_tmpl_update ON public.whatsapp_templates FOR UPDATE TO authenticated USING (true);',
      'create policy "x" on whatsapp_templates to authenticated using (true);',
      'CREATE POLICY e ON public.whatsapp_template_events FOR ALL TO authenticated USING (true);',
      'CREATE POLICY wa_tmpl_insert ON public.whatsapp_templates FOR INSERT WITH CHECK (true);',
      'GRANT tpl_writer TO authenticated;',
      'grant "some_role" to anon, authenticated;',
      'CREATE TABLE IF NOT EXISTS public.whatsapp_templates (id uuid);',
      'ALTER TABLE public.whatsapp_templates_new RENAME TO whatsapp_templates;',
      "SELECT '/*';\nGRANT UPDATE ON public.whatsapp_templates TO authenticated;\nSELECT '*/';",
      "-- a note with /* in it\nGRANT UPDATE ON public.whatsapp_templates TO authenticated;\n-- */",
      "COMMENT ON TABLE x IS $c$ it's -- /* $c$;\nGRANT UPDATE ON public.whatsapp_templates TO authenticated;\nSELECT '*/';",
      // a '/*' inside a dollar body ends with that body: only $tag$ pairing sees the GRANT
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT UPDATE ON public.whatsapp_templates TO authenticated;\nSELECT $d$ */ $d$;",
    ]
    for (const sql of bad) expect(waTemplateReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT SELECT ON public.whatsapp_templates TO authenticated;',
      'GRANT SELECT (id, name, components) ON public.whatsapp_templates TO authenticated;',
      'GRANT ALL ON public.whatsapp_templates TO service_role;',
      'GRANT UPDATE ON public.whatsapp_conversations TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.increment_whatsapp_template_sent(uuid, integer) TO service_role;',
      'REVOKE ALL ON public.whatsapp_templates, public.whatsapp_template_events FROM anon, PUBLIC;',
      'CREATE POLICY wa_tmpl_select ON public.whatsapp_templates FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY d ON public.whatsapp_templates AS RESTRICTIVE FOR ALL TO anon USING (false);',
      'CREATE POLICY p ON public.whatsapp_templates_archive FOR ALL TO authenticated USING (true);',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'CREATE TABLE public.whatsapp_template_drafts (id uuid);',
      'ALTER TABLE public.whatsapp_templates RENAME COLUMN name TO template_name;',
      '-- rollback: GRANT INSERT ON public.whatsapp_templates TO authenticated;',
      '/* GRANT ALL ON public.whatsapp_templates TO anon; */',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
         -- GRANT UPDATE ON public.whatsapp_templates TO authenticated;
       END $$;`,
      'ALTER TABLE public.sequence_steps ADD COLUMN whatsapp_template_id uuid REFERENCES public.whatsapp_templates(id);',
    ]
    for (const sql of ok) expect(waTemplateReopeners(sql), sql).toEqual([])
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('670_watplclientwrite1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('670_whatsapp_templates_regrant.sql')).toBe(false)
  })
})
