// ORGSETCLIENTWRITE.1 guard (mig 730). No client role (anon, authenticated,
// PUBLIC) holds any privilege on public.org_settings, and it has no policy
// (RLS on). Pinned here:
//
//  1. Browser and phone code never touches org_settings: no
//     .from('org_settings') (read or write), no embed of it in another
//     table's select string, no realtime subscription, no raw
//     /rest/v1/org_settings URL. Client-bound code = shared/, mobile/,
//     desktop/, and every src/ file that is 'use client' (after any header
//     comment), names createBrowserClient, calls createAuthClient() or holds
//     the anon key. Any of these is a 42501 after 730. Act through
//     /api/settings/org-branding, /api/settings/org-usage or
//     /api/settings/customer-agent/org, which need a master or an
//     organisation admin (resolveAdminOrgId) and validate the body; read the
//     brand through /api/public/branding.
//  2. A later migration may not give anon, authenticated or PUBLIC any
//     privilege on org_settings (reads included), do it through ALL TABLES
//     IN SCHEMA public, hand a client role another role, add a permissive
//     policy of any command to it, disable RLS on it (any ALTER TABLE form),
//     make a client role its OWNER, or CREATE/RENAME a table to its name (the
//     default ACL used to re-grant ALL to anon and authenticated). A GRANT
//     run from EXECUTE '…' counts. The one exemption is a rollback migration
//     named `<NNN>_orgsetclientwrite1_rollback.sql`.
//
// The detectors are tests/cars-company-settings-client-closed-guard.test.js's
// (mig 674), pointed at one table: JS comments blanked from the TypeScript
// parser's comment ranges, SQL comments by the quote- and dollar-aware
// sqlCode pass. A floor, not a proof: a table name held in a variable, a
// `.from(<variable>)` or SQL built at runtime is invisible. Server code is not
// checked: service_role bypasses grants. No other repo on this project
// touches org_settings with a client session (mig 730's header).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments, stripCommentsOfFile as codeOfFile } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLOSED_MIGRATION = 730
// Scanned from 700, not 730: migration numbers are reserved ahead of time and
// a lower number can merge later (728 and 729 were open branches when 730 was
// written). 700-729 hold nothing the detector flags (checked).
const SCAN_FROM = 700
const TABLES = ['org_settings']
const T = TABLES.join('|')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_orgsetclientwrite1_rollback\.sql$/
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

// Any .from('org_settings'), with the verb that follows it when there is one.
const FROM = new RegExp(`\\.from\\(\\s*['"\`](${T})['"\`]\\s*\\)(?:\\s*\\??\\.\\s*(\\w+)\\s*\\()?`, 'g')
// A PostgREST embed inside another table's select string: 'id, org_settings(logo_url)'
// or 'org_settings!fk(*)'. A '…' or "…" string ends at its line; a backtick
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
export const orgSettingsClientUses = (text, file) => usesIn(stripComments(text, file))

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

/** Every statement in `sql` that would re-open org_settings to a client role. */
export function orgSettingsReopeners(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, , target, to] of code.matchAll(GRANT_ON)) {
    if (!rolesOf(to).some((r) => ['anon', 'authenticated', 'public'].includes(r))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    // Any client privilege through ALL TABLES reaches org_settings (closed to reads too).
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
describe('client code never touches org_settings (ORGSETCLIENTWRITE.1, mig 730)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/lib/brand.js', 'shared/brand-name.js', 'src/components/OrgBrandingSettings.jsx',
      'src/app/tv/live/[token]/LiveTvClient.jsx', 'src/app/tv/live/[token]/challenges/ChallengeTvClient.jsx',
    ]))
    for (const server of ['src/app/api/settings/org-branding/route.js', 'src/app/api/settings/org-usage/route.js',
      'src/app/api/cron/usage-rollup/route.js', 'src/app/api/public/branding/route.js', 'src/lib/location-branding.js',
      'src/lib/usage-caps.js', 'src/lib/tenant-privacy.js', 'src/lib/ops-alerts.js']) {
      expect(names).not.toContain(server)
    }
  })

  it('no browser, phone or desktop file touches org_settings', () => {
    const offenders = []
    for (const f of clientFiles()) for (const op of usesIn(codeOfFile(f))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'act through /api/settings/org-branding, /api/settings/org-usage, /api/settings/customer-agent/org or /api/public/branding (mig 730 refuses every client read and write)').toEqual([])
  })

  it('the detector catches every use and ignores routes, comments and look-alikes', () => {
    const bad = `
      await supabase.from('org_settings').select('ai_hard_cap_cents')
      await supabase.from("org_settings")
        .update({ ai_hard_cap_cents: null }).eq('organization_id', orgId)
      await db.from(\`org_settings\`).upsert(row)
      await supabase?.from('org_settings')?.insert({ organization_id: orgId })
      await supabase.from('org_settings') . delete().eq('organization_id', orgId)
      const q = supabase.from('org_settings')
      await supabase.from('organizations').select('id, org_settings(logo_url, legal_entity_name)')
      await supabase.from('organizations').select(\`id, org_settings!org_settings_organization_id_fkey(*)\`)
      await supabase
        .from('organizations')
        .select(\`
          id, name,
          settings:org_settings(ops_alert_emails)
        \`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'org_settings' }, cb)
      await fetch(\`\${SUPABASE_URL}/rest/v1/org_settings?select=*\`)`
    expect(orgSettingsClientUses(bad)).toEqual([
      'org_settings.select', 'org_settings.update', 'org_settings.upsert', 'org_settings.insert',
      'org_settings.delete', 'org_settings.from',
      'org_settings.embed', 'org_settings.embed', 'org_settings.embed', 'org_settings.realtime', 'org_settings.rest',
    ])
    const ok = `
      const res = await fetch(\`/api/settings/org-branding?organization_id=\${orgId}\`)
      await fetch('/api/settings/org-branding', { method: 'PUT', body })
      await fetch('/api/settings/org-usage', { method: 'PUT', body })
      const brand = await api('/api/public/branding?location_id=' + id)
      // await supabase.from('org_settings').select('*')
      /* supabase.from('org_settings').update(x) */
      await supabase.from('org_settings_archive').select('*')
      await supabase.from('chooser_settings').select('*')
      const [orgSettings, setOrgSettings] = useState(null)
      const label = 'org_settings is server-only'`
    expect(orgSettingsClientUses(ok)).toEqual([])
  })

  it("a '/*' in a string, a regex or JSX text hides nothing; a real JSX comment is a comment", () => {
    expect(orgSettingsClientUses("const a = 'image/*'\nsupabase.from('org_settings').update(p)\nconst b = '*/'\n")).toEqual(['org_settings.update'])
    expect(orgSettingsClientUses("const r = /\\/*/\nsupabase.from('org_settings').delete()\nconst s = '*/'\n")).toEqual(['org_settings.delete'])
    expect(orgSettingsClientUses("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.from('org_settings').insert(p)}<p>end */</p></div>\n}\n"))
      .toEqual(['org_settings.insert'])
    expect(orgSettingsClientUses("'use client'\nexport default function P() {\n  return <div>\n    {/* supabase.from('org_settings').select('*') */}\n  </div>\n}\n"))
      .toEqual([])
  })
})

describe('later migrations keep org_settings closed to clients (mig 730)', () => {
  it('mig 730 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${CLOSED_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM && !ROLLBACK_FILE.test(f))
  it.each(later)('%s: no client privilege, no client role, no permissive policy, RLS kept on org_settings', (file) => {
    expect(orgSettingsReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} re-opens org_settings to a client role (mig 730). Go through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form', () => {
    const bad = [
      'GRANT SELECT ON public.org_settings TO authenticated;',
      'grant update on table org_settings to anon, authenticated;',
      'GRANT ALL ON "public"."org_settings" TO PUBLIC;',
      'GRANT SELECT (logo_url, company_name) ON public.org_settings TO authenticated;',
      'GRANT UPDATE (ai_hard_cap_cents) ON public.org_settings TO authenticated;',
      'GRANT INSERT, UPDATE, DELETE ON public.org_settings TO authenticated;',
      'GRANT MAINTAIN ON public.org_settings TO authenticated;',
      'GRANT REFERENCES ON public.org_settings TO anon;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
      'GRANT DELETE ON public.orders, public.org_settings TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.org_settings TO authenticated'; END $$;`,
      `DO $x$ BEGIN EXECUTE 'GRANT UPDATE ON public.org_settings TO authenticated'; END $x$;`,
      `CREATE POLICY org_settings_upd ON public.org_settings FOR UPDATE TO authenticated
         USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());`,
      'create policy "x" on org_settings to authenticated using (true);',
      'CREATE POLICY org_settings_select ON public.org_settings FOR SELECT TO authenticated USING (private.auth_is_in_organization(organization_id));',
      'CREATE POLICY n ON public.org_settings FOR INSERT TO authenticated WITH CHECK (false);',
      'ALTER TABLE public.org_settings DISABLE ROW LEVEL SECURITY;',
      'alter table only org_settings disable row level security;',
      'ALTER TABLE IF EXISTS ONLY public.org_settings DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.org_settings ADD COLUMN x int, DISABLE ROW LEVEL SECURITY;',
      'alter table "public"."org_settings"\n  alter column short_name set not null,\n  disable row level security;',
      'ALTER TABLE public.org_settings OWNER TO authenticated;',
      'ALTER TABLE public.org_settings OWNER TO "anon";',
      'GRANT org_settings_writer TO authenticated;',
      'CREATE TABLE IF NOT EXISTS public.org_settings (organization_id uuid);',
      'CREATE TABLE public.org_settings (organization_id uuid);',
      'ALTER TABLE public.org_settings_v2 RENAME TO org_settings;',
      "SELECT '/*';\nGRANT SELECT ON public.org_settings TO authenticated;\nSELECT '*/';",
      "-- a note with /* in it\nGRANT UPDATE ON public.org_settings TO authenticated;\n-- */",
      "COMMENT ON TABLE x IS $c$ it's -- /* $c$;\nGRANT SELECT ON public.org_settings TO authenticated;\nSELECT '*/';",
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT SELECT ON public.org_settings TO authenticated;\nSELECT $d$ */ $d$;",
    ]
    for (const sql of bad) expect(orgSettingsReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT ALL ON public.org_settings TO service_role;',
      'GRANT SELECT ON public.org_settings_archive TO authenticated;',
      'GRANT SELECT ON public.chooser_settings TO authenticated;',
      'GRANT UPDATE ON public.orders TO authenticated;',
      'GRANT EXECUTE ON FUNCTION private.org_settings_customer_agent_fence() TO service_role;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;',
      'REVOKE ALL ON public.org_settings FROM anon, authenticated, PUBLIC;',
      'REVOKE EXECUTE ON FUNCTION private.org_settings_customer_agent_fence() FROM PUBLIC, anon, authenticated;',
      'CREATE POLICY d ON public.org_settings AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);',
      'CREATE POLICY p ON public.chooser_settings FOR ALL TO authenticated USING (true);',
      'CREATE POLICY p ON public.org_settings_archive FOR ALL TO authenticated USING (true);',
      'ALTER TABLE public.org_settings ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS customer_agent jsonb;',
      'ALTER TABLE public.chooser_settings DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.org_settings OWNER TO postgres;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'CREATE TABLE public.org_settings_history (id uuid);',
      'ALTER TABLE public.org_settings RENAME COLUMN short_name TO wordmark;',
      `CREATE TRIGGER org_settings_customer_agent_fence BEFORE INSERT OR UPDATE ON public.org_settings
         FOR EACH ROW EXECUTE FUNCTION private.org_settings_customer_agent_fence();`,
      "COMMENT ON TABLE public.org_settings IS 'Service role only (mig 730).';",
      '-- rollback: GRANT SELECT ON public.org_settings TO authenticated;',
      '/* GRANT ALL ON public.org_settings TO anon; */',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
         -- GRANT UPDATE ON public.org_settings TO authenticated;
       END $$;`,
    ]
    for (const sql of ok) expect(orgSettingsReopeners(sql), sql).toEqual([])
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('731_orgsetclientwrite1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('731_org_settings_regrant.sql')).toBe(false)
    expect(ROLLBACK_FILE.test('731_carsclientwrite1_rollback.sql')).toBe(false)
  })
})
