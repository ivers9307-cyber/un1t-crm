// BRANDINGBUCKET.1 — behavioural test for migration 675.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with a model of Supabase's
// storage schema: storage.buckets and storage.objects (the columns the
// policies and this file read), owned by supabase_storage_admin, RLS on,
// the live grants (arwdDxtm to anon, authenticated and service_role;
// service_role BYPASSRLS), storage.protect_delete verbatim, a unique
// (bucket_id, name) index (prod: idx_objects_current_version, the same
// columns WHERE archived_at IS NULL; modelled without the predicate so the
// Storage upsert's ON CONFLICT can name it), the live buckets this file could
// touch, and these storage.objects policies VERBATIM from pg_policies
// (30 Sep 2026, after migs 670/671): the mig 403 restrictive deny, the three
// branding policies and one contracts read policy. private.is_owner() is a
// STAND-IN: true for OWNER only (prod: profiles.role IN ('owner','master'),
// active, not tombstoned; no location). private.auth_is_master() is false.
// (Same model as tests/migration-671-tv-content-bucket-client-writes-off
// .test.js; copied, not imported, because importing a test file would
// re-register its tests here.)
//
// What PGlite cannot model: the Storage API itself (its size/MIME
// enforcement, which statements it sends) and supautils (prod's postgres
// drops storage.objects policies through supautils.policy_grants; PGlite runs
// as superuser). Both are covered by the plan's live checks. It proves:
//
//   * BEFORE: an owner at studio A inserts a new object under studio B's
//     prefix (an SVG, too) the way the Storage API's plain upload does (a
//     RETURNING-less INSERT); a signed-in member and anon cannot; the same
//     INSERT with RETURNING is refused; the owner cannot overwrite an
//     existing object (filtered UPDATE: 0 rows; the upsert's ON CONFLICT DO
//     UPDATE: refused), delete it or list the bucket, because no SELECT
//     policy admits it;
//   * one SELECT policy away: with a SELECT policy on the bucket the same
//     owner overwrites and deletes studio B's logo;
//   * AFTER: every client role is refused the insert, and a SELECT policy
//     added later arms nothing; the service role (every writer route) still
//     inserts, upserts, lists and deletes; the other buckets' policies and
//     limits are untouched; the bucket is still public with the
//     src/lib/branding-media.js limits;
//   * the self-check aborts the WHOLE file on a leftover client write
//     policy, a policy with no bucket restriction, a client SELECT on the
//     bucket (mig 013's old public read), a missing bucket, a private
//     bucket, another size or MIME list, or a change to any other policy; a
//     second run passes; the plan's rollback record restores the before-state
//     exactly.
// Fictional ids and object names only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { BRANDING_BUCKET_MIME_TYPES, BRANDING_BUCKET_MAX_BYTES } from '../src/lib/branding-media.js'

const MIG_675 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/675_branding_bucket_client_writes_off.sql'), 'utf8')

// The rollback record from the C100 plan (Task 6 Step 7), verbatim.
const ROLLBACK_675 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE POLICY "Owners can upload branding" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());
CREATE POLICY "Owners can update branding" ON storage.objects
  FOR UPDATE TO authenticated USING ((bucket_id = 'branding'::text) AND private.is_owner());
CREATE POLICY "Owners can delete branding" ON storage.objects
  FOR DELETE TO authenticated USING ((bucket_id = 'branding'::text) AND private.is_owner());
COMMIT;
`

const OWNER = '30000000-0000-0000-0000-000000000001'    // profiles.role = 'owner' (at studio A only)
const MEMBER = '20000000-0000-0000-0000-000000000001'   // signed in, no staff row
const STUDIO_B = 'a0000000-0000-0000-0000-00000000000b'
const OBJ_LOGO = `${STUDIO_B}/logo.png`                 // studio B's live logo (route-written, owner NULL)
const BUCKET = 'branding'
const RLS_INSERT = /new row violates row-level security policy for table "objects"/
const RLS_ANY = /violates row-level security policy/

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
  -- STAND-INS (prod: profile lookups). OWNER is an owner; nobody is a master.
  CREATE FUNCTION private.is_owner() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT coalesce(auth.uid() = '${OWNER}'::uuid, false)
  $$;
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  GRANT EXECUTE ON FUNCTION private.is_owner(), private.auth_is_master() TO authenticated, service_role;

  -- storage.buckets / storage.objects: the prod columns the policies and
  -- mig 675 read (information_schema, 30 Sep 2026), owned as on prod.
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

// storage.objects policies, verbatim from pg_policies (30 Sep 2026, after 670/671).
const PROD_POLICIES = `
  CREATE POLICY "private buckets deny client" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]))
    WITH CHECK (bucket_id <> ALL (ARRAY['inbound-invoices'::text, 'car-documents'::text, 'company-card-receipts'::text, 'contractor-invoices'::text, 'fte-expense-receipts'::text, 'issue-photos'::text, 'consultation-photos'::text, 'bca-documents'::text, 'hunted-invoices'::text, 'whatsapp-media'::text]));
  CREATE POLICY "Owners can upload branding" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Owners can update branding" ON storage.objects FOR UPDATE TO authenticated
    USING ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Owners can delete branding" ON storage.objects FOR DELETE TO authenticated
    USING ((bucket_id = 'branding'::text) AND private.is_owner());
  CREATE POLICY "Master reads all signed PDFs" ON storage.objects FOR SELECT TO authenticated
    USING ((bucket_id = 'contracts'::text) AND private.auth_is_master());
`

// Live bucket rows (30 Sep 2026, after 670/671) this file could touch or must not.
const SEED = `
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
    ('branding', 'branding', true, 209715200, ARRAY['image/png','image/jpeg','image/webp','image/svg+xml','image/x-icon','image/vnd.microsoft.icon','video/mp4','video/webm','video/quicktime']),
    ('tv-content', 'tv-content', true, 15728640, ARRAY['image/png','image/jpeg','image/webp','image/gif','image/avif']),
    ('whatsapp-templates', 'whatsapp-templates', true, 104857600, ARRAY['image/jpeg','image/png','video/mp4','video/3gpp','application/pdf']),
    ('contracts', 'contracts', false, NULL, NULL),
    ('whatsapp-media', 'whatsapp-media', false, NULL, NULL);
  -- Studio B's logo as the settings route stored it (owner NULL, as all 59 live objects).
  INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('branding', '${OBJ_LOGO}', '{"mimetype":"image/png","size":1000}');
`

// A SELECT policy on the bucket: what would arm the UPDATE/DELETE policies.
const READ_POLICY = `CREATE POLICY branding_list_for_test ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'branding');`

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
const owner = { sub: OWNER, role: 'authenticated' }
const member = { sub: MEMBER, role: 'authenticated' }
const anonymous = { role: 'anon' }
const service = { role: 'service_role' }

// The Storage API's plain upload (storage src/storage/database: createObject):
// an INSERT with no RETURNING. Default: an SVG under ANOTHER studio's prefix.
const uploadSql = (bucket = BUCKET, name = `${STUDIO_B}/logo.svg`) =>
  `INSERT INTO storage.objects (bucket_id, name, owner, metadata)
   VALUES ('${bucket}', '${name}', auth.uid(), '{"mimetype":"image/svg+xml","size":52428800}')`
// The Storage API's upsert: INSERT … ON CONFLICT DO UPDATE on (bucket_id, name).
const upsertSql = (name = OBJ_LOGO) =>
  `INSERT INTO storage.objects (bucket_id, name, owner, metadata)
   VALUES ('${BUCKET}', '${name}', auth.uid(), '{"mimetype":"image/svg+xml","size":1000}')
   ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = excluded.metadata, owner = excluded.owner`
const overwriteSql = `UPDATE storage.objects SET metadata = '{"mimetype":"image/svg+xml"}' WHERE bucket_id = '${BUCKET}' AND name = '${OBJ_LOGO}'`
const deleteSql = `DELETE FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${OBJ_LOGO}' RETURNING *`
const listSql = `SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}'`

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
  if (migrate) await runSql(MIG_675)
}

describe('before 675 — the hole (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it("an owner at one studio uploads into ANOTHER studio's area of the public bucket, an SVG included", async () => {
    expect((await as(owner, uploadSql())).affectedRows).toBe(1)
    expect((await as(owner, uploadSql(BUCKET, `race-hero/${STUDIO_B}/x.mp4`))).affectedRows).toBe(1)
  })

  it('a signed-in member and anon cannot (is_owner() is false for them)', async () => {
    await expect(as(member, uploadSql())).rejects.toThrow(RLS_INSERT)
    await expect(as(anonymous, uploadSql())).rejects.toThrow(RLS_INSERT)
  })

  it('…the same INSERT with RETURNING is refused: no SELECT policy sees the new row', async () => {
    await expect(as(owner, `${uploadSql()} RETURNING *`)).rejects.toThrow(RLS_ANY)
  })

  it("…and the owner cannot overwrite studio B's logo: a filtered UPDATE sees 0 rows, the upsert is refused", async () => {
    expect((await as(owner, overwriteSql)).affectedRows).toBe(0)
    await expect(as(owner, upsertSql())).rejects.toThrow(RLS_ANY)
  })

  it('…nor delete it, nor list the bucket', async () => {
    expect((await as(owner, deleteSql, { storageApiDelete: true })).affectedRows).toBe(0)
    expect((await as(owner, listSql)).rows).toEqual([])
  })

  it('the bucket is public with the src/lib/branding-media.js limits already (mig 252)', async () => {
    const b = await bucket()
    expect(b.public).toBe(true)
    expect(Number(b.file_size_limit)).toBe(BRANDING_BUCKET_MAX_BYTES)
    expect([...b.allowed_mime_types].sort()).toEqual([...BRANDING_BUCKET_MIME_TYPES].sort())
  })
})

describe('before 675 — one SELECT policy away', () => {
  beforeAll(() => boot({ before: READ_POLICY }), 60_000)
  afterAll(() => db?.close())

  it("with any SELECT policy on the bucket, the owner overwrites and deletes studio B's logo", async () => {
    expect((await as(owner, overwriteSql)).affectedRows).toBe(1)
    expect((await as(owner, upsertSql())).affectedRows).toBe(1)
    expect((await as(owner, deleteSql, { storageApiDelete: true })).affectedRows).toBe(1)
  })
})

describe('after 675', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['an owner', owner], ['a signed-in member', member], ['anon', anonymous]])(
    '%s can no longer upload into the bucket', async (_who, claims) => {
      await expect(as(claims, uploadSql())).rejects.toThrow(RLS_INSERT)
    })

  it('the service role (every writer route) still inserts, upserts, lists and removes', async () => {
    expect((await as(service, uploadSql(BUCKET, `landing-page/${STUDIO_B}/c0000000-0000-0000-0000-000000000002.jpg`))).affectedRows).toBe(1)
    expect((await as(service, upsertSql())).affectedRows).toBe(1)
    expect((await as(service, listSql)).rows).toEqual([{ name: OBJ_LOGO }])
    expect((await as(service, deleteSql, { storageApiDelete: true })).affectedRows).toBe(1)
  })

  it('the bucket stays public, with exactly the src/lib/branding-media.js limits', async () => {
    const b = await bucket()
    expect(b).toEqual({
      public: true,
      file_size_limit: '209715200',
      allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon',
        'image/vnd.microsoft.icon', 'video/mp4', 'video/webm', 'video/quicktime'],
    })
    expect(Number(b.file_size_limit)).toBe(BRANDING_BUCKET_MAX_BYTES)
    expect([...b.allowed_mime_types].sort()).toEqual([...BRANDING_BUCKET_MIME_TYPES].sort())
  })

  it('other buckets and their policies are untouched', async () => {
    expect(await bucket('tv-content')).toEqual({
      public: true, file_size_limit: '15728640',
      allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'],
    })
    expect((await bucket('whatsapp-templates')).file_size_limit).toBe('104857600')
    await expect(as(owner, uploadSql('tv-content', 'x/y.png'))).rejects.toThrow(RLS_INSERT)
    await expect(as(owner, uploadSql('whatsapp-media', 'x/y.png'))).rejects.toThrow(RLS_INSERT)
    expect((await storagePolicies()).map((p) => p.policyname)).toEqual([
      'Master reads all signed PDFs', 'private buckets deny client',
    ])
  })
})

describe('after 675 — a SELECT policy added later arms nothing', () => {
  beforeAll(async () => { await boot({ migrate: true }); await runSql(READ_POLICY) }, 60_000)
  afterAll(() => db?.close())

  it('the owner still cannot upload, overwrite or delete', async () => {
    await expect(as(owner, uploadSql())).rejects.toThrow(RLS_INSERT)
    expect((await as(owner, overwriteSql)).affectedRows).toBe(0)
    expect((await as(owner, deleteSql, { storageApiDelete: true })).affectedRows).toBe(0)
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_675) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await storagePolicies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['Owners can upload branding', 'Owners can update branding', 'Owners can delete branding']))
    expect((await as(owner, uploadSql())).affectedRows).toBe(1)
  }

  it('when another client write policy on the bucket is left', () => expectAbort(
    `CREATE POLICY branding_update_again ON storage.objects FOR UPDATE TO authenticated
       USING (bucket_id = 'branding');`,
    /mig 675: client policies on storage\.objects admit the branding bucket: branding_update_again UPDATE/,
  ), 60_000)

  it('when a client policy has no bucket restriction at all (it admits every bucket)', () => expectAbort(
    `CREATE POLICY anyone_uploads ON storage.objects FOR INSERT TO public WITH CHECK (true);`,
    /mig 675: client policies on storage\.objects admit the branding bucket: anyone_uploads INSERT/,
  ), 60_000)

  it("when a client SELECT policy would list the bucket (mig 013's old public read)", () => expectAbort(
    `CREATE POLICY "Public read access for branding" ON storage.objects FOR SELECT
       USING (bucket_id = 'branding');`,
    /mig 675: client policies on storage\.objects admit the branding bucket: Public read access for branding SELECT/,
  ), 60_000)

  it('when the bucket row is missing (the UPDATE would silently match nothing)', async () => {
    await boot({ before: `SELECT set_config('storage.allow_delete_query', 'true', false);
      DELETE FROM storage.objects; DELETE FROM storage.buckets WHERE id = 'branding';` })
    await expect(runSql(MIG_675)).rejects.toThrow(/mig 675: bucket branding is missing/)
    await runSql('ROLLBACK')
    expect((await storagePolicies()).map((p) => p.policyname)).toContain('Owners can upload branding')
  }, 60_000)

  it('when the file would make the bucket private (pages and emails load it by URL)', () => {
    const NEEDLE = '   SET public = true,'
    expect(MIG_675.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 675: bucket branding must stay public/, MIG_675.replace(NEEDLE, '   SET public = false,'))
  }, 60_000)

  it('when the file would set a different size limit', () => {
    const NEEDLE = 'file_size_limit = 209715200,'
    expect(MIG_675.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 675: bucket branding file_size_limit is 52428800, expected 209715200/,
      MIG_675.replace(NEEDLE, 'file_size_limit = 52428800,'))
  }, 60_000)

  it('when the file would set a different MIME list', () => {
    const NEEDLE = "'video/mp4', 'video/webm', 'video/quicktime']"
    expect(MIG_675.split(NEEDLE).length).toBe(2)   // the UPDATE's list only (the self-check lists its own sorted)
    return expectAbort('', /mig 675: bucket branding allowed_mime_types is/,
      MIG_675.replace(NEEDLE, "'video/mp4', 'video/webm', 'image/gif']"))
  }, 60_000)

  it('when the file would drop any other storage.objects policy', () => {
    const NEEDLE = 'DROP POLICY IF EXISTS "Owners can delete branding" ON storage.objects;\n'
    expect(MIG_675.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 675: other storage\.objects policies changed: Master reads all signed PDFs/,
      MIG_675.replace(NEEDLE, `${NEEDLE}DROP POLICY "Master reads all signed PDFs" ON storage.objects;\n`))
  }, 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_675)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep policies and bucket exactly (and so the hole)', async () => {
    await boot()
    const policiesBefore = await storagePolicies()
    const bucketBefore = await bucket()
    await runSql(MIG_675)
    await runSql(ROLLBACK_675)
    // pg_policies renders the re-created policies the same way as the live ones
    expect(await storagePolicies()).toEqual(policiesBefore)
    expect(await bucket()).toEqual(bucketBefore)
    expect((await as(owner, uploadSql())).affectedRows).toBe(1)
  }, 60_000)
})
