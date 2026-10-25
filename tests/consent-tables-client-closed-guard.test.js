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
//  2. No migration (EVERY file, whatever its number: numbers do not apply in
//     order, and C50's 652 applies after 662; applied history is allowlisted
//     below with reasons) may give a client role (anon, authenticated, PUBLIC)
//     ANY privilege (SELECT included) on them, by name, through ALL TABLES IN
//     SCHEMA public, or through ALTER DEFAULT PRIVILEGES … ON TABLES; add a
//     permissive policy to the three tables; or create a view named
//     contact_location_audience, or over a consent relation, unless it is
//     security_invoker AND the same file then REVOKEs ALL on it from anon,
//     authenticated and PUBLIC (a created view gets the schema's default
//     privileges, and without security_invoker it reads as its owner). The
//     C50 / mig 652 shape passes: that REVOKE, then the ACL re-issued from
//     the catalog. ALTER VIEW … SET/RESET turning security_invoker off fails.
//
// A floor, not a proof: a builder held in a variable, or SQL built at runtime,
// is invisible. Server code is not checked: service_role bypasses grants.
// champ-app is another repo and never names these relations (C68 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONSENT_CLOSED_MIGRATION = 662
const TABLES = ['contact_preferences', 'contact_location_preferences', 'consent_log']
const RELS = [...TABLES, 'contact_location_audience']
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')

const FROM = /\.from\(\s*['"`](contact_preferences|contact_location_preferences|consent_log|contact_location_audience)['"`]\s*\)/g
// An embed inside a select string: 'id, contact_preferences(unsubscribe_token)',
// 'prefs:contact_preferences!inner(…)'. Anchored at a quote so plain prose is not matched.
const EMBED = /['"`][^'"`]*?\b(contact_preferences|contact_location_preferences|consent_log|contact_location_audience)\s*(?:!\s*\w+\s*)?\(/g
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
// Lower-case, unquoted, and `public . x` / `"public"."x"` folded to `public.x`.
const ident = (s) => s.trim().replace(/["']/g, '').replace(/\s*\.\s*/g, '.').toLowerCase()
const bare = (s) => ident(s).replace(/^public\./, '')
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

// Applied history that opened these relations before 662 closed them. All five
// are applied on prod and superseded; migrations are forward-only, so none
// runs again. `hits` is exact: a new reopener added to one of them still fails.
const REOPENER_ALLOWLIST = {
  '005_email_marketing.sql': { hits: 2, why: 'the original "Authenticated full access" FOR ALL USING (true) policies on contact_preferences and consent_log; replaced by 014, and 660/662 leave no policy' },
  '014_rls_location_scoping.sql': { hits: 2, why: 'the location-scoped FOR ALL policies on contact_preferences and consent_log; mig 660 dropped both' },
  '487_contact_location_preferences.sql': { hits: 1, why: 'contact_location_preferences_location_scoped FOR ALL; mig 660 dropped it' },
  '491_contact_location_audience_view.sql': { hits: 1, why: 'creates contact_location_audience WITH (security_invoker = on) and leaves the default client privileges on it; mig 662 revokes them' },
  '660_consent_tables_client_writes_off.sql': { hits: 3, why: 'the three <table>_select FOR SELECT policies 660 creates; mig 662 drops them (and refuses to run before 660)' },
}

const CONSENT_NAME = /\b(contact_preferences|contact_location_preferences|consent_log|contact_location_audience)\b/i
const INVOKER_ON = /\bsecurity_invoker\b(?!\s*=\s*(?:off|false|0|no)\b)(?:\s*=\s*(?:on|true|1|yes)\b)?/i

/** Every statement in `sql` that would give a client role access to a consent relation again. */
export function consentReopeners(sql) {
  const code = sqlCode(sql)
  const hits = []
  for (const m of code.matchAll(/\bgrant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:;|'|$)/gi)) {
    const [stmt, , target, to] = m
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT_ROLES.includes(g))) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|tables|all\s)/i.test(t)) continue
    const targets = splitTop(t.replace(/^table\s+/i, '')).map(bare)
    if (targets.some((x) => RELS.includes(x))) hits.push(stmt.trim())
  }
  // Default privileges hand every table or view created afterwards to the
  // grantee (prod's own default is why a re-created view reopens itself).
  for (const m of code.matchAll(/\balter\s+default\s+privileges\b[^;]*?\bgrant\s+[^;]*?\bon\s+tables\s+to\s+([^;]+?)(?:\s+with\s+grant\s+option)?\s*(?:;|$)/gi)) {
    if (splitTop(m[1]).map(ident).some((g) => CLIENT_ROLES.includes(g))) hits.push(m[0].trim())
  }
  for (const m of code.matchAll(/\bcreate\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+(?:"?public"?\s*\.\s*)?"?(contact_preferences|contact_location_preferences|consent_log)"?(?=[\s;])([\s\S]*?)(?:;|$)/gi)) {
    if (/\bas\s+restrictive\b/i.test(m[2])) continue
    hits.push(m[0].trim())
  }
  // A view named contact_location_audience, or one that reads a consent
  // relation: created, it gets the schema's default privileges (anon and
  // authenticated arwdDxtm on prod), and without security_invoker it reads as
  // its owner (a DEFINER view over the rows RLS and 662 fence off). So it must
  // say security_invoker AND the same file must, afterwards, REVOKE ALL on it
  // from anon, authenticated and PUBLIC (the C50 / mig 652 shape restores the
  // ACL from the catalog after exactly that REVOKE). A materialized view has
  // no RLS at all, so it needs the REVOKE regardless.
  const revokes = [...code.matchAll(/\brevoke\s+all(?:\s+privileges)?\s+on\s+(?:table\s+)?([\s\S]+?)\s+from\s+([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*(?:;|$)/gi)]
    .map((r) => ({ at: r.index, targets: splitTop(r[1]).map(bare), from: splitTop(r[2]).map(ident) }))
  for (const m of code.matchAll(/\bcreate\s+(or\s+replace\s+)?(materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)([\s\S]*?)\bas\b([\s\S]*?)(?:;|$)/gi)) {
    const [stmt, , materialized, rawName, options, body] = m
    const name = bare(rawName)
    if (name !== 'contact_location_audience' && !CONSENT_NAME.test(body)) continue
    const invoker = materialized || INVOKER_ON.test(options)
    const closed = revokes.some((r) => r.at > m.index && r.targets.includes(name) && CLIENT_ROLES.every((g) => r.from.includes(g)))
    if (!invoker || !closed) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(/\balter\s+view\s+(?:if\s+exists\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)\s+(set|reset)\s*\(([^)]*)\)/gi)) {
    if (!CONSENT_NAME.test(bare(m[1])) && bare(m[1]) !== 'contact_location_audience') continue
    if (!/security_invoker/i.test(m[3])) continue
    if (m[2].toLowerCase() === 'reset' || !INVOKER_ON.test(m[3])) hits.push(m[0].trim())
  }
  return hits
}

describe('client code never reads consent (CONSENTREAD.1, mig 662)', { timeout: 120_000 }, () => {
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
      await supabase.from('contacts').select('id, audience:contact_location_audience(loc_email_marketing)')
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'consent_log' }, cb)`
    expect(consentReads(bad)).toEqual([
      'from:contact_preferences', 'from:consent_log', 'from:contact_location_audience',
      'embed:contact_preferences', 'embed:contact_location_preferences', 'embed:contact_location_audience',
      'realtime:consent_log',
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

describe('migrations keep the consent relations closed to clients (mig 662)', { timeout: 120_000 }, () => {
  it('mig 662 is present', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith(`${CONSENT_CLOSED_MIGRATION}_`))).toBe(true)
  })

  // EVERY migration file is scanned, not only those numbered >= 662: numbers
  // are assigned when a plan is written, not when it applies (C50's 652
  // re-creates contact_location_audience and applies AFTER 662). The files
  // that legitimately trip today are listed with a reason and the exact
  // number of statements they trip on, so a new statement in them fails too.
  const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  const scanned = all.filter((f) => !Object.hasOwn(REOPENER_ALLOWLIST, f))

  it('scans every migration file except the allowlisted history', () => {
    expect(scanned.length).toBe(all.length - Object.keys(REOPENER_ALLOWLIST).length)
    expect(scanned.some((f) => parseInt(f, 10) < CONSENT_CLOSED_MIGRATION)).toBe(true)
  })

  it.each(scanned)('%s: no client privilege, no permissive policy, no unsafe view over the consent relations', (file) => {
    expect(consentReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} reopens a consent relation to clients (mig 662). Read it through a service-role route instead`).toEqual([])
  })

  it.each(Object.entries(REOPENER_ALLOWLIST))('allowlisted %s exists and trips exactly as recorded', (file, { hits, why }) => {
    expect(all, file).toContain(file)
    expect(why.length).toBeGreaterThan(20)
    expect(consentReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')).length, file).toBe(hits)
  })

  it('the migration detector catches every form and passes the safe ones', () => {
    const bad = [
      'GRANT SELECT ON public.contact_preferences TO authenticated;',
      'grant select (contact_id, email_marketing) on contact_preferences to authenticated;',
      'GRANT SELECT ON public.contact_location_audience TO anon, authenticated;',
      'GRANT ALL ON "public"."consent_log" TO PUBLIC;',
      'GRANT SELECT ON public . consent_log TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT SELECT ON public.contacts, public.contact_location_preferences TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.consent_log TO authenticated'; END $$;`,
      'CREATE POLICY consent_log_select ON public.consent_log FOR SELECT TO authenticated USING (true);',
      'create policy "x" on contact_preferences to authenticated using (true);',
      'CREATE POLICY p ON public . consent_log FOR SELECT TO authenticated USING (true);',
      // The comment-stripper canary: a line comment holding "/*" must not swallow the GRANT after it.
      '-- see migrations/*.sql\nGRANT SELECT ON public.consent_log TO authenticated;\n/* x */',
      "COMMENT ON TABLE public.consent_log IS 'see /api/*';\nGRANT SELECT ON public.consent_log TO authenticated;\n/* x */",
      // Default privileges re-grant clients on every table or view created afterwards.
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;',
      'alter default privileges for role postgres in schema public grant select on tables to authenticated;',
      // A re-created view gets those default privileges (anon/authenticated arwdDxtm) ...
      'DROP VIEW public.contact_location_audience;\nCREATE VIEW public.contact_location_audience AS SELECT 1;',
      'CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS SELECT 1;',
      'CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS SELECT 1;\nREVOKE ALL ON public.contact_location_audience FROM anon;',
      'REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;\nCREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS SELECT 1;',
      // ... and without security_invoker it runs as its owner (a DEFINER view over contacts).
      'CREATE OR REPLACE VIEW public.contact_location_audience AS SELECT 1;\nREVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;',
      'CREATE VIEW contact_location_audience WITH (security_invoker = off) AS SELECT 1;\nREVOKE ALL ON contact_location_audience FROM anon, authenticated, PUBLIC;',
      'ALTER VIEW public.contact_location_audience SET (security_invoker = false);',
      'ALTER VIEW public.contact_location_audience RESET (security_invoker);',
      // A new view over a consent table has the same two holes.
      'CREATE VIEW public.prefs_peek AS SELECT contact_id, unsubscribe_token FROM public.contact_preferences;',
      'CREATE MATERIALIZED VIEW public.log_peek AS SELECT ip_address FROM public.consent_log;',
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
      '/* GRANT SELECT ON public.consent_log TO authenticated; /* nested */ still a comment */',
      "COMMENT ON TABLE public.consent_log IS 'service-role only -- read it through the route';",
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;',
      'CREATE VIEW public.staff_peek WITH (security_invoker = on) AS SELECT id FROM public.contacts;',
      // The C50 / mig 652 shape: security_invoker, then the ACL restored from the catalog.
      `CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS SELECT 1;
       REVOKE ALL ON public.contact_location_audience FROM PUBLIC, anon, authenticated, service_role;
       DO $$ DECLARE r record; BEGIN
         FOR r IN SELECT a.* FROM m652_view_acl a LOOP
           EXECUTE format('GRANT %s ON public.contact_location_audience TO %s%s', r.privilege_type, r.grantee, '');
         END LOOP;
       END $$;`,
      'CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = true) AS SELECT 1;\nREVOKE ALL PRIVILEGES ON public.contact_location_audience FROM anon, authenticated, PUBLIC;',
      'CREATE VIEW public.prefs_safe WITH (security_invoker) AS SELECT contact_id FROM public.contact_preferences;\nREVOKE ALL ON public.prefs_safe FROM anon, authenticated, PUBLIC;',
    ]
    for (const sql of ok) expect(consentReopeners(sql), sql).toEqual([])
  })

  it('the SQL comment stripper keeps strings and code, drops only comments (shared sqlCode)', () => {
    // tests/helpers/sql-code.js blanks comments (offsets kept); squash the spaces to compare.
    const squash = (s) => s.replace(/[ ]+/g, ' ').replace(/ *\n */g, '\n').trim()
    expect(squash(sqlCode("a -- x /* y\nb /* c -- d */ e '--f' \"/*g*/\""))).toBe("a\nb e '--f' \"/*g*/\"")
    expect(squash(sqlCode('x /* a /* b */ c */ y'))).toBe('x y')
    expect(sqlCode("E'it\\'s -- here' z")).toBe("E'it\\'s -- here' z")
    // GUARDSTRIP.1 (C74): the old one-pass stripper here read a DO body's
    // closing $$ as a new literal's opening, so a '/*' in a later $$ literal
    // hid a real GRANT. Each body is now paired with its own closing tag.
    expect(sqlCode('DO $$ BEGIN PERFORM 1; END $$;\nSELECT $$ /* $$;\nGRANT UPDATE ON public.consent_log TO authenticated;\nSELECT $$ */ $$;'))
      .toContain('GRANT UPDATE ON public.consent_log TO authenticated;')
  })
})
