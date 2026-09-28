// AUDITSECRETS.1 — behavioural test for migration 647.
//
// private.log_mutation() (mig 191) copied every changed column into
// audit_events.details, masking only four top-level columns. So the whole
// locations.settings object (Glofox and UniFi credentials), thinq_pat and
// profiles.pin_hash reached the audit log, where masters and owners can read
// them. This boots an in-process Postgres (PGlite) with the six audited tables
// (the columns the trigger sees that matter here), replays the REAL mig 191
// file to prove the leak, applies the REAL 647 file, and asserts:
//   * no fixture secret appears anywhere in any audit row, for INSERT,
//     UPDATE and DELETE, at any depth (settings sub-objects, arrays);
//   * non-secret siblings stay readable, and null / "" secrets stay as they are;
//   * a credential rotation is still logged, as "[redacted]" -> "[redacted: changed]";
//   * the unchanged behaviour: an updated_at-only update logs nothing, and an
//     audit failure never aborts the real write;
//   * the helpers are not executable by client roles;
//   * the file's self-check aborts on a missing trigger;
//   * the SQL rule and the JS mirror (tests/helpers/audit-secret-keys.js) are
//     the same regex, and agree on every prod name.
// Fictional values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import {
  AUDIT_SECRET_KEY_PATTERN,
  AUDIT_SECRET_EXACT,
  KNOWN_SECRET_NAMES,
  KNOWN_NOT_SECRET_NAMES,
  KNOWN_MASKED_LOOKALIKES,
  isAuditSecretKey,
} from './helpers/audit-secret-keys.js'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_191 = readFileSync(path.join(MIG_DIR, '191_audit_mutation_triggers.sql'), 'utf8')
const MIG_647 = readFileSync(path.join(MIG_DIR, '647_audit_redact_secrets.sql'), 'utf8')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const LOC_NEW = 'a0000000-0000-0000-0000-00000000000b'
const PERSON = '10000000-0000-0000-0000-000000000001'
const CAR = '20000000-0000-0000-0000-000000000001'

// Every fictional secret below starts with FAKESECRET so one LIKE finds any leak.
const SETTINGS = {
  glofox: { api_key: 'FAKESECRET-gk-1', api_token: 'FAKESECRET-gt-1', webhook_secret: 'FAKESECRET-gw-1', branch_id: 'branch-1', namespace: 'ns-1' },
  unifi: { api_token: 'FAKESECRET-ut-1', host: '10.0.0.1', allow_self_signed: true },
  customer_agent: { enabled: false, test_phones: [] },
  wa_card_sets: [{ label: 'Cards', access_token: 'FAKESECRET-wa-1' }],
}

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;
  GRANT USAGE ON SCHEMA private TO authenticated;  -- prod nspacl

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;

  -- Prod audit_events columns (information_schema, 28 Sep 2026).
  CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    category text NOT NULL, action text NOT NULL,
    actor_id uuid, actor_label text, target_profile_id uuid, target_label text,
    target_resource text, location_id uuid, details jsonb, ip_address inet, user_agent text,
    -- Test-only: insert order. PGlite's clock can hand two quick writes the
    -- same occurred_at, so "latest row" orders by this, not the timestamp.
    seq bigint GENERATED ALWAYS AS IDENTITY
  );

  -- The six audited tables, with the columns this test exercises.
  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, name text, settings jsonb DEFAULT '{}'::jsonb,
    sensibo_api_key text, thinq_pat text, thinq_client_id text, bca_config jsonb,
    updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, full_name text, role text, pin_hash text, pin_set_at timestamptz,
    pin_failed_count integer DEFAULT 0, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.profile_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid, location_id uuid, role text,
    unifi_synced_at timestamptz
  );
  CREATE TABLE public.cars (
    id uuid PRIMARY KEY, location_id uuid, status text, deposit_token uuid,
    deposit_token_expires_at timestamptz, deposit_revolut_checkout_url text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.invoices_queue (
    id uuid PRIMARY KEY, location_id uuid, status text, content_hash text, extracted_fields jsonb,
    updated_at timestamptz DEFAULT now()
  );
`

async function freshDb({ applyFix = true } = {}) {
  const db = new PGlite()
  await db.exec(BASE_SCHEMA)
  await db.exec(MIG_191)
  if (applyFix) await db.exec(MIG_647)
  return db
}

async function lastEvent(db, action) {
  const { rows } = await db.query(
    `SELECT details, details::text AS txt FROM public.audit_events WHERE action = $1 ORDER BY seq DESC LIMIT 1`,
    [action],
  )
  return rows[0] || null
}

async function leakCount(db) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.audit_events WHERE details::text LIKE '%FAKESECRET%'`)
  return rows[0].n
}

describe('mig 191 (before 647) leaks credentials into audit_events', () => {
  let db
  beforeAll(async () => { db = await freshDb({ applyFix: false }) })
  afterAll(async () => { await db.close() })

  it('copies settings, thinq_pat and pin_hash in clear', async () => {
    await db.query(`INSERT INTO public.locations (id, name, settings) VALUES ($1, 'Studio A', $2)`, [LOC, JSON.stringify(SETTINGS)])
    await db.query(`UPDATE public.locations SET thinq_pat = 'FAKESECRET-pat-1' WHERE id = $1`, [LOC])
    await db.query(`INSERT INTO public.profiles (id, full_name, role) VALUES ($1, 'Test Person', 'staff')`, [PERSON])
    await db.query(`UPDATE public.profiles SET pin_hash = 'FAKESECRET-scrypt-1' WHERE id = $1`, [PERSON])
    const created = await lastEvent(db, 'locations.created')
    expect(created.details.after.settings.glofox.api_key).toBe('FAKESECRET-gk-1')
    expect((await lastEvent(db, 'locations.updated')).details.after.thinq_pat).toBe('FAKESECRET-pat-1')
    expect((await lastEvent(db, 'profiles.updated')).details.after.pin_hash).toBe('FAKESECRET-scrypt-1')
    expect(await leakCount(db)).toBe(3)
  })
})

describe('mig 647 redacts every secret-named key, at any depth', () => {
  let db
  beforeAll(async () => {
    db = await freshDb()
    await db.query(`INSERT INTO public.profiles (id, full_name, role) VALUES ($1, 'Test Person', 'staff')`, [PERSON])
  })
  afterAll(async () => { await db.close() })

  it('INSERT: settings secrets masked, siblings kept', async () => {
    await db.query(`INSERT INTO public.locations (id, name, settings) VALUES ($1, 'Studio A', $2)`, [LOC, JSON.stringify(SETTINGS)])
    const { details, txt } = await lastEvent(db, 'locations.created')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.after.settings.glofox).toEqual({
      api_key: '[redacted]', api_token: '[redacted]', webhook_secret: '[redacted]', branch_id: 'branch-1', namespace: 'ns-1',
    })
    expect(details.after.settings.unifi).toEqual({ api_token: '[redacted]', host: '10.0.0.1', allow_self_signed: true })
    expect(details.after.settings.wa_card_sets).toEqual([{ label: 'Cards', access_token: '[redacted]' }])
    expect(details.after.settings.customer_agent).toEqual({ enabled: false, test_phones: [] })
    expect(details.after.name).toBe('Studio A')
    // A column that was never set stays null (not "[redacted]").
    expect(details.after.thinq_pat).toBeNull()
    expect(details.after.sensibo_api_key).toBeNull()
  })

  it('UPDATE of a non-secret settings key: the diff shows it, secrets stay masked both sides', async () => {
    const next = { ...SETTINGS, customer_agent: { enabled: true, test_phones: [] } }
    await db.query(`UPDATE public.locations SET settings = $2 WHERE id = $1`, [LOC, JSON.stringify(next)])
    const { details, txt } = await lastEvent(db, 'locations.updated')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.before.settings.customer_agent.enabled).toBe(false)
    expect(details.after.settings.customer_agent.enabled).toBe(true)
    expect(details.before.settings.glofox.api_key).toBe('[redacted]')
    expect(details.after.settings.glofox.api_key).toBe('[redacted]')
    expect(Object.keys(details.after)).toEqual(['settings'])
  })

  it('UPDATE that only rotates a credential is still logged, and says which one changed', async () => {
    await db.query(
      `UPDATE public.locations SET settings = jsonb_set(settings, '{glofox,api_key}', '"FAKESECRET-gk-2"') WHERE id = $1`,
      [LOC],
    )
    const { details, txt } = await lastEvent(db, 'locations.updated')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.before.settings.glofox.api_key).toBe('[redacted]')
    expect(details.after.settings.glofox.api_key).toBe('[redacted: changed]')
    expect(details.after.settings.glofox.api_token).toBe('[redacted]')
    expect(details.after.settings.unifi.api_token).toBe('[redacted]')
  })

  it('a secret nested in an array is marked changed by its index path', async () => {
    await db.query(
      `UPDATE public.locations SET settings = jsonb_set(settings, '{wa_card_sets,0,access_token}', '"FAKESECRET-wa-2"') WHERE id = $1`,
      [LOC],
    )
    const { details, txt } = await lastEvent(db, 'locations.updated')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.after.settings.wa_card_sets[0]).toEqual({ label: 'Cards', access_token: '[redacted: changed]' })
    expect(details.after.settings.glofox.api_key).toBe('[redacted]')
  })

  it('secret COLUMNS: thinq_pat and sensibo_api_key are masked, and a change to one alone is now logged', async () => {
    await db.query(`UPDATE public.locations SET thinq_pat = 'FAKESECRET-pat-1', thinq_client_id = 'client-1' WHERE id = $1`, [LOC])
    let ev = await lastEvent(db, 'locations.updated')
    expect(ev.txt).not.toContain('FAKESECRET')
    expect(ev.details.before).toEqual({ thinq_pat: null, thinq_client_id: null })
    expect(ev.details.after).toEqual({ thinq_pat: '[redacted: changed]', thinq_client_id: 'client-1' })

    await db.query(`UPDATE public.locations SET sensibo_api_key = 'FAKESECRET-sb-1' WHERE id = $1`, [LOC])
    ev = await lastEvent(db, 'locations.updated')
    expect(ev.details).toEqual({ before: { sensibo_api_key: null }, after: { sensibo_api_key: '[redacted: changed]' } })
  })

  it('clearing a secret shows "[redacted]" -> null', async () => {
    await db.query(`UPDATE public.locations SET thinq_pat = NULL WHERE id = $1`, [LOC])
    const { details } = await lastEvent(db, 'locations.updated')
    expect(details).toEqual({ before: { thinq_pat: '[redacted]' }, after: { thinq_pat: null } })
  })

  it('profiles.pin_hash is masked; its bookkeeping columns stay visible', async () => {
    await db.query(`UPDATE public.profiles SET pin_hash = 'FAKESECRET-scrypt-1', pin_set_at = '2026-09-28T10:00:00Z' WHERE id = $1`, [PERSON])
    const { details, txt } = await lastEvent(db, 'profiles.updated')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.after.pin_hash).toBe('[redacted: changed]')
    expect(details.after.pin_set_at).toMatch(/^2026-09-28/)
  })

  it('cars: deposit_token and the checkout URL are masked (masked now, dropped before); the expiry stays', async () => {
    await db.query(
      `INSERT INTO public.cars (id, location_id, status, deposit_token, deposit_token_expires_at, deposit_revolut_checkout_url)
       VALUES ($1, $2, 'listed', gen_random_uuid(), '2026-10-01T00:00:00Z', 'https://pay.example.test/FAKESECRET-co-1')`,
      [CAR, LOC],
    )
    const { details, txt } = await lastEvent(db, 'cars.created')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.after.deposit_token).toBe('[redacted]')
    expect(details.after.deposit_revolut_checkout_url).toBe('[redacted]')
    expect(details.after.deposit_token_expires_at).toMatch(/^2026-10-01/)
  })

  it('invoices_queue.content_hash (not a credential) stays visible', async () => {
    await db.query(`INSERT INTO public.invoices_queue (id, location_id, status, content_hash, extracted_fields) VALUES (gen_random_uuid(), $1, 'new', 'hash-1', '{"supplier":"Acme"}')`, [LOC])
    const { details } = await lastEvent(db, 'invoices_queue.created')
    expect(details.after.content_hash).toBe('hash-1')
    expect(details.after.extracted_fields).toEqual({ supplier: 'Acme' })
  })

  it('DELETE: the before-image is masked', async () => {
    await db.query(`INSERT INTO public.locations (id, name, settings) VALUES ($1, 'Studio B', $2)`, [LOC_NEW, JSON.stringify(SETTINGS)])
    await db.query(`DELETE FROM public.locations WHERE id = $1`, [LOC_NEW])
    const { details, txt } = await lastEvent(db, 'locations.deleted')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.before.settings.glofox.api_key).toBe('[redacted]')
  })

  it('unchanged: an updated_at-only update logs nothing', async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM public.audit_events`)).rows[0].n
    await db.query(`UPDATE public.locations SET updated_at = now() + interval '1 minute' WHERE id = $1`, [LOC])
    const after = (await db.query(`SELECT count(*)::int AS n FROM public.audit_events`)).rows[0].n
    expect(after).toBe(before)
  })

  it('no audit row anywhere holds a fixture secret', async () => {
    expect(await leakCount(db)).toBe(0)
  })

  it('unchanged: an audit failure never aborts the real write', async () => {
    await db.exec(`ALTER TABLE public.audit_events RENAME TO audit_events_away`)
    try {
      await db.query(`UPDATE public.locations SET name = 'Studio A2' WHERE id = $1`, [LOC])
      const { rows } = await db.query(`SELECT name FROM public.locations WHERE id = $1`, [LOC])
      expect(rows[0].name).toBe('Studio A2')
    } finally {
      await db.exec(`ALTER TABLE public.audit_events_away RENAME TO audit_events`)
    }
  })

  it('the helpers are not executable by client roles', async () => {
    const { rows } = await db.query(`
      SELECT bool_or(has_function_privilege(r, f, 'EXECUTE')) AS any_grant
      FROM unnest(array['anon','authenticated']) r,
           unnest(array['private.audit_is_secret_key(text)','private.audit_redact(jsonb,text[],text,integer)','private.audit_secret_paths(jsonb,text,integer)']) f`)
    expect(rows[0].any_grant).toBe(false)
  })

  it('re-applying the file is harmless (create or replace + the self-check)', async () => {
    await expect(db.exec(MIG_647)).resolves.toBeDefined()
  })
})

// { a: { a: ... leaf } }, the leaf reached by `depth` keys.
function nested(depth, leaf) {
  let o = leaf
  for (let i = 0; i < depth; i++) o = { a: o }
  return o
}
const A = (n) => Array.from({ length: n }, () => 'a')
const MAX_DEPTH = 12 // the cap in private.audit_redact / private.audit_secret_paths

describe('the walk is depth-capped, so it cannot hit the stack limit', () => {
  // The cap is exercised at its real value (12), on a 30-deep document:
  // without the cap the walk would recurse 30 plpgsql-in-SQL levels.
  let db
  beforeAll(async () => {
    db = await freshDb()
    await db.query(`INSERT INTO public.locations (id, name, settings) VALUES ($1, 'Studio A', $2)`, [LOC, JSON.stringify(SETTINGS)])
  })
  afterAll(async () => { await db.close() })

  it('a 30-deep document: the container at depth 12 becomes "[redacted: too deep]"', async () => {
    const doc = nested(30, { api_token: 'FAKESECRET-deep-1', note: 'bottom' })
    const { rows } = await db.query(`SELECT private.audit_redact($1::jsonb) AS r`, [JSON.stringify(doc)])
    const r = rows[0].r
    expect(JSON.stringify(r)).not.toContain('FAKESECRET')
    let node = r
    for (let i = 0; i < MAX_DEPTH - 1; i++) node = node.a
    expect(typeof node).toBe('object') // depth 11 is still walked
    expect(node.a).toBe('[redacted: too deep]') // depth 12 is not
  })

  it('the boundary: a container at depth 11 is walked (secret masked, sibling kept); at depth 12 it is replaced', async () => {
    const leaf = { api_token: 'FAKESECRET-edge-1', note: 'kept' }
    const { rows } = await db.query(
      `SELECT private.audit_redact($1::jsonb) #> $3::text[] AS at11, private.audit_redact($2::jsonb) #> $4::text[] AS at12`,
      [JSON.stringify(nested(MAX_DEPTH - 1, leaf)), JSON.stringify(nested(MAX_DEPTH, leaf)), A(MAX_DEPTH - 1), A(MAX_DEPTH)],
    )
    expect(rows[0].at11).toEqual({ api_token: '[redacted]', note: 'kept' })
    expect(rows[0].at12).toBe('[redacted: too deep]')
  })

  it('audit_secret_paths reports a subtree past the cap whole, as a possible secret', async () => {
    const leaf = { api_token: 'v' }
    const { rows } = await db.query(
      `SELECT (SELECT array_agg(path) FROM private.audit_secret_paths($1::jsonb)) AS p11,
              (SELECT array_agg(path) FROM private.audit_secret_paths($2::jsonb)) AS p12,
              (SELECT jsonb_agg(val)  FROM private.audit_secret_paths($2::jsonb)) AS v12`,
      [JSON.stringify(nested(MAX_DEPTH - 1, leaf)), JSON.stringify(nested(MAX_DEPTH, leaf))],
    )
    expect(rows[0].p11).toEqual([[...A(MAX_DEPTH - 1), 'api_token'].join('.')])
    expect(rows[0].p12).toEqual([A(MAX_DEPTH).join('.')])
    expect(rows[0].v12).toEqual([leaf])
  })

  it('through the trigger: a 30-deep settings value is logged, masked "too deep", nothing leaks', async () => {
    const next = { ...SETTINGS, deep: nested(30, { api_token: 'FAKESECRET-deep-2' }) }
    await db.query(`UPDATE public.locations SET settings = $2 WHERE id = $1`, [LOC, JSON.stringify(next)])
    const ev = await lastEvent(db, 'locations.updated')
    expect(ev).not.toBeNull()
    expect(ev.txt).not.toContain('FAKESECRET')
    // row depth: settings = 1, deep = 2, so 10 more keys reach depth 12
    let node = ev.details.after.settings.deep
    for (let i = 0; i < MAX_DEPTH - 3; i++) node = node.a
    expect(node.a).toBe('[redacted: too deep]')
    expect(ev.details.after.settings.glofox.api_key).toBe('[redacted]')
    expect(ev.details.after.settings.glofox.branch_id).toBe('branch-1')
  })
})

describe('a redaction failure still writes the audit row, without values, and never aborts the write', () => {
  // Fixture: wrap the rule so it raises while the GUC c27.force_fail is on.
  // Everything else is the real 647.
  let db
  const notices = []
  const onNotice = (n) => notices.push(n)
  async function forced(sql, params) {
    await db.query(`SELECT set_config('c27.force_fail', 'on', false), set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: PERSON })])
    try {
      return await db.query(sql, params, { onNotice })
    } finally {
      await db.query(`SELECT set_config('c27.force_fail', 'off', false), set_config('request.jwt.claims', '', false)`)
    }
  }
  const run = (sql) => db.exec(sql)

  beforeAll(async () => {
    db = await freshDb()
    await run(`
      ALTER FUNCTION private.audit_is_secret_key(text) RENAME TO audit_is_secret_key_orig;
      CREATE FUNCTION private.audit_is_secret_key(p_key text) RETURNS boolean
      LANGUAGE plpgsql SET search_path = '' AS $fn$
      BEGIN
        IF current_setting('c27.force_fail', true) = 'on' THEN
          RAISE EXCEPTION 'forced failure at key % FAKESECRET-errmsg', p_key;
        END IF;
        RETURN private.audit_is_secret_key_orig(p_key);
      END $fn$;
    `)
    await db.query(`INSERT INTO public.locations (id, name, settings) VALUES ($1, 'Studio A', $2)`, [LOC, JSON.stringify(SETTINGS)])
  })
  afterAll(async () => { await db.close() })

  it('UPDATE: the write lands; the audit row keeps who/what/target and holds only the SQLSTATE', async () => {
    notices.length = 0
    await forced(
      `UPDATE public.locations SET name = 'Studio F', settings = jsonb_set(settings, '{glofox,api_key}', '"FAKESECRET-gk-9"') WHERE id = $1`,
      [LOC],
    )
    const { rows } = await db.query(`SELECT name FROM public.locations WHERE id = $1`, [LOC])
    expect(rows[0].name).toBe('Studio F')
    const ev = (await db.query(
      `SELECT category, actor_id, target_resource, location_id, details, occurred_at
         FROM public.audit_events WHERE action = 'locations.updated' ORDER BY seq DESC LIMIT 1`,
    )).rows[0]
    expect(ev.details).toEqual({ audit_redaction_failed: 'P0001' })
    expect(ev.category).toBe('mutation')
    expect(ev.actor_id).toBe(PERSON)
    expect(ev.target_resource).toBe(`locations/${LOC}`)
    expect(ev.occurred_at).toBeInstanceOf(Date)
    const warn = notices.filter((n) => n.severity === 'WARNING').map((n) => n.message)
    expect(warn).toHaveLength(1)
    expect(warn[0]).toMatch(/^log_mutation:/)
    expect(warn[0]).toContain('UPDATE')
    expect(warn[0]).toContain(`locations/${LOC}`)
    expect(warn[0]).toContain('P0001')
    expect(warn[0]).not.toContain('FAKESECRET') // never SQLERRM
  })

  it('INSERT: the row keeps its location_id', async () => {
    await forced(
      `INSERT INTO public.cars (id, location_id, status, deposit_revolut_checkout_url) VALUES ($1, $2, 'listed', 'https://pay.example.test/FAKESECRET-co-9')`,
      [CAR, LOC],
    )
    const ev = (await db.query(`SELECT location_id, target_resource, details FROM public.audit_events WHERE action = 'cars.created'`)).rows
    expect(ev).toEqual([{ location_id: LOC, target_resource: `cars/${CAR}`, details: { audit_redaction_failed: 'P0001' } }])
  })

  it('when the fallback insert fails too, the write still lands and a WARNING says so', async () => {
    notices.length = 0
    await run(`ALTER TABLE public.audit_events RENAME TO audit_events_away`)
    try {
      await forced(`UPDATE public.locations SET name = 'Studio G' WHERE id = $1`, [LOC])
    } finally {
      await run(`ALTER TABLE public.audit_events_away RENAME TO audit_events`)
    }
    const { rows } = await db.query(`SELECT name FROM public.locations WHERE id = $1`, [LOC])
    expect(rows[0].name).toBe('Studio G')
    const warn = notices.filter((n) => n.severity === 'WARNING').map((n) => n.message)
    expect(warn).toHaveLength(1)
    expect(warn[0]).toMatch(/^log_mutation: audit row skipped/)
    expect(warn[0]).toContain(`locations/${LOC}`)
    expect(warn[0]).not.toContain('FAKESECRET')
  })

  it('no audit row anywhere holds a fixture secret', async () => {
    expect(await leakCount(db)).toBe(0)
  })
})

describe('the rule: SQL and the JS mirror agree', () => {
  let db
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it('the migration uses exactly the helper\'s regex and exact names', () => {
    expect(MIG_647).toContain(`~ '${AUDIT_SECRET_KEY_PATTERN}'`)
    expect(MIG_647).toContain(`in (${AUDIT_SECRET_EXACT.map((n) => `'${n}'`).join(', ')})`)
  })

  it('every known secret name is redacted, every known non-secret is not (SQL and JS)', async () => {
    const names = [...KNOWN_SECRET_NAMES, ...KNOWN_NOT_SECRET_NAMES, ...KNOWN_MASKED_LOOKALIKES, 'API_KEY', 'Glofox_Api_Token', null]
    const { rows } = await db.query(
      `SELECT n, private.audit_is_secret_key(n) AS s FROM unnest($1::text[]) WITH ORDINALITY AS t(n, o) ORDER BY o`,
      [names],
    )
    for (const { n, s } of rows) expect([n, s]).toEqual([n, isAuditSecretKey(n)])
    for (const n of KNOWN_SECRET_NAMES) expect([n, isAuditSecretKey(n)]).toEqual([n, true])
    for (const n of KNOWN_NOT_SECRET_NAMES) expect([n, isAuditSecretKey(n)]).toEqual([n, false])
    for (const n of KNOWN_MASKED_LOOKALIKES) expect([n, isAuditSecretKey(n)]).toEqual([n, true])
  })
})

describe('the rule: camelCase, plurals, hashes and PINs (review fix)', () => {
  let db
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it('each new shape is masked through the trigger; the prod look-alikes stay visible', async () => {
    const settings = {
      stripe: { accessToken: 'FAKESECRET-at', refreshToken: 'FAKESECRET-rt', clientSecret: 'FAKESECRET-cs', account_id: 'acct-1' },
      webhook: { webhookSecret: 'FAKESECRET-ws', apiKey: 'FAKESECRET-ak', signature_method: 'hmac-sha256' },
      push_tokens: ['FAKESECRET-pt-1', 'FAKESECRET-pt-2'],
      tokens: { a: 'FAKESECRET-t' },
      door: { pin: 'FAKESECRET-1234', door_pin: 'FAKESECRET-5678', pin_hint: 'birthday' },
      auth: { password_hash: 'FAKESECRET-ph', secret_hash: 'FAKESECRET-sh', password_changed: true },
      mail: { email_signature: 'Regards', email_signature_html: '<p>Regards</p>', content_hash: 'c1' },
      oauth: { token_expires_at: '2026-10-01', deposit_token_expires_at: '2026-10-02' },
      files: { avatar_path: 'a/b.png', logo_url: 'https://example.test/l.png' },
    }
    await db.query(`INSERT INTO public.locations (id, name, settings) VALUES ($1, 'Studio C', $2)`, [LOC, JSON.stringify(settings)])
    const { details, txt } = await lastEvent(db, 'locations.created')
    expect(txt).not.toContain('FAKESECRET')
    const s = details.after.settings
    expect(s.stripe).toEqual({ accessToken: '[redacted]', refreshToken: '[redacted]', clientSecret: '[redacted]', account_id: 'acct-1' })
    expect(s.webhook).toEqual({ webhookSecret: '[redacted]', apiKey: '[redacted]', signature_method: 'hmac-sha256' })
    expect(s.push_tokens).toBe('[redacted]')
    expect(s.tokens).toBe('[redacted]')
    expect(s.door).toEqual({ pin: '[redacted]', door_pin: '[redacted]', pin_hint: 'birthday' })
    expect(s.auth).toEqual({ password_hash: '[redacted]', secret_hash: '[redacted]', password_changed: true })
    expect(s.mail).toEqual(settings.mail)
    expect(s.oauth).toEqual(settings.oauth)
    expect(s.files).toEqual(settings.files)
  })

  it('profiles pin_* bookkeeping columns stay visible', async () => {
    await db.query(`INSERT INTO public.profiles (id, full_name, role, pin_hash, pin_set_at, pin_failed_count) VALUES ($1, 'Test Person', 'staff', 'FAKESECRET-scrypt-2', '2026-09-28T10:00:00Z', 2)`, [PERSON])
    const { details, txt } = await lastEvent(db, 'profiles.created')
    expect(txt).not.toContain('FAKESECRET')
    expect(details.after.pin_hash).toBe('[redacted]')
    expect(details.after.pin_set_at).toMatch(/^2026-09-28/)
    expect(details.after.pin_failed_count).toBe(2)
  })
})

describe('the self-check aborts the whole file', () => {
  it('when audit_mutation is missing from one of the six tables', async () => {
    const db = await freshDb({ applyFix: false })
    try {
      await db.exec(`DROP TRIGGER audit_mutation ON public.cars`)
      await expect(db.exec(MIG_647)).rejects.toThrow(/AUDITSECRETS\.1: private\.log_mutation\(\) runs on /)
      // Nothing from the file survived: log_mutation is still mig 191's.
      const { rows } = await db.query(`SELECT to_regprocedure('private.audit_redact(jsonb,text[],text,integer)') AS f`)
      expect(rows[0].f).toBeNull()
    } finally {
      await db.close()
    }
  })

  it('when log_mutation runs on a seventh table under another trigger name', async () => {
    const db = await freshDb({ applyFix: false })
    try {
      await db.exec(`
        CREATE TABLE public.xero_connections (id uuid PRIMARY KEY, access_token text);
        CREATE TRIGGER log_xero AFTER INSERT OR UPDATE OR DELETE ON public.xero_connections
          FOR EACH ROW EXECUTE FUNCTION private.log_mutation();
      `)
      await expect(db.exec(MIG_647)).rejects.toThrow(/AUDITSECRETS\.1: private\.log_mutation\(\) runs on .*xero_connections/)
    } finally {
      await db.close()
    }
  })
})
