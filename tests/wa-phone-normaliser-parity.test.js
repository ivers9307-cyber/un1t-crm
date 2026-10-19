// WAPHONE.1 — behavioural test for migration 753 (every contact's phone maps
// to a WhatsApp number).
//
// Boots PGlite with contacts as prod had it on 19 Oct 2026 for this purpose:
// mig 330's derive_wa_phone_trigger (Irish mobiles only), mig 525/526's
// private.wa_phone_from_phone, and prod's schema ACL (service_role has NO
// USAGE on schema private). Then runs the REAL 753 file and proves:
//
//   * PARITY: public.normalize_wa_phone and src/lib/phone-validate.js
//     waPhoneFromPhone return the same value for every row of the shared
//     fixture table (tests/helpers/wa-phone-cases.js), and both equal the
//     expected value. Change one rule without the other and this fails;
//   * the trigger, for every write path (it is the only mechanism): an insert
//     derives wa_phone for an international number; a phone change re-derives
//     a wa_phone that was the old phone's derivation; it never overwrites a
//     wa_phone learned elsewhere, or one the same statement sets, and an
//     unmappable new phone keeps the old number; a write by service_role (every
//     /api route) works although service_role cannot reach schema private;
//   * the backfill fills every empty wa_phone whose phone maps, never touches a
//     non-empty one, skips a number another contact at the SAME studio already
//     answers on (one per studio when several candidates share it), fills
//     across studios, and is idempotent;
//   * the self-check aborts the file when the trigger is not live.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { waPhoneFromPhone } from '../src/lib/phone-validate.js'
import { WA_PHONE_CASES } from './helpers/wa-phone-cases.js'

const readMigration = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_330 = readMigration('330_derive_wa_phone_on_import.sql')
const MIG_525 = readMigration('525_wa_phone_backfill.sql')
const MIG_526 = readMigration('526_wa_phone_fn_search_path.sql')
const MIG_753 = readMigration('753_wa_phone_every_contact.sql')

const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
const LOC_B = 'a0000000-0000-4000-8000-00000000000b'
const id = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY,
    location_id uuid,
    phone text,
    wa_phone text,
    name text,
    updated_at timestamptz DEFAULT now()
  );
  CREATE INDEX idx_contacts_wa_phone ON public.contacts (wa_phone);
  GRANT USAGE ON SCHEMA public TO service_role;
  GRANT SELECT, INSERT, UPDATE ON public.contacts TO service_role;
`
// Prod: schema private exists (owned by postgres) and service_role has no
// USAGE on it; a helper there would fail an INVOKER trigger fired by a route.
const PRIVATE_SCHEMA = `CREATE SCHEMA private;`

let db
const runSql = (text) => db['exec'](text)
async function rows(sql, params) { return (await db.query(sql, params)).rows }
async function asRole(role, sql) {
  await runSql('BEGIN')
  try {
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
async function boot(seed = '') {
  db = new PGlite()
  await runSql(BASE)
  await runSql(PRIVATE_SCHEMA)
  await runSql(MIG_330)
  await runSql(MIG_525)
  await runSql(MIG_526)
  if (seed) await runSql(seed)
}
const waOf = async (n) => (await rows(`SELECT wa_phone FROM public.contacts WHERE id = $1`, [id(n)]))[0]?.wa_phone ?? null

describe('mig 753 — SQL and JS rules agree on every fixture shape', () => {
  beforeAll(async () => {
    await boot()
    await runSql(MIG_753)
  }, 60_000)
  afterAll(() => db?.close())

  it('normalize_wa_phone = waPhoneFromPhone = expected, row by row', async () => {
    const inputs = WA_PHONE_CASES.map(([input]) => (input === undefined ? null : input))
    const out = await rows(
      `SELECT ord::int AS ord, public.normalize_wa_phone(t.input) AS wa
         FROM unnest($1::text[]) WITH ORDINALITY AS t(input, ord) ORDER BY ord`, [inputs])
    const mismatches = []
    WA_PHONE_CASES.forEach(([input, expected, shape], i) => {
      const sql = out[i].wa
      const js = waPhoneFromPhone(input)
      if (sql !== js || js !== expected) mismatches.push({ input, shape, expected, js, sql })
    })
    expect(mismatches).toEqual([])
  })

  it('is closed to client roles and open to service_role', async () => {
    const [r] = await rows(`SELECT
      has_function_privilege('anon', 'public.normalize_wa_phone(text)', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'public.normalize_wa_phone(text)', 'EXECUTE') AS auth,
      has_function_privilege('service_role', 'public.normalize_wa_phone(text)', 'EXECUTE') AS svc`)
    expect(r).toEqual({ anon: false, auth: false, svc: true })
  })
})

describe('mig 753 — the trigger on every contacts write', () => {
  beforeAll(async () => {
    await boot()
    await runSql(MIG_753)
  }, 60_000)
  afterAll(() => db?.close())

  it('INSERT derives wa_phone for an international number the old rule ignored', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone) VALUES
      ('${id(1)}', '${LOC_A}', '+44 7700 900123'),
      ('${id(2)}', '${LOC_A}', '3530871234567'),
      ('${id(3)}', '${LOC_A}', '+380 50 123 4567'),
      ('${id(4)}', '${LOC_A}', '01 555 1234')`)
    expect([await waOf(1), await waOf(2), await waOf(3), await waOf(4)])
      .toEqual(['447700900123', '353871234567', '380501234567', null])
  })

  it('INSERT keeps a wa_phone the writer sets', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone, wa_phone) VALUES ('${id(5)}', '${LOC_A}', '0871234567', '447700900999')`)
    expect(await waOf(5)).toBe('447700900999')
  })

  it('a phone change re-derives a wa_phone that came from the old phone', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone) VALUES ('${id(6)}', '${LOC_A}', '0871234567')`)
    expect(await waOf(6)).toBe('353871234567')
    await runSql(`UPDATE public.contacts SET phone = '+44 7700 900456' WHERE id = '${id(6)}'`)
    expect(await waOf(6)).toBe('447700900456')
  })

  it('a reformat of the same number leaves it alone', async () => {
    await runSql(`UPDATE public.contacts SET phone = '+447700900456' WHERE id = '${id(6)}'`)
    expect(await waOf(6)).toBe('447700900456')
  })

  it('a legacy +-form wa_phone that was the old phone\'s derivation is re-derived too', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone, wa_phone) VALUES ('${id(7)}', '${LOC_A}', '0871234567', '+353871234567')`)
    await runSql(`UPDATE public.contacts SET phone = '0861234567' WHERE id = '${id(7)}'`)
    expect(await waOf(7)).toBe('353861234567')
  })

  it('NEVER overwrites a wa_phone learned elsewhere (inbound WhatsApp, staff)', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone, wa_phone) VALUES ('${id(8)}', '${LOC_A}', '0871234567', '447700900777')`)
    await runSql(`UPDATE public.contacts SET phone = '0861234567' WHERE id = '${id(8)}'`)
    expect(await waOf(8)).toBe('447700900777')
  })

  it('keeps a wa_phone the same UPDATE sets alongside the phone', async () => {
    await runSql(`UPDATE public.contacts SET phone = '0851234567', wa_phone = '447700900888' WHERE id = '${id(6)}'`)
    expect(await waOf(6)).toBe('447700900888')
  })

  it('an unmappable new phone keeps the old number rather than going dark', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone) VALUES ('${id(9)}', '${LOC_A}', '0871234567')`)
    await runSql(`UPDATE public.contacts SET phone = '01 555 1234' WHERE id = '${id(9)}'`)
    expect(await waOf(9)).toBe('353871234567')
    await runSql(`UPDATE public.contacts SET phone = NULL WHERE id = '${id(9)}'`)
    expect(await waOf(9)).toBe('353871234567')
  })

  it('an UPDATE naming phone fills an empty wa_phone (the sync heals itself)', async () => {
    await runSql(`INSERT INTO public.contacts (id, location_id, phone, wa_phone) VALUES ('${id(10)}', '${LOC_A}', '+380 50 123 4567', '')`)
    expect(await waOf(10)).toBe('380501234567')
    await runSql(`UPDATE public.contacts SET wa_phone = NULL WHERE id = '${id(10)}'`)
    expect(await waOf(10)).toBeNull()
    await runSql(`UPDATE public.contacts SET phone = phone WHERE id = '${id(10)}'`)
    expect(await waOf(10)).toBe('380501234567')
  })

  it('a write by service_role (every /api route) works: nothing reaches schema private', async () => {
    const [r] = await asRole('service_role',
      `INSERT INTO public.contacts (id, location_id, phone) VALUES ('${id(11)}', '${LOC_A}', '+44 7700 900321') RETURNING wa_phone`)
    expect(r.wa_phone).toBe('447700900321')
    const [u] = await asRole('service_role',
      `UPDATE public.contacts SET phone = '0871234567' WHERE id = '${id(1)}' RETURNING wa_phone`)
    expect(u.wa_phone).toBe('353871234567')
  })
})

describe('mig 753 — backfill', () => {
  const SEED = `
    INSERT INTO public.contacts (id, location_id, phone, wa_phone, updated_at) VALUES
      ('${id(1)}', '${LOC_A}', '3530871234567', NULL, now()),               -- fillable (trunk zero)
      ('${id(2)}', '${LOC_A}', '+44 7700 900123', NULL, now()),             -- fillable (UK)
      ('${id(3)}', '${LOC_A}', '+380 50 123 4567', '', now()),              -- fillable ('' counts as empty)
      ('${id(4)}', '${LOC_A}', '01 555 1234', NULL, now()),                 -- landline: stays empty
      ('${id(5)}', '${LOC_A}', '34612345678', NULL, now()),                 -- bare foreign: stays empty
      ('${id(6)}', '${LOC_A}', '+44 7700 900999', '447700900111', now()),   -- has one: never touched
      ('${id(7)}', '${LOC_A}', '+447700900555', NULL, now()),               -- same-studio twin below already answers
      ('${id(8)}', '${LOC_A}', '0871112223', '447700900555', now()),
      ('${id(9)}', '${LOC_B}', '+447700900555', NULL, now()),               -- other studio: filled
      ('${id(10)}', '${LOC_B}', '+44 7700 900666', NULL, now() - interval '2 days'), -- two candidates, one number:
      ('${id(11)}', '${LOC_B}', '07700900666', NULL, now() - interval '1 day');      -- newest wins
  `
  beforeAll(async () => {
    await boot(SEED)
  }, 60_000)
  afterAll(() => db?.close())

  it('before 753, mig 330\'s Irish-only rule left every one of them empty', async () => {
    const r = await rows(`SELECT count(*)::int AS n FROM public.contacts WHERE wa_phone IS NULL OR wa_phone = ''`)
    expect(r[0].n).toBe(9)
  })

  it('fills what maps, skips a same-studio twin, never overwrites', async () => {
    await runSql(MIG_753)
    const got = Object.fromEntries((await rows(`SELECT id, wa_phone FROM public.contacts ORDER BY id`)).map((r) => [r.id, r.wa_phone]))
    expect(got).toEqual({
      [id(1)]: '353871234567',
      [id(2)]: '447700900123',
      [id(3)]: '380501234567',
      [id(4)]: null,
      [id(5)]: null,
      [id(6)]: '447700900111',
      [id(7)]: null,
      [id(8)]: '447700900555',
      [id(9)]: '447700900555',
      [id(10)]: null,
      [id(11)]: '447700900666',
    })
  })

  it('is idempotent: a second run changes nothing and passes its self-check', async () => {
    const before = await rows(`SELECT id, wa_phone, updated_at FROM public.contacts ORDER BY id`)
    await runSql(MIG_753)
    expect(await rows(`SELECT id, wa_phone, updated_at FROM public.contacts ORDER BY id`)).toEqual(before)
  })

  it('the self-check aborts the file when the trigger is not live', async () => {
    await runSql(`ALTER TABLE public.contacts DISABLE TRIGGER derive_wa_phone_trigger`)
    let message = null
    try { await runSql(MIG_753) } catch (e) { message = String(e.message || e); await runSql('ROLLBACK') }
    expect(message).toMatch(/derive_wa_phone_trigger is not live/)
    await runSql(`ALTER TABLE public.contacts ENABLE TRIGGER derive_wa_phone_trigger`)
  })
})
