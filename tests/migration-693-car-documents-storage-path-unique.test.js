// CARDOCUNIQUE.1 (C129) — behavioural test for migration 693.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with car_documents reduced
// to the columns the index and the recorder need (prod's NOT NULL
// storage_path and its two car_id indexes; mig 674 left it with no client
// privilege), and proves:
//   * BEFORE: two rows can hold the same storage_path (the finalise race:
//     read-then-insert, so two concurrent calls on one slot file two
//     documents and two bookkeeper-queue entries);
//   * AFTER: a second row on a path fails 23505 naming the new index; other
//     paths still insert; every existing row is kept; the client privileges
//     are untouched;
//   * the file aborts WHOLE, creating nothing, when duplicate paths exist
//     (prod had 0 of 12 on 1-2 Oct 2026), and when an index already holds
//     the name with another definition; a second run passes; the rollback
//     record (DROP INDEX) restores the before-state.
// Fictional ids and paths only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_693 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/693_car_documents_storage_path_unique.sql'), 'utf8')
const ROLLBACK_693 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.car_documents_storage_path_key;
COMMIT;
`
const CAR = 'c0000000-0000-0000-0000-000000000001'
const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.car_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    car_id uuid NOT NULL,
    doc_type text NOT NULL DEFAULT 'invoice',
    storage_path text NOT NULL,
    filename text NOT NULL DEFAULT 'doc.pdf'
  );
  CREATE INDEX idx_car_documents_car ON public.car_documents (car_id);
  CREATE INDEX idx_car_documents_type ON public.car_documents (car_id, doc_type);
  ALTER TABLE public.car_documents ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.car_documents FROM PUBLIC, anon, authenticated;
  GRANT ALL ON public.car_documents TO service_role;
  INSERT INTO public.car_documents (car_id, storage_path) VALUES
    ('${CAR}', '${CAR}/invoice/1-a.pdf'), ('${CAR}', '${CAR}/invoice/2-b.pdf'), ('${CAR}', '${CAR}/registration/3-c.jpg');
`
const run = (db, sql) => db['exec'](sql)
async function boot(extra = '') {
  const db = new PGlite()
  await run(db, SCHEMA)
  if (extra) await run(db, extra)
  return db
}
async function abortMessage(db, sql) {
  try {
    await run(db, sql)
    return null
  } catch (e) {
    await run(db, 'ROLLBACK;')
    return String(e.message || e)
  }
}
const insertPath = (p) => `INSERT INTO public.car_documents (car_id, storage_path) VALUES ('${CAR}', '${p}')`
const indexes = async (db) => (await db.query(
  `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'car_documents' ORDER BY 1`)).rows
const rowCount = async (db) => (await db.query('SELECT count(*)::int AS n FROM public.car_documents')).rows[0].n
const acl = async (db) => (await db.query(`SELECT relacl::text AS a FROM pg_class WHERE oid = 'public.car_documents'::regclass`)).rows[0].a

describe('migration 693 — car_documents.storage_path is unique', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('BEFORE: a second row on the same storage_path inserts (the finalise race files two documents)', async () => {
    db = await boot()
    await run(db, insertPath(`${CAR}/invoice/1-a.pdf`))
    expect(await rowCount(db)).toBe(4)
  })

  it('AFTER: a second row on a path fails 23505 on the new index; other paths insert; rows and grants are kept', async () => {
    db = await boot()
    const aclBefore = await acl(db)
    expect(await abortMessage(db, MIG_693)).toBeNull()
    expect(await rowCount(db)).toBe(3)
    expect(await acl(db)).toBe(aclBefore)
    expect(await indexes(db)).toContainEqual({
      indexname: 'car_documents_storage_path_key',
      indexdef: 'CREATE UNIQUE INDEX car_documents_storage_path_key ON public.car_documents USING btree (storage_path)',
    })
    let err
    try { await db.query(insertPath(`${CAR}/invoice/1-a.pdf`)) } catch (e) { err = e }
    expect(err?.code).toBe('23505')
    expect(String(err?.message)).toMatch(/car_documents_storage_path_key/)
    await db.query(insertPath(`${CAR}/invoice/4-d.pdf`))
    expect(await rowCount(db)).toBe(4)
  })

  it('aborts WHOLE and creates nothing when two rows already share a path', async () => {
    db = await boot(insertPath(`${CAR}/invoice/2-b.pdf`))
    const before = await indexes(db)
    expect(await abortMessage(db, MIG_693)).toMatch(/mig 693: 1 storage_path value\(s\) on public\.car_documents are held by more than one row/)
    expect(await indexes(db)).toEqual(before)
  })

  it('aborts when an index already holds the name with another definition', async () => {
    db = await boot('CREATE INDEX car_documents_storage_path_key ON public.car_documents (storage_path);')
    expect(await abortMessage(db, MIG_693)).toMatch(/mig 693: public\.car_documents_storage_path_key is not a valid unique index on exactly \(storage_path\)/)
  })

  it('aborts when an index already holds the name on more columns', async () => {
    db = await boot('CREATE UNIQUE INDEX car_documents_storage_path_key ON public.car_documents (car_id, storage_path);')
    expect(await abortMessage(db, MIG_693)).toMatch(/mig 693: public\.car_documents_storage_path_key is not a valid unique index on exactly \(storage_path\)/)
  })

  it('a second run passes; the rollback record restores the before-state', async () => {
    db = await boot()
    const before = await indexes(db)
    expect(await abortMessage(db, MIG_693)).toBeNull()
    expect(await abortMessage(db, MIG_693)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_693)).toBeNull()
    expect(await indexes(db)).toEqual(before)
    await db.query(insertPath(`${CAR}/invoice/1-a.pdf`))
    expect(await rowCount(db)).toBe(4)
  })
})
