// WATPLBUCKET.1 — behavioural test for migration 670.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with a model of Supabase's
// storage schema: storage.buckets and storage.objects (the columns the
// policies and this file read), owned by supabase_storage_admin, RLS on,
// the live grants (arwdDxtm to anon, authenticated and service_role;
// service_role BYPASSRLS), storage.protect_delete verbatim, the live
// buckets this file could touch, and these storage.objects policies
// VERBATIM from pg_policies (30 Sep 2026): the mig 403 restrictive deny,
// the two wa_templates_storage_* policies, the branding and tv-content
// write policies and one contracts read policy. private.is_owner() and
// private.auth_is_master() are STAND-INS (false for everyone here).
//
// What PGlite cannot model: the Storage API itself (its superuser signed
// upload, its size/MIME enforcement) and supautils (prod's postgres drops
// storage.objects policies through supautils.policy_grants; PGlite runs as
// superuser). Both are covered by the plan's live checks. It proves:
//
//   * BEFORE: a signed-in account with no staff row (a member-app
//     customer) inserts an arbitrary object into the bucket; the same
//     session can neither overwrite nor delete an existing object (no
//     SELECT/UPDATE policy admits the bucket); anon cannot insert; the
//     bucket has no size or type limit;
//   * AFTER: that insert is refused by RLS, for every client role; the
//     service role (the finalise route's download/remove, and the Storage
//     API's superuser signed upload) still inserts and deletes; the other
//     buckets' policies are untouched; the bucket is still public with the
//     template-media limits;
//   * the self-check aborts the WHOLE file on a leftover client write
//     policy, a policy with no bucket restriction, a client SELECT on the
//     bucket, a missing bucket, a private bucket, or a change to any other
//     policy; a second run passes; the plan's rollback record restores the
//     before-state exactly.
// Fictional ids and object names only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_670 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/670_whatsapp_templates_bucket_client_writes_off.sql'), 'utf8')

// The rollback record from the C90 plan (Task 5 Step 7), verbatim.
const ROLLBACK_670 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE POLICY wa_templates_storage_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-templates');
CREATE POLICY wa_templates_storage_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'whatsapp-templates');
UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL
 WHERE id = 'whatsapp-templates';
COMMIT;
`

const MEMBER = '20000000-0000-0000-0000-000000000001'   // signed in, no staff row
const COACH = '10000000-0000-0000-0000-000000000001'    // staff
const OBJ_EXISTING = 'a0000000-0000-0000-0000-00000000000a/c0000000-0000-0000-0000-000000000001.mp4'
const BUCKET = 'whatsapp-templates'
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
  -- mig 670 read (information_schema, 30 Sep 2026), owned as on prod.
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

// storage.objects policies, verbatim from pg_policies (30 Sep 2026).
const PROD_POLICIES = `
  CREATE POLICY "private buckets deny client" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]))
    WITH CHECK (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]));
  CREATE POLICY wa_templates_storage_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'whatsapp-templates'::text);
  CREATE POLICY wa_templates_storage_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'whatsapp-templates'::text);
  CREATE POLICY "Owners can upload branding" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Owners can update branding" ON storage.objects FOR UPDATE TO authenticated
    USING ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Owners can delete branding" ON storage.objects FOR DELETE TO authenticated
    USING ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY tv_content_storage_write ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'tv-content'::text);
  CREATE POLICY tv_content_storage_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'tv-content'::text);
  CREATE POLICY "Master reads all signed PDFs" ON storage.objects FOR SELECT TO authenticated
    USING ((bucket_id = 'contracts'::text) AND private.auth_is_master());
`

// Live bucket rows (30 Sep 2026) this file could touch or must not.
const SEED = `
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
    ('whatsapp-templates', 'whatsapp-templates', true, NULL, NULL),
    ('branding', 'branding', true, 209715200, ARRAY['image/png','image/jpeg','image/webp','image/svg+xml','image/x-icon','image/vnd.microsoft.icon','video/mp4','video/webm','video/quicktime']),
    ('tv-content', 'tv-content', true, NULL, NULL),
    ('contracts', 'contracts', false, NULL, NULL),
    ('whatsapp-media', 'whatsapp-media', false, NULL, NULL);
  -- A header video the sign/finalise flow stored (owner NULL, as all 5 live objects).
  INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('whatsapp-templates', '${OBJ_EXISTING}', '{"mimetype":"video/mp4","size":1000}');
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

const uploadSql = (bucket = BUCKET, name = 'anything/hosted.html') =>
  `INSERT INTO storage.objects (bucket_id, name, owner, metadata)
   VALUES ('${bucket}', '${name}', auth.uid(), '{"mimetype":"text/html","size":52428800}')`
const deleteSql = `DELETE FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${OBJ_EXISTING}'`
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
  if (migrate) await runSql(MIG_670)
}

describe('before 670 — the hole (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('a signed-in account with no staff row uploads an arbitrary file into the public bucket', async () => {
    expect((await as(member, uploadSql())).affectedRows).toBe(1)
    expect((await as(coach, uploadSql(BUCKET, 'x/y.exe'))).affectedRows).toBe(1)
  })

  it('…but cannot overwrite or delete an existing object: no SELECT or UPDATE policy admits the bucket', async () => {
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

describe('after 670', () => {
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

  it('the service role still writes, reads and removes (finalise route; the Storage API runs signed uploads as superuser)', async () => {
    expect((await as(service, uploadSql(BUCKET, 'a0000000-0000-0000-0000-00000000000a/c0000000-0000-0000-0000-000000000002.png'))).affectedRows).toBe(1)
    expect((await as(service, `SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}'`)).rows).toEqual([{ name: OBJ_EXISTING }])
    expect((await as(service, deleteSql, { storageApiDelete: true })).affectedRows).toBe(1)
  })

  it('the bucket stays public, with the template-media limits', async () => {
    expect(await bucket()).toEqual({
      public: true,
      file_size_limit: '104857600',
      allowed_mime_types: ['image/jpeg', 'image/png', 'video/mp4', 'video/3gpp', 'application/pdf'],
    })
  })

  it('other buckets and their policies are untouched (tv-content keeps its client upload: follow-up F1)', async () => {
    expect((await bucket('branding')).file_size_limit).toBe('209715200')
    expect(await bucket('tv-content')).toEqual({ public: true, file_size_limit: null, allowed_mime_types: null })
    expect((await as(member, uploadSql('tv-content', 'x/y.png'))).affectedRows).toBe(1)
    await expect(as(member, uploadSql('whatsapp-media', 'x/y.png'))).rejects.toThrow(RLS_INSERT)
    expect((await storagePolicies()).map((p) => p.policyname)).toEqual([
      'Master reads all signed PDFs', 'Owners can delete branding', 'Owners can update branding',
      'Owners can upload branding', 'private buckets deny client', 'tv_content_storage_delete',
      'tv_content_storage_write',
    ])
  })
})

describe("a database built from the files: mig 183's never-applied fte policy", () => {
  // Mig 183's FILE text, verbatim. Prod never ran it (C90 plan §1).
  const FTE_183 = `create policy fte_expense_receipts_deny_all on storage.objects
    for all to authenticated
    using (bucket_id <> 'fte-expense-receipts')
    with check (bucket_id <> 'fte-expense-receipts');`
  afterAll(() => db?.close())

  it('admits the bucket on its own, and 670 drops it', async () => {
    await boot({ before: `${FTE_183}\nDROP POLICY wa_templates_storage_insert ON storage.objects;` })
    expect((await as(member, uploadSql())).affectedRows).toBe(1)   // through the fte policy alone
    await db.close()
    await boot({ before: FTE_183, migrate: true })
    await expect(as(member, uploadSql())).rejects.toThrow(RLS_INSERT)
    expect((await storagePolicies()).map((p) => p.policyname)).not.toContain('fte_expense_receipts_deny_all')
  }, 60_000)
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_670) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await storagePolicies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['wa_templates_storage_insert', 'wa_templates_storage_delete']))
    expect((await as(member, uploadSql())).affectedRows).toBe(1)
  }

  it('when another client write policy on the bucket is left', () => expectAbort(
    `CREATE POLICY wa_templates_storage_update ON storage.objects FOR UPDATE TO authenticated
       USING (bucket_id = 'whatsapp-templates');`,
    /mig 670: client policies on storage\.objects admit the whatsapp-templates bucket: wa_templates_storage_update UPDATE/,
  ), 60_000)

  it('when a client policy has no bucket restriction at all (it admits every bucket)', () => expectAbort(
    `CREATE POLICY anyone_uploads ON storage.objects FOR INSERT TO public WITH CHECK (true);`,
    /mig 670: client policies on storage\.objects admit the whatsapp-templates bucket: anyone_uploads INSERT/,
  ), 60_000)

  it('when a client SELECT policy would let sessions list the bucket', () => expectAbort(
    `CREATE POLICY wa_templates_list ON storage.objects FOR SELECT TO authenticated
       USING (bucket_id = 'whatsapp-templates');`,
    /mig 670: client policies on storage\.objects admit the whatsapp-templates bucket: wa_templates_list SELECT/,
  ), 60_000)

  it('when the bucket row is missing (the UPDATE would silently match nothing)', async () => {
    await boot({ before: `SELECT set_config('storage.allow_delete_query', 'true', false);
      DELETE FROM storage.objects; DELETE FROM storage.buckets WHERE id = 'whatsapp-templates';` })
    await expect(runSql(MIG_670)).rejects.toThrow(/mig 670: bucket whatsapp-templates is missing/)
    await runSql('ROLLBACK')
    expect((await storagePolicies()).map((p) => p.policyname)).toContain('wa_templates_storage_insert')
  }, 60_000)

  it('when the file would make the bucket private (Meta must keep fetching header media)', () => {
    const NEEDLE = '   SET public = true,'
    expect(MIG_670.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 670: bucket whatsapp-templates must stay public/, MIG_670.replace(NEEDLE, '   SET public = false,'))
  }, 60_000)

  it('when the file would set a different MIME list', () => {
    const NEEDLE = "'video/mp4', 'video/3gpp', "
    expect(MIG_670.split(NEEDLE).length).toBe(2)   // the UPDATE's list only (the self-check lists its own sorted)
    return expectAbort('', /mig 670: bucket whatsapp-templates allowed_mime_types is/, MIG_670.replace(NEEDLE, "'video/mp4', "))
  }, 60_000)

  it('when the file would drop any other storage.objects policy', () => {
    const NEEDLE = 'DROP POLICY IF EXISTS wa_templates_storage_delete ON storage.objects;\n'
    expect(MIG_670.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 670: other storage\.objects policies changed: tv_content_storage_write/,
      MIG_670.replace(NEEDLE, `${NEEDLE}DROP POLICY tv_content_storage_write ON storage.objects;\n`))
  }, 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_670)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep policies and bucket exactly (and so the hole)', async () => {
    await boot()
    const policiesBefore = await storagePolicies()
    const bucketBefore = await bucket()
    await runSql(MIG_670)
    await runSql(ROLLBACK_670)
    // pg_policies renders the re-created policies the same way as the live ones
    expect(await storagePolicies()).toEqual(policiesBefore)
    expect(await bucket()).toEqual(bucketBefore)
    expect((await as(member, uploadSql())).affectedRows).toBe(1)
  }, 60_000)
})
