// SECRETTAILS.1 — behavioural test for migrations 658 and 659.
//
// shelly_connections.key_hint held the last 4 characters of the Shelly auth
// key. 658 makes it nullable (applied BEFORE the code that stops writing it,
// because Postgres checks NOT NULL on the proposed row before ON CONFLICT
// arbitration: a key-less upsert fails 23502 even on an existing row). 659
// clears it and forbids a value (applied after the deploy). This boots PGlite
// with the table in PROD shape (information_schema + pg_constraint, 29 Sep
// 2026), applies the REAL files and asserts both halves. Fictional values
// only (SYNTH-…): the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_658 = readFileSync(path.join(MIG_DIR, '658_shelly_key_hint_nullable.sql'), 'utf8')
const MIG_659_PATH = path.join(MIG_DIR, '659_shelly_key_hint_retired.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const LOC_NEW = 'b0000000-0000-0000-0000-00000000000b'
const KEY = 'SYNTH-SHELLY-KEY-0123456789abcd'
const FP = 'a'.repeat(64)

const SCHEMA = `
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.shelly_connections (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id          uuid NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
    host                 text NOT NULL,
    auth_key             text NOT NULL,
    auth_key_fingerprint text NOT NULL,
    key_hint             text NOT NULL,
    status               text NOT NULL DEFAULT 'connected',
    last_ok_at           timestamptz,
    last_error           text,
    last_error_at        timestamptz,
    linked_by            uuid,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shelly_connections_status_check CHECK (status IN ('connected','action_needed','error')),
    CONSTRAINT shelly_connections_host_check CHECK (host ~ '^shelly-[a-z0-9-]+\\.shelly\\.cloud$'),
    CONSTRAINT shelly_connections_fingerprint_check CHECK (auth_key_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT shelly_connections_key_hint_check CHECK (char_length(key_hint) BETWEEN 1 AND 4)
  );
  INSERT INTO public.locations VALUES ('${LOC}'), ('${LOC_NEW}');
  INSERT INTO public.shelly_connections (location_id, host, auth_key, auth_key_fingerprint, key_hint, updated_at)
    VALUES ('${LOC}', 'shelly-1-eu.shelly.cloud', '${KEY}', '${FP}', 'abcd', '2026-09-01T00:00:00Z');
`

// What the routes send. PostgREST's upsert = INSERT … ON CONFLICT DO UPDATE SET
// <the payload's columns>. `withHint` is the pre-SECRETTAILS code.
function upsert(loc, { withHint = null } = {}) {
  const cols = ['location_id', 'host', 'auth_key', 'auth_key_fingerprint', 'status', 'last_error', 'last_error_at', 'last_ok_at', 'updated_at']
  const vals = [`'${loc}'`, `'shelly-2-eu.shelly.cloud'`, `'${KEY}'`, `'${FP}'`, `'connected'`, 'NULL', 'NULL', 'now()', 'now()']
  if (withHint !== null) { cols.push('key_hint'); vals.push(`'${withHint}'`) }
  const set = cols.filter((c) => c !== 'location_id').map((c) => `${c} = excluded.${c}`).join(', ')
  return `INSERT INTO public.shelly_connections (${cols.join(', ')}) VALUES (${vals.join(', ')})
          ON CONFLICT (location_id) DO UPDATE SET ${set} RETURNING host, status`
}

let db
// The same indirection as tests/migration-651-*.test.js (multi-statement SQL).
const runSql = (text) => db['exec'](text)
const one = async (sql) => (await db.query(sql)).rows[0]

beforeEach(async () => {
  db = new PGlite()
  await runSql(SCHEMA)
})
afterEach(async () => { await db.close() })

describe('mig 658 — key_hint may be NULL (applied before the code stops writing it)', () => {
  it('THE TRAP: before 658 a key-less upsert fails NOT NULL, even on an existing row', async () => {
    await expect(db.query(upsert(LOC))).rejects.toThrow(/null value in column "key_hint"/)
  })

  it('after 658 the new code (no hint) saves, on an existing row and on a first connect', async () => {
    await runSql(MIG_658)
    await expect(db.query(upsert(LOC))).resolves.toBeTruthy()
    await db.query(upsert(LOC_NEW))
    expect(await one(`SELECT key_hint FROM public.shelly_connections WHERE location_id = '${LOC_NEW}'`)).toEqual({ key_hint: null })
  })

  it('after 658 the OLD code (writes a 1-4 char hint) still saves, and the old CHECK still bounds it', async () => {
    await runSql(MIG_658)
    await expect(db.query(upsert(LOC, { withHint: 'wxyz' }))).resolves.toBeTruthy()
    await expect(db.query(upsert(LOC, { withHint: 'toolong' }))).rejects.toThrow(/shelly_connections_key_hint_check/)
  })

  it('658 changes no data and is idempotent', async () => {
    await runSql(MIG_658)
    await runSql(MIG_658)
    expect(await one(`SELECT key_hint FROM public.shelly_connections WHERE location_id = '${LOC}'`)).toEqual({ key_hint: 'abcd' })
    expect(await one(`SELECT is_nullable FROM information_schema.columns
                        WHERE table_name = 'shelly_connections' AND column_name = 'key_hint'`)).toEqual({ is_nullable: 'YES' })
  })
})

const MIG_659 = existsSync(MIG_659_PATH) ? readFileSync(MIG_659_PATH, 'utf8') : ''

describe('mig 659 — the hint is cleared and can never be stored again', () => {
  it('the file exists (it is applied ≥1 h after the SECRETTAILS.1b deploy)', () => {
    expect(MIG_659).toMatch(/shelly_connections_key_hint_retired/)
  })

  it('clears the stored hint without touching updated_at (the hub reads it as the last attempt)', async () => {
    await runSql(MIG_658)
    await runSql(MIG_659)
    expect(await one(`SELECT key_hint, updated_at::text AS u FROM public.shelly_connections WHERE location_id = '${LOC}'`))
      .toEqual({ key_hint: null, u: '2026-09-01 00:00:00+00' })
  })

  it('no hint can be stored again: an old-code save fails the retire CHECK', async () => {
    await runSql(MIG_658)
    await runSql(MIG_659)
    await expect(db.query(upsert(LOC, { withHint: 'wxyz' }))).rejects.toThrow(/shelly_connections_key_hint_retired/)
    await expect(db.query(`UPDATE public.shelly_connections SET key_hint = 'q' WHERE location_id = '${LOC}'`))
      .rejects.toThrow(/shelly_connections_key_hint_retired/)
  })

  it('the new code still saves (existing row and first connect)', async () => {
    await runSql(MIG_658)
    await runSql(MIG_659)
    await expect(db.query(upsert(LOC))).resolves.toBeTruthy()
    await expect(db.query(upsert(LOC_NEW))).resolves.toBeTruthy()
  })

  it('the old length CHECK is gone and the retire CHECK is validated', async () => {
    await runSql(MIG_658)
    await runSql(MIG_659)
    const cons = (await db.query(`SELECT conname, convalidated FROM pg_constraint
                                    WHERE conrelid = 'public.shelly_connections'::regclass AND conname LIKE '%key_hint%'
                                    ORDER BY conname`)).rows
    expect(cons).toEqual([{ conname: 'shelly_connections_key_hint_retired', convalidated: true }])
  })

  it('659 WITHOUT 658 aborts the whole file and changes nothing', async () => {
    await expect(runSql(MIG_659)).rejects.toThrow()
    await runSql('ROLLBACK').catch(() => {})
    expect(await one(`SELECT key_hint FROM public.shelly_connections WHERE location_id = '${LOC}'`)).toEqual({ key_hint: 'abcd' })
    expect(await one(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'shelly_connections_key_hint_retired'`))
      .toEqual({ n: 0 })
  })

  it('659 runs twice cleanly (658 is not re-runnable after 659 by design: its self-check refuses once the length CHECK is gone)', async () => {
    await runSql(MIG_658)
    await runSql(MIG_659)
    await runSql(MIG_659)
    expect(await one(`SELECT count(*)::int AS n FROM public.shelly_connections WHERE key_hint IS NOT NULL`)).toEqual({ n: 0 })
  })
})
