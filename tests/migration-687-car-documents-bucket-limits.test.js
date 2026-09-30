// CARDOCBUCKET.1 — behavioural test for migration 687.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with the same model of
// Supabase's storage schema as tests/migration-675-branding-bucket-client-
// writes-off.test.js (copied, not imported: importing a test file would
// re-register its tests): storage.buckets and storage.objects owned by
// supabase_storage_admin, RLS on, the live grants, storage.protect_delete
// verbatim, the live restrictive deny (mig 403) and one other policy
// verbatim from pg_policies (30 Sep 2026), and the live bucket rows this
// file could touch or must not. The car-documents bucket holds three
// objects shaped like prod's: two document uploads and one saved Xero
// invoice PDF under cars/ (fictional ids and names; the repo is public).
//
// What PGlite cannot model: the Storage API, which is what enforces
// file_size_limit and allowed_mime_types at upload time. That enforcement
// is covered by the route test (the route refuses first), the guard, and
// the plan's live checks. It proves:
//   * BEFORE: the bucket has no limits; a client session is refused by the
//     restrictive deny;
//   * AFTER: the bucket has exactly the src/lib/car-document-media.js
//     limits, stays private, keeps every object, every other bucket and
//     every policy; clients are still refused; the service role still
//     writes and removes;
//   * the self-check aborts the WHOLE file on a missing bucket, a public
//     bucket, another size or MIME list, an object deleted by the file, a
//     change to another bucket or to any storage.objects policy; a second
//     run passes; the plan's rollback record restores the before-state.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { CAR_DOCUMENT_MIME_TYPES, CAR_DOCUMENT_MAX_BYTES } from '../src/lib/car-document-media.js'

const MIG_687 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/687_car_documents_bucket_limits.sql'), 'utf8')

// The rollback record from the C102 plan (Task 7 Step 6), verbatim.
const ROLLBACK_687 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id = 'car-documents';
COMMIT;
`

const MEMBER = '20000000-0000-0000-0000-000000000001'
const CAR = 'c0000000-0000-0000-0000-000000000001'
const BUCKET = 'car-documents'
const RLS_INSERT = /new row violates row-level security policy for table "objects"/

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE supabase_storage_admin NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;
  GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  GRANT EXECUTE ON FUNCTION private.auth_is_master() TO authenticated, service_role;

  CREATE TABLE storage.buckets (
    id text PRIMARY KEY,
    name text NOT NULL,
    owner uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    public boolean DEFAULT false,
    avif_autodetection boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text
  );
  CREATE TABLE storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id),
    name text,
    owner uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    last_accessed_at timestamptz DEFAULT now(),
    metadata jsonb,
    version text,
    owner_id text,
    user_metadata jsonb
  );
  CREATE UNIQUE INDEX objects_bucket_name ON storage.objects (bucket_id, name);
  ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
  ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
  ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;

  CREATE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
      IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
          RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
              USING HINT = 'This prevents accidental data loss from orphaned objects.',
                    ERRCODE = '42501';
      END IF;
      RETURN NULL;
  END;
  $$;
  CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects
    FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
`

// storage.objects policies, verbatim from pg_policies (30 Sep 2026, after 675).
const PROD_POLICIES = `
  CREATE POLICY "private buckets deny client" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]))
    WITH CHECK (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]));
  CREATE POLICY "Master reads all signed PDFs" ON storage.objects FOR SELECT TO authenticated
    USING ((bucket_id = 'contracts'::text) AND private.auth_is_master());
`

const SEED = `
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
    ('car-documents', 'car-documents', false, NULL, NULL),
    ('bca-documents', 'bca-documents', false, 26214400, ARRAY['application/pdf','image/jpeg','image/png','image/webp']),
    ('branding', 'branding', true, 209715200, ARRAY['image/png','image/jpeg','image/webp','image/svg+xml','image/x-icon','image/vnd.microsoft.icon','video/mp4','video/webm','video/quicktime']),
    ('contracts', 'contracts', false, NULL, NULL);
  INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
    ('car-documents', '${CAR}/other/1-abc123-invoice.pdf', '{"mimetype":"application/pdf","size":1000}'),
    ('car-documents', '${CAR}/other/2-def456-photo.jpg', '{"mimetype":"image/jpeg","size":900}'),
    ('car-documents', 'cars/${CAR}/xero-invoice-INV-0001.pdf', '{"mimetype":"application/pdf","size":800}');
`

let db
const runSql = (text) => db['exec'](text)

async function as(claims, sql, { storageApiDelete = false } = {}) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    if (storageApiDelete) await db.query(`SELECT set_config('storage.allow_delete_query', 'true', true)`)
    await runSql(`SET LOCAL ROLE ${claims.role}`)
    const r = await db.query(sql)
    return { rows: r.rows, affectedRows: r.affectedRows ?? 0 }
  } finally {
    await runSql('ROLLBACK')
  }
}
const member = { sub: MEMBER, role: 'authenticated' }
const anonymous = { role: 'anon' }
const service = { role: 'service_role' }
const uploadSql = (name = `${CAR}/other/3-ghi789-new.pdf`) =>
  `INSERT INTO storage.objects (bucket_id, name, owner, metadata)
   VALUES ('${BUCKET}', '${name}', auth.uid(), '{"mimetype":"application/pdf","size":1000}')`

async function bucket(id = BUCKET) {
  const { rows } = await db.query(
    `SELECT public, file_size_limit::text AS file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1`, [id])
  return rows[0]
}
async function allBuckets() {
  return (await db.query(
    `SELECT id, public, file_size_limit::text AS file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY id`)).rows
}
async function objectNames() {
  return (await db.query(`SELECT name FROM storage.objects WHERE bucket_id = $1 ORDER BY name`, [BUCKET])).rows.map((r) => r.name)
}
async function storagePolicies() {
  return (await db.query(
    `SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname`)).rows
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_687)
}

describe('before 687 (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the bucket is private with no size or type limit', async () => {
    expect(await bucket()).toEqual({ public: false, file_size_limit: null, allowed_mime_types: null })
  })

  it('clients are already refused by the restrictive deny (mig 403)', async () => {
    await expect(as(member, uploadSql())).rejects.toThrow(RLS_INSERT)
    await expect(as(anonymous, uploadSql())).rejects.toThrow(RLS_INSERT)
  })
})

describe('after 687', () => {
  let bucketsBefore, policiesBefore
  beforeAll(async () => {
    await boot()
    bucketsBefore = await allBuckets()
    policiesBefore = await storagePolicies()
    await runSql(MIG_687)
  }, 60_000)
  afterAll(() => db?.close())

  it('the bucket has exactly the src/lib/car-document-media.js limits and stays private', async () => {
    const b = await bucket()
    expect(b).toEqual({
      public: false,
      file_size_limit: '26214400',
      allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'],
    })
    expect(Number(b.file_size_limit)).toBe(CAR_DOCUMENT_MAX_BYTES)
    expect([...b.allowed_mime_types].sort()).toEqual([...CAR_DOCUMENT_MIME_TYPES].sort())
  })

  it('keeps every object, the saved Xero invoice PDF included (nothing deleted)', async () => {
    expect(await objectNames()).toEqual([
      `${CAR}/other/1-abc123-invoice.pdf`, `${CAR}/other/2-def456-photo.jpg`, `cars/${CAR}/xero-invoice-INV-0001.pdf`,
    ])
  })

  it('other buckets and every storage.objects policy are untouched', async () => {
    const others = (rows) => rows.filter((r) => r.id !== BUCKET)
    expect(others(await allBuckets())).toEqual(others(bucketsBefore))
    expect(await storagePolicies()).toEqual(policiesBefore)
  })

  it('clients are still refused; the service role still uploads and removes', async () => {
    await expect(as(member, uploadSql())).rejects.toThrow(RLS_INSERT)
    await expect(as(anonymous, uploadSql())).rejects.toThrow(RLS_INSERT)
    expect((await as(service, uploadSql())).affectedRows).toBe(1)
    expect((await as(service, `DELETE FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${CAR}/other/1-abc123-invoice.pdf'`,
      { storageApiDelete: true })).affectedRows).toBe(1)
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })
  // The end of the UPDATE (unique: the self-check's own WHERE lines end differently).
  const NEEDLE = "'image/heic', 'image/heif']\n WHERE id = 'car-documents';\n"

  async function expectAbort(before, message, sql = MIG_687) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const b = await bucket()
    if (b) expect(b.file_size_limit).toBeNull()
  }

  it('when the bucket row is missing (the UPDATE would silently match nothing)', () => expectAbort(
    `SELECT set_config('storage.allow_delete_query', 'true', false);
     DELETE FROM storage.objects WHERE bucket_id = 'car-documents'; DELETE FROM storage.buckets WHERE id = 'car-documents';`,
    /mig 687: bucket car-documents is missing/,
  ), 60_000)

  it('when the bucket has been made public (it holds buyer invoices)', () => expectAbort(
    `UPDATE storage.buckets SET public = true WHERE id = 'car-documents';`,
    /mig 687: bucket car-documents must stay private/,
  ), 60_000)

  it('when the file would set a different size limit', () => {
    const LIMIT = 'SET file_size_limit = 26214400,'
    expect(MIG_687.split(LIMIT).length).toBe(2)
    return expectAbort('', /mig 687: bucket car-documents file_size_limit is 5242880, expected 26214400/,
      MIG_687.replace(LIMIT, 'SET file_size_limit = 5242880,'))
  }, 60_000)

  it('when the file would set a different MIME list', () => {
    const LIST_END = "'image/heic', 'image/heif']"
    expect(MIG_687.split(LIST_END).length).toBe(2)   // the UPDATE's list only (the self-check lists its own sorted)
    return expectAbort('', /mig 687: bucket car-documents allowed_mime_types is/,
      MIG_687.replace(LIST_END, "'image/heic', 'image/svg+xml']"))
  }, 60_000)

  it('when the file would delete an object (Richard: keep them all)', () => {
    expect(MIG_687.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 687: the bucket held 3 objects and now holds 2/,
      MIG_687.replace(NEEDLE, `${NEEDLE}SELECT set_config('storage.allow_delete_query', 'true', true);
DELETE FROM storage.objects WHERE bucket_id = 'car-documents' AND name LIKE 'cars/%';\n`))
  }, 60_000)

  it('when the file would change another bucket', () => {
    return expectAbort('', /mig 687: other buckets changed: bca-documents/,
      MIG_687.replace(NEEDLE, `${NEEDLE}UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'bca-documents';\n`))
  }, 60_000)

  it('when the file would change a storage.objects policy', () => {
    return expectAbort('', /mig 687: storage\.objects policies changed: Master reads all signed PDFs/,
      MIG_687.replace(NEEDLE, `${NEEDLE}DROP POLICY "Master reads all signed PDFs" ON storage.objects;\n`))
  }, 60_000)

  it('when the restrictive deny no longer lists the bucket', () => expectAbort(
    `DROP POLICY "private buckets deny client" ON storage.objects;
     CREATE POLICY "private buckets deny client" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
       USING (bucket_id <> ALL (ARRAY['inbound-invoices'::text]))
       WITH CHECK (bucket_id <> ALL (ARRAY['inbound-invoices'::text]));`,
    /mig 687: the restrictive "private buckets deny client" policy no longer covers car-documents/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_687)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep bucket exactly, objects untouched', async () => {
    await boot()
    const before = await allBuckets()
    const names = await objectNames()
    await runSql(MIG_687)
    await runSql(ROLLBACK_687)
    expect(await allBuckets()).toEqual(before)
    expect(await objectNames()).toEqual(names)
  }, 60_000)
})
