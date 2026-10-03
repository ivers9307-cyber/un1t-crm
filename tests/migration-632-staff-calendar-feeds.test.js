// ICSFEED.1 — behavioural test for migration 632, against the REAL file.
//
// Same reason as the 613/618/622/624/628 replays: no local Supabase stack, so
// without this the DDL would get its first execution on prod. Boots PGlite,
// recreates the three API roles and Supabase's DEFAULT privileges (every new
// table in public is granted to anon, authenticated and service_role), applies
// the real 632 file, and proves the header's claims — above all that the
// browser roles end up with NOTHING on a table of secret-link hashes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_632 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/632_staff_calendar_feeds.sql'),
  'utf8',
)

const ME = '10000000-0000-0000-0000-00000000000a'
const OTHER = '10000000-0000-0000-0000-00000000000b'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  -- What Supabase does for every table created in public. The migration must
  -- undo it for the browser roles itself.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY,
    active boolean DEFAULT true,
    deleted_at timestamptz
  );
  INSERT INTO public.profiles (id) VALUES ('${ME}'), ('${OTHER}');
`

async function boot({ before = '' } = {}) {
  const pg = new PGlite()
  await pg.exec(BASE_SCHEMA)
  if (before) await pg.exec(before)
  return pg
}

let db
beforeAll(async () => {
  db = await boot()
  await db.exec(MIG_632)
}, 60_000)

afterAll(async () => { await db?.close() })

async function inTx(fn) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

describe('migration 632 — staff_calendar_feeds', () => {
  it('has exactly the documented shape', async () => {
    const { rows } = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_calendar_feeds' ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'last_fetched_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'profile_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'rotated_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'token_hash', data_type: 'text', is_nullable: 'NO' },
    ])
  })

  it('has RLS on and NO policies, so only the service role can reach it', async () => {
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass`)
    expect(rls.rows).toEqual([{ relrowsecurity: true }])
    const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass`)
    expect(pol.rows).toEqual([{ n: 0 }])
  })

  it('takes every privilege away from anon and authenticated, despite the default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await db.query(`SELECT has_table_privilege($1, 'public.staff_calendar_feeds', $2) AS ok`, [role, priv])
        expect(rows[0].ok, `${role} still holds ${priv}`).toBe(false)
      }
    }
  })

  it('the browser role is refused outright, not shown an empty table', async () => {
    await db.exec('SET ROLE authenticated')
    try {
      await expect(db.query('SELECT * FROM public.staff_calendar_feeds')).rejects.toThrow(/permission denied/)
    } finally {
      await db.exec('RESET ROLE')
    }
  })

  it('leaves the service role the four privileges the routes use', async () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const { rows } = await db.query(`SELECT has_table_privilege('service_role', 'public.staff_calendar_feeds', $1) AS ok`, [priv])
      expect(rows[0].ok, `service_role lacks ${priv}`).toBe(true)
    }
  })

  it('stores only a lowercase sha256 hex: a plaintext token cannot be written by mistake', async () => {
    await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', 'rcf_${'x'.repeat(43)}')`))
      .rejects.toThrow(/staff_calendar_feeds_token_hash_is_sha256/)
    await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${'A'.repeat(64)}')`))
      .rejects.toThrow(/staff_calendar_feeds_token_hash_is_sha256/)
  })

  it('one link per person, and a hash can belong to one person only', async () => {
    await inTx(async () => {
      await db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_A}')`)
      await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_B}')`))
        .rejects.toThrow(/staff_calendar_feeds_pkey/)
    })
    await inTx(async () => {
      await db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_A}')`)
      await expect(db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${OTHER}', '${HASH_A}')`))
        .rejects.toThrow(/staff_calendar_feeds_token_hash_key/)
    })
  })

  it('replacing the link is one UPDATE; created_at defaults, rotated_at/last_fetched_at start empty', async () => {
    await inTx(async () => {
      const ins = await db.query(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${ME}', '${HASH_A}')
        RETURNING created_at IS NOT NULL AS has_created, rotated_at, last_fetched_at`)
      expect(ins.rows).toEqual([{ has_created: true, rotated_at: null, last_fetched_at: null }])
      const upd = await db.query(`UPDATE public.staff_calendar_feeds SET token_hash = '${HASH_B}', rotated_at = now()
        WHERE profile_id = '${ME}' RETURNING token_hash`)
      expect(upd.rows).toEqual([{ token_hash: HASH_B }])
    })
  })

  it('goes with its profile if a profile row is ever deleted (ON DELETE CASCADE)', async () => {
    await inTx(async () => {
      await db.exec(`INSERT INTO public.staff_calendar_feeds (profile_id, token_hash) VALUES ('${OTHER}', '${HASH_B}')`)
      await db.exec(`DELETE FROM public.profiles WHERE id = '${OTHER}'`)
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.staff_calendar_feeds`)
      expect(rows).toEqual([{ n: 0 }])
    })
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_632)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass`)
    expect(rows).toEqual([{ n: 0 }])
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('when a same-named table of another shape already exists, CREATE IF NOT EXISTS keeps it and the DO block raises', async () => {
    const other = await boot({ before: 'CREATE TABLE public.staff_calendar_feeds (profile_id uuid PRIMARY KEY, token_hash text)' })
    try {
      await expect(other.exec(MIG_632)).rejects.toThrow(/mig 632: staff_calendar_feeds has the wrong shape/)
      await other.exec('ROLLBACK')
      const { rows } = await other.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass`)
      expect(rows).toEqual([{ relrowsecurity: false }])
    } finally {
      await other.close()
    }
  })

  it('without the REVOKE the grant check fires: the default grants are real and the file must remove them', async () => {
    const other = await boot()
    try {
      const noRevoke = MIG_632.replace('REVOKE ALL ON public.staff_calendar_feeds FROM anon, authenticated;', '')
      expect(noRevoke).not.toBe(MIG_632)
      await expect(other.exec(noRevoke)).rejects.toThrow(/mig 632: browser roles still hold/)
      await other.exec('ROLLBACK')
      expect((await other.query(`SELECT to_regclass('public.staff_calendar_feeds') AS t`)).rows).toEqual([{ t: null }])
    } finally {
      await other.close()
    }
  })
})
