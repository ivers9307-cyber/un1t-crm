// CBRCLIENTCLOSED.1 guard (mig 742). No client role (anon, authenticated,
// PUBLIC) holds any privilege on public.class_booking_requests, and it has no
// policy (RLS on). Mig 335 called it service-role only but left Supabase's
// default grants; mig 677 trimmed them to authenticated arwd, which RLS alone
// fenced. Pinned here:
//
//  1. Browser and phone code never touches class_booking_requests: no
//     .from('class_booking_requests') (read or write), no embed of it in
//     another table's select string, no realtime subscription, no raw
//     /rest/v1/class_booking_requests URL. Client-bound code = shared/,
//     mobile/, desktop/, and every src/ file that is 'use client' (after any
//     header comment), names createBrowserClient, calls createAuthClient() or
//     holds the anon key. Any of these is a 42501 after 742. Book through
//     /api/public/class-booking and /api/public/class-booking-payments/[id];
//     staff act on the review card through /api/agent/membership-requests/[id].
//  2. A later migration may not give anon, authenticated or PUBLIC any
//     privilege on class_booking_requests (reads included), do it through ALL
//     TABLES IN SCHEMA public, hand a client role another role, add a
//     permissive policy of any command to it, disable RLS on it (any ALTER
//     TABLE form), make a client role its OWNER, or CREATE/RENAME a table to
//     its name. A GRANT run from EXECUTE '…' counts. The one exemption is a
//     rollback migration named `<NNN>_cbrclientclosed1_rollback.sql`.
//
// The detectors are tests/cars-company-settings-client-closed-guard.test.js's
// (mig 674), as tests/org-settings-client-closed-guard.test.js points them at
// one table: JS comments blanked from the TypeScript parser's comment ranges,
// SQL comments by the quote- and dollar-aware sqlCode pass. A floor, not a
// proof: a table name held in a variable, a `.from(<variable>)` or SQL built
// at runtime is invisible. Server code is not checked: service_role bypasses
// grants. champ-app was not checked (mig 742's header).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments, stripCommentsOfFile as codeOfFile } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLOSED_MIGRATION = 742
// Scanned from 677, not 742: migration numbers are reserved ahead of time and
// a lower number can merge later. 677 is where the default ACL closed; 677-741
// hold nothing the detector flags (checked).
const SCAN_FROM = 677
const TABLES = ['class_booking_requests']
const T = TABLES.join('|')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_cbrclientclosed1_rollback\.sql$/
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

let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile')), ...walk(path.join(ROOT, 'desktop'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

// Any .from('class_booking_requests'), with the verb that follows it when there is one.
const FROM = new RegExp(`\\.from\\(\\s*['"\`](${T})['"\`]\\s*\\)(?:\\s*\\??\\.\\s*(\\w+)\\s*\\()?`, 'g')
// A PostgREST embed inside another table's select string: 'id, class_booking_requests(status)'
// or 'class_booking_requests!fk(*)'. A '…' or "…" string ends at its line; a backtick
// template may span lines (the house style is a multi-line template select).
const EMBED = new RegExp(`(?:['"][^'"\\n]*?|\`[^\`]*?)\\b(${T})\\s*(?:!\\s*\\w+\\s*)?\\(`, 'g')
const REALTIME = new RegExp(`\\btable\\s*:\\s*['"\`](${T})['"\`]`, 'g')
const REST = new RegExp(`/rest/v1/(${T})\\b`, 'g')

/** Every forbidden client use in already-stripped code, as "<table>.<op>". */
function usesIn(code) {
  return [
    ...[...code.matchAll(FROM)].map((m) => `${m[1]}.${m[2] || 'from'}`),
    ...[...code.matchAll(EMBED)].map((m) => `${m[1]}.embed`),
    ...[...code.matchAll(REALTIME)].map((m) => `${m[1]}.realtime`),
    ...[...code.matchAll(REST)].map((m) => `${m[1]}.rest`),
  ]
}
/** Every forbidden client use in `text` (comments excluded). */
export const cbrClientUses = (text, file) => usesIn(stripComments(text, file))

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
const NAMES = `(?:"?public"?\\s*\\.\\s*)?"?(${T})"?`

// One statement each: no part may cross a ';', and the role list also ends
// at a quote or a dollar sign (a GRANT run from EXECUTE '…'). ALTER DEFAULT
// PRIVILEGES statements are removed first: they change future tables only.
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_ON = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const GRANT_ROLE = /\bgrant\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const PRIV_WORDS = ['all', 'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'usage', 'execute', 'create', 'connect', 'temporary', 'temp']

/** Every statement in `sql` that would re-open class_booking_requests to a client role. */
export function cbrReopeners(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, , target, to] of code.matchAll(GRANT_ON)) {
    if (!rolesOf(to).some((r) => ['anon', 'authenticated', 'public'].includes(r))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    // Any client privilege through ALL TABLES reaches class_booking_requests (closed to reads too).
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
    if (!/\bas\s+restrictive\b/i.test(m[2])) hits.push(m[0].trim())
  }
  // ALTER TABLE [IF EXISTS] [ONLY] <name> …: DISABLE RLS anywhere in a multi-action
  // statement, or the table handed to a client role (an owner bypasses its grants and RLS).
  const ALTER_ONE = `\\balter\\s+table\\s+(?:(?:only|if\\s+exists)\\s+)*${NAMES}(?=[\\s;])[^;]*?`
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bdisable\\s+row\\s+level\\s+security\\b`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bowner\\s+to\\s+"?(anon|authenticated|public)"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAMES}(?=[\\s(;])`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\balter\\s+table\\s+[^;]*?\\brename\\s+to\\s+"?(${T})"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  return hits
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))

// The whole-repo scans are parse-bound; give them room on a slow runner.
describe('client code never touches class_booking_requests (CBRCLIENTCLOSED.1, mig 742)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      // Names the table in a comment only: proves comments are not read as uses.
      'src/components/landing-page/ClassFunnelCheckout.jsx',
      'mobile/lib/brand.js', 'shared/brand-name.js',
    ]))
    for (const server of ['src/lib/class-booking-processor.js', 'src/lib/class-booking-queue.js',
      'src/lib/class-booking-payments.js', 'src/app/api/public/class-booking/route.js',
      'src/app/api/public/class-booking-payments/[id]/route.js', 'src/app/api/agent/membership-requests/[id]/route.js',
      'src/app/api/cron/process-class-bookings/route.js', 'src/app/api/webhooks/qstash/class-bookings/route.js',
      'src/lib/agent/trial-grant.js', 'src/lib/whatsapp-flow/completion.js']) {
      expect(names).not.toContain(server)
    }
  })

  it('no browser, phone or desktop file touches class_booking_requests', () => {
    const offenders = []
    for (const f of clientFiles()) for (const op of usesIn(codeOfFile(f))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'book through /api/public/class-booking*, act on the review card through /api/agent/membership-requests/[id] (mig 742 refuses every client read and write)').toEqual([])
  })

  it('the detector catches every use and ignores routes, comments and look-alikes', () => {
    const bad = `
      await supabase.from('class_booking_requests').select('status, payment_status')
      await supabase.from("class_booking_requests")
        .update({ status: 'queued' }).eq('id', id)
      await db.from(\`class_booking_requests\`).upsert(row)
      await supabase?.from('class_booking_requests')?.insert({ contact_id: id })
      await supabase.from('class_booking_requests') . delete().eq('id', id)
      const q = supabase.from('class_booking_requests')
      await supabase.from('contacts').select('id, class_booking_requests(status, glofox_event_id)')
      await supabase.from('contacts').select(\`id, class_booking_requests!class_booking_requests_contact_id_fkey(*)\`)
      await supabase
        .from('agent_membership_requests')
        .select(\`
          id, kind,
          request:class_booking_requests(payment_status)
        \`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'class_booking_requests' }, cb)
      await fetch(\`\${SUPABASE_URL}/rest/v1/class_booking_requests?select=*\`)`
    expect(cbrClientUses(bad)).toEqual([
      'class_booking_requests.select', 'class_booking_requests.update', 'class_booking_requests.upsert',
      'class_booking_requests.insert', 'class_booking_requests.delete', 'class_booking_requests.from',
      'class_booking_requests.embed', 'class_booking_requests.embed', 'class_booking_requests.embed',
      'class_booking_requests.realtime', 'class_booking_requests.rest',
    ])
    const ok = `
      const res = await fetch('/api/public/class-booking', { method: 'POST', body })
      await fetch(\`/api/public/class-booking-payments/\${id}\`)
      await fetch(\`/api/agent/membership-requests/\${id}\`, { method: 'PATCH', body })
      // await supabase.from('class_booking_requests').select('*')
      /* supabase.from('class_booking_requests').update(x) */
      await supabase.from('class_booking_requests_archive').select('*')
      await supabase.from('class_bookings').select('*')
      const [classBookingRequests, setRequests] = useState([])
      const label = 'class_booking_requests is server-only'`
    expect(cbrClientUses(ok)).toEqual([])
  })

  it("a '/*' in a string, a regex or JSX text hides nothing; a real JSX comment is a comment", () => {
    expect(cbrClientUses("const a = 'image/*'\nsupabase.from('class_booking_requests').update(p)\nconst b = '*/'\n")).toEqual(['class_booking_requests.update'])
    expect(cbrClientUses("const r = /\\/*/\nsupabase.from('class_booking_requests').delete()\nconst s = '*/'\n")).toEqual(['class_booking_requests.delete'])
    expect(cbrClientUses("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.from('class_booking_requests').insert(p)}<p>end */</p></div>\n}\n"))
      .toEqual(['class_booking_requests.insert'])
    expect(cbrClientUses("'use client'\nexport default function P() {\n  return <div>\n    {/* supabase.from('class_booking_requests').select('*') */}\n  </div>\n}\n"))
      .toEqual([])
  })
})

describe('later migrations keep class_booking_requests closed to clients (mig 742)', () => {
  it('mig 742 is present and revokes from all three client roles', () => {
    const file = migrationFiles().find((f) => f.startsWith(`${CLOSED_MIGRATION}_`))
    expect(file).toBeTruthy()
    const code = sqlCode(readFileSync(path.join(MIGRATIONS, file), 'utf8'))
    expect(code).toMatch(/\brevoke\s+all\s+on\s+public\.class_booking_requests\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i)
    // The self-check reads the catalog, not the file (mig 153's lesson).
    expect(code).toMatch(/information_schema\.table_privileges/)
    expect(code).toMatch(/information_schema\.column_privileges/)
    expect(code).toMatch(/has_table_privilege\(v_role, v_rel, v_priv\)/)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM && !ROLLBACK_FILE.test(f))
  it('scans the migrations it is meant to police (not vacuous)', () => {
    expect(later).toEqual(expect.arrayContaining(['677_public_tables_default_acl_closed.sql',
      `${CLOSED_MIGRATION}_class_booking_requests_client_closed.sql`]))
  })

  it.each(later)('%s: no client privilege, no client role, no permissive policy, RLS kept on class_booking_requests', (file) => {
    expect(cbrReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} re-opens class_booking_requests to a client role (mig 742). Go through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form', () => {
    const bad = [
      'GRANT SELECT ON public.class_booking_requests TO authenticated;',
      'grant update on table class_booking_requests to anon, authenticated;',
      'GRANT ALL ON "public"."class_booking_requests" TO PUBLIC;',
      'GRANT SELECT (id, status) ON public.class_booking_requests TO authenticated;',
      'GRANT UPDATE (status) ON public.class_booking_requests TO authenticated;',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_booking_requests TO authenticated;',
      'GRANT MAINTAIN ON public.class_booking_requests TO authenticated;',
      'GRANT REFERENCES ON public.class_booking_requests TO anon;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      'GRANT DELETE ON public.orders, public.class_booking_requests TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.class_booking_requests TO authenticated'; END $$;`,
      `DO $x$ BEGIN EXECUTE 'GRANT UPDATE ON public.class_booking_requests TO authenticated'; END $x$;`,
      `CREATE POLICY cbr_select ON public.class_booking_requests FOR SELECT TO authenticated
         USING (private.auth_is_in_location(location_id));`,
      'create policy "x" on class_booking_requests to authenticated using (true);',
      'CREATE POLICY n ON public.class_booking_requests FOR INSERT TO authenticated WITH CHECK (false);',
      'ALTER TABLE public.class_booking_requests DISABLE ROW LEVEL SECURITY;',
      'alter table only class_booking_requests disable row level security;',
      'ALTER TABLE IF EXISTS ONLY public.class_booking_requests DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.class_booking_requests ADD COLUMN x int, DISABLE ROW LEVEL SECURITY;',
      'alter table "public"."class_booking_requests"\n  alter column status set not null,\n  disable row level security;',
      'ALTER TABLE public.class_booking_requests OWNER TO authenticated;',
      'ALTER TABLE public.class_booking_requests OWNER TO "anon";',
      'GRANT booking_queue_writer TO authenticated;',
      'CREATE TABLE IF NOT EXISTS public.class_booking_requests (id uuid);',
      'CREATE TABLE public.class_booking_requests (id uuid);',
      'ALTER TABLE public.class_booking_requests_v2 RENAME TO class_booking_requests;',
      "SELECT '/*';\nGRANT SELECT ON public.class_booking_requests TO authenticated;\nSELECT '*/';",
      "-- a note with /* in it\nGRANT UPDATE ON public.class_booking_requests TO authenticated;\n-- */",
      "COMMENT ON TABLE x IS $c$ it's -- /* $c$;\nGRANT SELECT ON public.class_booking_requests TO authenticated;\nSELECT '*/';",
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT SELECT ON public.class_booking_requests TO authenticated;\nSELECT $d$ */ $d$;",
    ]
    for (const sql of bad) expect(cbrReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT ALL ON public.class_booking_requests TO service_role;',
      'GRANT SELECT ON public.class_booking_requests_archive TO authenticated;',
      'GRANT SELECT ON public.class_bookings TO authenticated;',
      'GRANT UPDATE ON public.orders TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;',
      'REVOKE ALL ON public.class_booking_requests FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY d ON public.class_booking_requests AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);',
      'CREATE POLICY p ON public.class_bookings FOR ALL TO authenticated USING (true);',
      'ALTER TABLE public.class_booking_requests ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.class_booking_requests ADD COLUMN IF NOT EXISTS source text;',
      'ALTER TABLE public.class_bookings DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.class_booking_requests OWNER TO postgres;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'CREATE TABLE public.class_booking_request_events (id uuid);',
      'ALTER TABLE public.class_booking_requests RENAME COLUMN status TO state;',
      `CREATE OR REPLACE TRIGGER trg_cbr_updated_at BEFORE UPDATE ON public.class_booking_requests
         FOR EACH ROW EXECUTE FUNCTION update_updated_at();`,
      "COMMENT ON TABLE public.class_booking_requests IS 'Service role only (mig 742).';",
      '-- rollback: GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_booking_requests TO authenticated;',
      '/* GRANT ALL ON public.class_booking_requests TO anon; */',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
         -- GRANT UPDATE ON public.class_booking_requests TO authenticated;
       END $$;`,
    ]
    for (const sql of ok) expect(cbrReopeners(sql), sql).toEqual([])
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('743_cbrclientclosed1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('743_class_booking_requests_regrant.sql')).toBe(false)
    expect(ROLLBACK_FILE.test('743_orgsetclientwrite1_rollback.sql')).toBe(false)
  })
})
