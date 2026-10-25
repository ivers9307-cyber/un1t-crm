// WEBHOOKAUDIT.1 — behavioural test for migration 649.
//
// glofox_webhook_events.event_id is Glofox's ENTITY id (Payload.id), so every
// later event about the same booking overwrites the one row (70% of rows in
// 30 days hold a later emission than the one that created them). 649 adds an
// append-only, service-role-only glofox_webhook_attempts table: one PII-free
// row per processed delivery.
//
// Boots PGlite, runs the REAL migs 053 (cron_heartbeats) and 132
// (glofox_webhook_events), then 649, and proves:
//   * the table exists with its FK (ON DELETE CASCADE), CHECKs and indexes;
//   * anon/authenticated hold NO privilege; service_role can insert/delete;
//   * a digest over 4,000 bytes and an error over 500 chars are refused;
//   * an attempt needs its parent row; deleting the parent removes them;
//   * replay is a no-op; the purge heartbeat note gains one sentence, once;
//   * the self-check aborts the WHOLE file when the table is not as intended
//     (a missing FK, or a browser grant the REVOKE cannot reach).
//
// Setup applies Supabase's default privileges (ALL to anon/authenticated/
// service_role on every new public table), so the no-privilege test fails if
// the migration's REVOKE is deleted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { digestGlofoxWebhookResult, MAX_DIGEST_BYTES, DB_MAX_DIGEST_BYTES } from '../src/lib/glofox-webhook-attempts.js'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_132 = read('132_glofox_webhook_events.sql')
const MIG_649 = read('649_glofox_webhook_attempts.sql')

let db
// PGlite's multi-statement SQL runner (in-process, no shell), one call per
// file, as apply_migration runs a file. Same helper as migration-644's test.
const runSql = (text) => db.exec(text)

async function parentRow(eventId = 'entity-1') {
  const { rows } = await db.query(
    `INSERT INTO public.glofox_webhook_events (event_id, event_type, payload, status)
     VALUES ($1, 'BOOKING_UPDATED', '{}'::jsonb, 'received') RETURNING id`, [eventId])
  return rows[0].id
}

const insertAttempt = (eventRowId, { status = 'applied', digest = null, error = null } = {}) => db.query(
  `INSERT INTO public.glofox_webhook_attempts (event_row_id, delivered_at, status, digest, error_message)
   VALUES ($1, now(), $2, $3::jsonb, $4)`,
  [eventRowId, status, digest === null ? null : JSON.stringify(digest), error])

const attemptCount = async () =>
  Number((await db.query('SELECT count(*)::int AS n FROM public.glofox_webhook_attempts')).rows[0].n)

const purgeNotes = async () =>
  (await db.query(`SELECT notes FROM public.cron_heartbeats WHERE name = 'purge-webhook-payloads'`)).rows[0]?.notes

beforeEach(async () => {
  db = new PGlite()
  await runSql(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    -- What Supabase does for every table created in public: all three API
    -- roles hold ALL on it. The migration must take the browser's away itself,
    -- so without this line the privilege test below could not see its REVOKE.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  `)
  await runSql(MIG_053)
  await runSql(MIG_132)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
                VALUES ('purge-webhook-payloads', 86400, 43200, 'WEBHOOK-RETENTION.1 — existing notes.')`)
})

afterEach(async () => { await db.close() })

describe('migration 649 — glofox_webhook_attempts', () => {
  it('creates the table with its columns, FK, indexes and RLS', async () => {
    await runSql(MIG_649)
    const cols = (await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'glofox_webhook_attempts' ORDER BY ordinal_position`)).rows
    expect(cols.map(c => c.column_name)).toEqual([
      'id', 'event_row_id', 'location_id', 'trace_id', 'event_type', 'emitted_at',
      'delivered_at', 'processed_at', 'status', 'error_message', 'digest',
    ])
    const notNull = cols.filter(c => c.is_nullable === 'NO').map(c => c.column_name)
    expect(notNull.sort()).toEqual(['delivered_at', 'event_row_id', 'id', 'processed_at', 'status'])

    const rls = (await db.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.glofox_webhook_attempts'::regclass`)).rows[0]
    expect(rls.relrowsecurity).toBe(true)

    const pol = (await db.query(
      `SELECT permissive, cmd, qual FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'glofox_webhook_attempts'`)).rows
    expect(pol).toEqual([{ permissive: 'RESTRICTIVE', cmd: 'ALL', qual: 'false' }])

    const idx = (await db.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'glofox_webhook_attempts' ORDER BY 1`)).rows
    expect(idx.map(i => i.indexname)).toEqual([
      'glofox_webhook_attempts_event_row_idx',
      'glofox_webhook_attempts_pkey',
      'glofox_webhook_attempts_processed_at_idx',
    ])
  })

  it('gives anon and authenticated no privilege at all; service_role can insert, read and delete', async () => {
    await runSql(MIG_649)
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await db.query(
          `SELECT has_table_privilege($1, 'public.glofox_webhook_attempts', $2) AS ok`, [role, priv])
        expect({ role, priv, ok: rows[0].ok }).toEqual({ role, priv, ok: false })
      }
    }
    for (const priv of ['SELECT', 'INSERT', 'DELETE']) {
      const { rows } = await db.query(
        `SELECT has_table_privilege('service_role', 'public.glofox_webhook_attempts', $1) AS ok`, [priv])
      expect(rows[0].ok).toBe(true)
    }
  })

  it('accepts a row with no digest, and a digest up to 4,000 bytes', async () => {
    await runSql(MIG_649)
    const id = await parentRow()
    await insertAttempt(id)
    await insertAttempt(id, { digest: { pad: 'x'.repeat(3900) } })
    expect(await attemptCount()).toBe(2)
  })

  it('refuses a digest over 4,000 bytes and an error over 500 characters', async () => {
    await runSql(MIG_649)
    const id = await parentRow()
    await expect(insertAttempt(id, { digest: { pad: 'x'.repeat(4001) } })).rejects.toThrow(/glofox_webhook_attempts_digest_size/)
    await expect(insertAttempt(id, { error: 'e'.repeat(501) })).rejects.toThrow(/glofox_webhook_attempts_error_size/)
    expect(await attemptCount()).toBe(0)
  })

  it('accepts the largest digest the JS keeps: its jsonb text is longer than its JSON, and still fits', async () => {
    await runSql(MIG_649)
    // Many short list elements = many separators, each one a byte longer in
    // jsonb's text form than in JSON.stringify.
    const tags = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const resultFor = (keyChars) => {
      const changes = {}
      for (let i = 0, left = keyChars; left > 0; i++, left -= 60) {
        changes[(String(i).padStart(2, '0') + 'k'.repeat(60)).slice(0, Math.min(left, 60))] = { from: 1, to: 2 }
      }
      return { contact_id: 'c', tags, member_sync: { action: 'update', changes, transition_tags: { written: tags, alreadyPresent: tags } } }
    }
    let largest = null
    for (let k = 2000; k <= 3800; k++) {
      const d = digestGlofoxWebhookResult(resultFor(k))
      if (d.oversize) break
      largest = d
    }
    const jsonBytes = new TextEncoder().encode(JSON.stringify(largest)).length
    expect(jsonBytes).toBeGreaterThan(MAX_DIGEST_BYTES - 5)

    const id = await parentRow()
    await insertAttempt(id, { digest: largest })
    const { rows } = await db.query('SELECT octet_length(digest::text) AS n FROM public.glofox_webhook_attempts')
    expect(rows[0].n).toBeGreaterThan(jsonBytes)
    expect(rows[0].n).toBeLessThanOrEqual(DB_MAX_DIGEST_BYTES)
  })

  it('needs its parent row, and goes when the parent goes', async () => {
    await runSql(MIG_649)
    await expect(insertAttempt('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/foreign key/i)
    const keep = await parentRow('entity-keep')
    const drop = await parentRow('entity-drop')
    await insertAttempt(keep)
    await insertAttempt(drop)
    await insertAttempt(drop)
    await db.query('DELETE FROM public.glofox_webhook_events WHERE id = $1', [drop])
    expect(await attemptCount()).toBe(1)
  })

  it('documents event_id as the entity id', async () => {
    await runSql(MIG_649)
    const { rows } = await db.query(
      `SELECT col_description('public.glofox_webhook_events'::regclass,
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.glofox_webhook_events'::regclass AND attname = 'event_id')) AS c`)
    expect(rows[0].c).toMatch(/ENTITY id/)
    expect(rows[0].c).toMatch(/trace_id/)
  })

  it('the table comment scopes "PII-free" to the digest and names error_message as copied free text', async () => {
    await runSql(MIG_649)
    const { rows } = await db.query(`SELECT obj_description('public.glofox_webhook_attempts'::regclass, 'pg_class') AS c`)
    expect(rows[0].c).toMatch(/digest is PII-free/)
    expect(rows[0].c).toMatch(/error_message .*free text.*glofox_webhook_events/)
    expect(rows[0].c).not.toMatch(/One PII-free row/)
  })

  it('appends one sentence to the purge heartbeat notes, once, and replays as a no-op', async () => {
    await runSql(MIG_649)
    const once = await purgeNotes()
    expect(once.startsWith('WEBHOOK-RETENTION.1 — existing notes.')).toBe(true)
    expect(once).toMatch(/glofox_webhook_attempts/)
    const id = await parentRow()
    await insertAttempt(id)

    await runSql(MIG_649)
    expect(await purgeNotes()).toBe(once)
    expect(await attemptCount()).toBe(1)
  })

  it('still applies when the purge heartbeat row is absent', async () => {
    await db.query(`DELETE FROM public.cron_heartbeats WHERE name = 'purge-webhook-payloads'`)
    await expect(runSql(MIG_649)).resolves.toBeDefined()
    expect(await purgeNotes()).toBeUndefined()
  })

  it('the self-check aborts the WHOLE file when a pre-existing table lacks the FK', async () => {
    await runSql(`CREATE TABLE public.glofox_webhook_attempts (
      id bigint PRIMARY KEY, event_row_id uuid NOT NULL, location_id uuid, trace_id text, event_type text,
      emitted_at timestamptz, delivered_at timestamptz NOT NULL, processed_at timestamptz NOT NULL,
      status text NOT NULL, error_message text, digest jsonb)`)
    await expect(runSql(MIG_649)).rejects.toThrow(/649 self-check: .*foreign key/)
    // Defensive: leave no aborted transaction block behind (a no-op if PGlite already rolled back).
    await db.query('ROLLBACK').catch(() => {})
    // Rolled back as one transaction: the note, the column comment and RLS never landed.
    expect(await purgeNotes()).toBe('WEBHOOK-RETENTION.1 — existing notes.')
    const { rows } = await db.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.glofox_webhook_attempts'::regclass`)
    expect(rows[0].relrowsecurity).toBe(false)
  })

  it('the self-check aborts the WHOLE file on a lingering browser grant the REVOKE cannot reach', async () => {
    // A pre-existing, otherwise-correct table readable through PUBLIC: the
    // migration's REVOKE (FROM anon, authenticated) does not touch a PUBLIC
    // grant, but anon and authenticated inherit it; the catalog check must.
    await runSql(`CREATE TABLE public.glofox_webhook_attempts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_row_id uuid NOT NULL REFERENCES public.glofox_webhook_events(id) ON DELETE CASCADE,
      location_id uuid, trace_id text, event_type text, emitted_at timestamptz,
      delivered_at timestamptz NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL, error_message text, digest jsonb);
      GRANT SELECT ON public.glofox_webhook_attempts TO PUBLIC;`)
    await expect(runSql(MIG_649)).rejects.toThrow(/649 self-check: anon still holds SELECT/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await purgeNotes()).toBe('WEBHOOK-RETENTION.1 — existing notes.')
    const { rows } = await db.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.glofox_webhook_attempts'::regclass`)
    expect(rows[0].relrowsecurity).toBe(false)
  })
})
