// TVBUCKET.1 — behavioural test for migration 671.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with a model of Supabase's
// storage schema: storage.buckets and storage.objects (the columns the
// policies and this file read), owned by supabase_storage_admin, RLS on,
// the live grants (arwdDxtm to anon, authenticated and service_role;
// service_role BYPASSRLS), storage.protect_delete verbatim, the live
// buckets this file could touch, and these storage.objects policies
// VERBATIM from pg_policies (30 Sep 2026, after mig 670): the mig 403
// restrictive deny, the two tv_content_storage_* policies, the three
// branding policies and one contracts read policy. private.is_owner() and
// private.auth_is_master() are STAND-INS (false for everyone here).
// (Same model as tests/migration-670-whatsapp-templates-bucket-client-
// writes-off.test.js; the schema block is copied, not imported, because
// importing a test file would re-register its tests here.)
//
// What PGlite cannot model: the Storage API itself (its size/MIME
// enforcement) and supautils (prod's postgres drops storage.objects
// policies through supautils.policy_grants; PGlite runs as superuser). Both
// are covered by the plan's live checks. It proves:
//
//   * BEFORE: a signed-in account with no staff row (a member-app
//     customer) inserts an arbitrary object into the bucket the way the
//     Storage API's plain upload does (a RETURNING-less INSERT); the same
//     INSERT with RETURNING is refused (no SELECT policy sees the new row:
//     why the browser upload of May failed, c944c9aa); the session can
//     neither overwrite nor delete an existing object; anon cannot insert;
//     the bucket has no size or type limit;
//   * AFTER: that insert is refused by RLS, for every client role; the
//     service role (the upload route) still inserts, reads and deletes;
//     the other buckets' policies are untouched (whatsapp-templates stays
//     closed with mig 670's limits); the bucket is still public with the
//     src/lib/tv-media.js limits;
//   * the self-check aborts the WHOLE file on a leftover client write
//     policy, a policy with no bucket restriction, a client SELECT on the
//     bucket, a missing bucket, a private bucket, another MIME list, or a
//     change to any other policy; a second run passes; the plan's rollback
//     record restores the before-state exactly.
// Fictional ids and object names only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { TV_IMAGE_MIME_TYPES, TV_IMAGE_MAX_BYTES } from '../src/lib/tv-media.js'

const MIG_671 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/671_tv_content_bucket_client_writes_off.sql'), 'utf8')

// The rollback record from the C92 plan (Task 6 Step 7), verbatim.
const ROLLBACK_671 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE POLICY tv_content_storage_write ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');
CREATE POLICY tv_content_storage_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'tv-content');
UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL
 WHERE id = 'tv-content';
COMMIT;
`

const MEMBER = '20000000-0000-0000-0000-000000000001'   // signed in, no staff row
const COACH = '10000000-0000-0000-0000-000000000001'    // staff
const OBJ_EXISTING = 'a0000000-0000-0000-0000-00000000000a/templates/c0000000-0000-0000-0000-000000000001.png'
const BUCKET = 'tv-content'
const RLS_INSERT = /new row violates row-level security policy for table "objects"/

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE supabase_storage_admin NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;   -- as on prod
  GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  -- STAND-INS (prod: profile lookups). Nobody here is an owner or a master.
  CREATE FUNCTION private.is_owner() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  GRANT EXECUTE ON FUNCTION private.is_owner(), private.auth_is_master() TO authenticated, service_role;

  -- storage.buckets / storage.objects: the prod columns the policies and
  -- mig 671 read (information_schema, 30 Sep 2026), owned as on prod.
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
  ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
  ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
  ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;

  -- storage.protect_delete, verbatim (pg_proc, 30 Sep 2026). The Storage
  -- API sets storage.allow_delete_query before it deletes.
  CREATE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
      -- Check if storage.allow_delete_query is set to 'true'
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

// storage.objects policies, verbatim from pg_policies (30 Sep 2026, after 670).
const PROD_POLICIES = `
  CREATE POLICY "private buckets deny client" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]))
    WITH CHECK (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]));
  CREATE POLICY tv_content_storage_write ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'tv-content'::text);
  CREATE POLICY tv_content_storage_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'tv-content'::text);
  CREATE POLICY "Owners can upload branding" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Owners can update branding" ON storage.objects FOR UPDATE TO authenticated
    USING ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Owners can delete branding" ON storage.objects FOR DELETE TO authenticated
    USING ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Master reads all signed PDFs" ON storage.objects FOR SELECT TO authenticated
    USING ((bucket_id = 'contracts'::text) AND private.auth_is_master());
`

// Live bucket rows (30 Sep 2026, after 670) this file could touch or must not.
const SEED = `
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
    ('tv-content', 'tv-content', true, NULL, NULL),
    ('whatsapp-templates', 'whatsapp-templates', true, 104857600, ARRAY['image/jpeg','image/png','video/mp4','video/3gpp','application/pdf']),
    ('branding', 'branding', true, 209715200, ARRAY['image/png','image/jpeg','image/webp','image/svg+xml','image/x-icon','image/vnd.microsoft.icon','video/mp4','video/webm','video/quicktime']),
    ('contracts', 'contracts', false, NULL, NULL),
    ('whatsapp-media', 'whatsapp-media', false, NULL, NULL);
  -- A template base image the upload route stored (owner NULL, as all 22 live objects).
  INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('tv-content', '${OBJ_EXISTING}', '{"mimetype":"image/png","size":1000}');
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

/** Run `sql` with a JWT's claims and role in a rolled-back tx; returns { rows, affectedRows }. */
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
const coach = { sub: COACH, role: 'authenticated' }
const anonymous = { role: 'anon' }
const service = { role: 'service_role' }

// The Storage API's plain upload (storage src/storage/database/pg.ts
// createObject): an INSERT with no RETURNING.
const uploadSql = (bucket = BUCKET, name = 'anything/hosted.html') =>
  `INSERT INTO storage.objects (bucket_id, name, owner, metadata)
   VALUES ('${bucket}', '${name}', auth.uid(), '{"mimetype":"text/html","size":52428800}')`
const deleteSql = `DELETE FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${OBJ_EXISTING}' RETURNING *`
const overwriteSql = `UPDATE storage.objects SET metadata = '{"mimetype":"text/html"}' WHERE bucket_id = '${BUCKET}' AND name = '${OBJ_EXISTING}'`

async function storagePolicies() {
  const { rows } = await db.query(
    `SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname`)
  return rows
}
async function bucket(id = BUCKET) {
  const { rows } = await db.query(
    `SELECT public, file_size_limit::text AS file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1`, [id])
  return rows[0]
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_671)
}

describe('before 671 — the hole (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('a signed-in account with no staff row uploads an arbitrary file into the public bucket', async () => {
    expect((await as(member, uploadSql())).affectedRows).toBe(1)
    expect((await as(coach, uploadSql(BUCKET, 'x/y.exe'))).affectedRows).toBe(1)
  })

  it('…but the same INSERT with RETURNING is refused: no SELECT policy sees the new row (the May browser-upload failure)', async () => {
    await expect(as(member, `${uploadSql()} RETURNING *`)).rejects.toThrow(RLS_INSERT)
  })

  it('…and cannot overwrite or delete an existing object: no SELECT or UPDATE policy admits the bucket', async () => {
    expect((await as(member, overwriteSql)).affectedRows).toBe(0)
    expect((await as(member, deleteSql, { storageApiDelete: true })).affectedRows).toBe(0)
  })

  it('anon cannot upload (both policies are TO authenticated)', async () => {
    await expect(as(anonymous, uploadSql())).rejects.toThrow(RLS_INSERT)
  })

  it('the bucket has no size or type limit', async () => {
    expect(await bucket()).toEqual({ public: true, file_size_limit: null, allowed_mime_types: null })
  })
})

describe('after 671', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['a member-app customer', member], ['a staff member', coach], ['anon', anonymous]])(
    '%s can no longer upload into the bucket', async (_who, claims) => {
      await expect(as(claims, uploadSql())).rejects.toThrow(RLS_INSERT)
    })

  it('clients still cannot overwrite or delete', async () => {
    expect((await as(member, overwriteSql)).affectedRows).toBe(0)
    expect((await as(member, deleteSql, { storageApiDelete: true })).affectedRows).toBe(0)
  })

  it('the service role (the upload route) still writes, reads and removes', async () => {
    expect((await as(service, uploadSql(BUCKET, 'a0000000-0000-0000-0000-00000000000a/c0000000-0000-0000-0000-000000000002.jpg'))).affectedRows).toBe(1)
    expect((await as(service, `SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}'`)).rows).toEqual([{ name: OBJ_EXISTING }])
    expect((await as(service, deleteSql, { storageApiDelete: true })).affectedRows).toBe(1)
  })

  it('the bucket stays public, with exactly the src/lib/tv-media.js limits', async () => {
    const b = await bucket()
    expect(b).toEqual({
      public: true,
      file_size_limit: '15728640',
      allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'],
    })
    expect(Number(b.file_size_limit)).toBe(TV_IMAGE_MAX_BYTES)
    expect([...b.allowed_mime_types].sort()).toEqual([...TV_IMAGE_MIME_TYPES].sort())
  })

  it('other buckets and their policies are untouched', async () => {
    expect((await bucket('branding')).file_size_limit).toBe('209715200')
    expect(await bucket('whatsapp-templates')).toEqual({
      public: true, file_size_limit: '104857600',
      allowed_mime_types: ['image/jpeg', 'image/png', 'video/mp4', 'video/3gpp', 'application/pdf'],
    })
    await expect(as(member, uploadSql('whatsapp-templates', 'x/y.png'))).rejects.toThrow(RLS_INSERT)
    await expect(as(member, uploadSql('whatsapp-media', 'x/y.png'))).rejects.toThrow(RLS_INSERT)
    expect((await storagePolicies()).map((p) => p.policyname)).toEqual([
      'Master reads all signed PDFs', 'Owners can delete branding', 'Owners can update branding',
      'Owners can upload branding', 'private buckets deny client',
    ])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_671) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await storagePolicies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['tv_content_storage_write', 'tv_content_storage_delete']))
    expect((await as(member, uploadSql())).affectedRows).toBe(1)
  }

  it('when another client write policy on the bucket is left', () => expectAbort(
    `CREATE POLICY tv_content_storage_update ON storage.objects FOR UPDATE TO authenticated
       USING (bucket_id = 'tv-content');`,
    /mig 671: client policies on storage\.objects admit the tv-content bucket: tv_content_storage_update UPDATE/,
  ), 60_000)

  it('when a client policy has no bucket restriction at all (it admits every bucket)', () => expectAbort(
    `CREATE POLICY anyone_uploads ON storage.objects FOR INSERT TO public WITH CHECK (true);`,
    /mig 671: client policies on storage\.objects admit the tv-content bucket: anyone_uploads INSERT/,
  ), 60_000)

  it('when a client SELECT policy would let sessions list the bucket', () => expectAbort(
    `CREATE POLICY tv_content_list ON storage.objects FOR SELECT TO authenticated
       USING (bucket_id = 'tv-content');`,
    /mig 671: client policies on storage\.objects admit the tv-content bucket: tv_content_list SELECT/,
  ), 60_000)

  it('when the bucket row is missing (the UPDATE would silently match nothing)', async () => {
    await boot({ before: `SELECT set_config('storage.allow_delete_query', 'true', false);
      DELETE FROM storage.objects; DELETE FROM storage.buckets WHERE id = 'tv-content';` })
    await expect(runSql(MIG_671)).rejects.toThrow(/mig 671: bucket tv-content is missing/)
    await runSql('ROLLBACK')
    expect((await storagePolicies()).map((p) => p.policyname)).toContain('tv_content_storage_write')
  }, 60_000)

  it('when the file would make the bucket private (TVs load images by public URL)', () => {
    const NEEDLE = '   SET public = true,'
    expect(MIG_671.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 671: bucket tv-content must stay public/, MIG_671.replace(NEEDLE, '   SET public = false,'))
  }, 60_000)

  it('when the file would set a different size limit', () => {
    const NEEDLE = 'file_size_limit = 15728640,'
    expect(MIG_671.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 671: bucket tv-content file_size_limit is 52428800, expected 15728640/,
      MIG_671.replace(NEEDLE, 'file_size_limit = 52428800,'))
  }, 60_000)

  it('when the file would set a different MIME list', () => {
    const NEEDLE = "'image/gif', 'image/avif']"
    expect(MIG_671.split(NEEDLE).length).toBe(2)   // the UPDATE's list only (the self-check lists its own sorted)
    return expectAbort('', /mig 671: bucket tv-content allowed_mime_types is/, MIG_671.replace(NEEDLE, "'image/gif', 'image/svg+xml']"))
  }, 60_000)

  it('when the file would drop any other storage.objects policy', () => {
    const NEEDLE = 'DROP POLICY IF EXISTS tv_content_storage_delete ON storage.objects;\n'
    expect(MIG_671.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 671: other storage\.objects policies changed: Owners can delete branding/,
      MIG_671.replace(NEEDLE, `${NEEDLE}DROP POLICY "Owners can delete branding" ON storage.objects;\n`))
  }, 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_671)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep policies and bucket exactly (and so the hole)', async () => {
    await boot()
    const policiesBefore = await storagePolicies()
    const bucketBefore = await bucket()
    await runSql(MIG_671)
    await runSql(ROLLBACK_671)
    // pg_policies renders the re-created policies the same way as the live ones
    expect(await storagePolicies()).toEqual(policiesBefore)
    expect(await bucket()).toEqual(bucketBefore)
    expect((await as(member, uploadSql())).affectedRows).toBe(1)
  }, 60_000)
})
