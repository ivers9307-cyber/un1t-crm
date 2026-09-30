// SMSTABLESDROP.1 (follow-ups C128) — behavioural test for migration 688.
//
// Richard approved (1 Oct 2026) dropping public.sms_broadcasts (1 row) and
// public.sms_broadcast_recipients (6 rows), the three increment_sms_broadcast_*
// counters and the updated_at trigger function only sms_broadcasts uses. SMS
// was retired on 30 Sep (migs 664-666); mig 683 had closed both tables to
// clients. The 7 rows are deliberately gone: no rollback restores data.
//
// No local Supabase stack exists, so the DDL would otherwise get its first run
// on prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-
// write-sweep.js and builds the BEFORE state from the file's own rollback
// record, then pins that state to prod's catalog (read 1 Oct 2026: columns,
// defaults, constraints, indexes, trigger, function definitions, ACLs,
// comments), so the before-state and the rollback are both proven faithful.
// Prod is post-677 (default ACL closed) and post-683 (no policy, no client
// privilege); the main replays run in that state, the rollback in both.
// It proves:
//
//   * APPLY: both tables, their row types and the four functions are gone;
//     every other catalog count is unchanged (the file's own post-check,
//     and re-measured here); the parents (contacts, locations, profiles) keep
//     their rows;
//   * the preflight aborts the WHOLE file (nothing dropped, the 7 rows still
//     there) when: a second broadcast or a seventh recipient appeared
//     (something still writes); a view, an FK from another table, a
//     BEGIN ATOMIC function, a plpgsql function naming them, a trigger on
//     another table using the updated_at function, an extra trigger on
//     sms_broadcasts, or a policy on another table depends on or names them;
//   * NO CASCADE: the file's code holds no CASCADE, and its DROP statements
//     run alone (preflight bypassed) refuse to drop past a foreign view;
//   * the post-check aborts the file on a collateral change (a mutation that
//     also drops an unrelated function) or a leftover (a mutation without the
//     trigger-function DROP);
//   * one-shot: a second run fails loudly ("already ran"), by design;
//   * the rollback record (schema only) restores prod's catalog exactly,
//     under either default ACL.
// Fictional ids only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, abortMessage, IDS } from './helpers/member-write-sweep.js'
import { sqlCode } from './helpers/sql-code.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/688_sms_broadcast_tables_dropped.sql'), 'utf8')

/** The rollback record: the commented block between its two markers, uncommented. */
function rollbackOf(sql) {
  const m = sql.match(/^-- ROLLBACK RECORD BEGIN[^\n]*\n([\s\S]*?)^-- ROLLBACK RECORD END/m)
  if (!m) throw new Error('mig 688: rollback record markers not found')
  return m[1].split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n')
}
const ROLLBACK = rollbackOf(MIG)

const FNS = [
  'increment_sms_broadcast_delivered(uuid)',
  'increment_sms_broadcast_metric(uuid,text,integer)',
  'increment_sms_broadcast_undelivered(uuid)',
  'sms_broadcasts_set_updated_at()',
]

// Prod's catalog for the dropped set (the query below, run read-only on
// 1 Oct 2026). No row values: definitions only.
const ACL_T = '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'
const ACL_F = '{postgres=X/postgres,service_role=X/postgres}'
const col = (table, column, type, not_null, dflt = null, comment = null) =>
  ({ table, column, type, not_null, default: dflt, acl: null, comment })
const TSZ = 'timestamp with time zone'
const PROD_CATALOG = {
  tables: [
    { table: 'sms_broadcast_recipients', rls: true, force_rls: false, owner: 'postgres', acl: ACL_T, comment: null },
    { table: 'sms_broadcasts', rls: true, force_rls: false, owner: 'postgres', acl: ACL_T,
      comment: 'One-shot SMS sends to a filtered audience. Phase 2 of the multi-location SMS rollout. Mirrors whatsapp_broadcasts but for freeform SMS over Twilio with per-location alpha sender ID.' },
  ],
  columns: [
    col('sms_broadcast_recipients', 'id', 'uuid', true, 'gen_random_uuid()'),
    col('sms_broadcast_recipients', 'broadcast_id', 'uuid', true),
    col('sms_broadcast_recipients', 'contact_id', 'uuid', true),
    col('sms_broadcast_recipients', 'twilio_message_sid', 'text', false),
    col('sms_broadcast_recipients', 'status', 'text', true, "'pending'::text"),
    col('sms_broadcast_recipients', 'error_message', 'text', false),
    col('sms_broadcast_recipients', 'sent_at', TSZ, false),
    col('sms_broadcast_recipients', 'failed_at', TSZ, false),
    col('sms_broadcast_recipients', 'created_at', TSZ, true, 'now()'),
    col('sms_broadcast_recipients', 'delivered_at', TSZ, false, null,
      'Stamped by /api/webhooks/twilio/status when Twilio reports MessageStatus=delivered.'),
    col('sms_broadcast_recipients', 'undelivered_at', TSZ, false, null,
      'Stamped by /api/webhooks/twilio/status when Twilio reports MessageStatus=undelivered.'),
    col('sms_broadcasts', 'id', 'uuid', true, 'gen_random_uuid()'),
    col('sms_broadcasts', 'location_id', 'uuid', true),
    col('sms_broadcasts', 'name', 'text', true),
    col('sms_broadcasts', 'body', 'text', true),
    col('sms_broadcasts', 'audience_filter', 'jsonb', true, `'{"logic": "and", "filters": []}'::jsonb`),
    col('sms_broadcasts', 'status', 'text', true, "'draft'::text"),
    col('sms_broadcasts', 'scheduled_at', TSZ, false),
    col('sms_broadcasts', 'sent_at', TSZ, false),
    col('sms_broadcasts', 'total_recipients', 'integer', true, '0'),
    col('sms_broadcasts', 'total_sent', 'integer', true, '0'),
    col('sms_broadcasts', 'total_failed', 'integer', true, '0'),
    col('sms_broadcasts', 'created_by', 'uuid', false),
    col('sms_broadcasts', 'created_at', TSZ, true, 'now()'),
    col('sms_broadcasts', 'updated_at', TSZ, true, 'now()'),
    col('sms_broadcasts', 'total_delivered', 'integer', true, '0', 'Cumulative count of recipients in the delivered state.'),
    col('sms_broadcasts', 'total_undelivered', 'integer', true, '0', 'Cumulative count of recipients in the undelivered state.'),
  ],
  constraints: [
    { table: 'sms_broadcast_recipients', name: 'sms_broadcast_recipients_broadcast_id_contact_id_key', def: 'UNIQUE (broadcast_id, contact_id)' },
    { table: 'sms_broadcast_recipients', name: 'sms_broadcast_recipients_broadcast_id_fkey', def: 'FOREIGN KEY (broadcast_id) REFERENCES sms_broadcasts(id) ON DELETE CASCADE' },
    { table: 'sms_broadcast_recipients', name: 'sms_broadcast_recipients_contact_id_fkey', def: 'FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE' },
    { table: 'sms_broadcast_recipients', name: 'sms_broadcast_recipients_pkey', def: 'PRIMARY KEY (id)' },
    { table: 'sms_broadcast_recipients', name: 'sms_broadcast_recipients_status_check', def: "CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'undelivered'::text, 'failed'::text])))" },
    { table: 'sms_broadcasts', name: 'sms_broadcasts_body_check', def: 'CHECK (((char_length(body) >= 1) AND (char_length(body) <= 1600)))' },
    { table: 'sms_broadcasts', name: 'sms_broadcasts_created_by_fkey', def: 'FOREIGN KEY (created_by) REFERENCES profiles(id)' },
    { table: 'sms_broadcasts', name: 'sms_broadcasts_location_id_fkey', def: 'FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE' },
    { table: 'sms_broadcasts', name: 'sms_broadcasts_pkey', def: 'PRIMARY KEY (id)' },
    { table: 'sms_broadcasts', name: 'sms_broadcasts_status_check', def: "CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'cancelled'::text])))" },
  ],
  indexes: [
    'CREATE INDEX idx_sms_broadcasts_created_by ON public.sms_broadcasts USING btree (created_by)',
    'CREATE UNIQUE INDEX sms_broadcast_recipients_broadcast_id_contact_id_key ON public.sms_broadcast_recipients USING btree (broadcast_id, contact_id)',
    'CREATE INDEX sms_broadcast_recipients_broadcast_idx ON public.sms_broadcast_recipients USING btree (broadcast_id)',
    'CREATE INDEX sms_broadcast_recipients_contact_idx ON public.sms_broadcast_recipients USING btree (contact_id)',
    'CREATE UNIQUE INDEX sms_broadcast_recipients_pkey ON public.sms_broadcast_recipients USING btree (id)',
    'CREATE INDEX sms_broadcasts_location_idx ON public.sms_broadcasts USING btree (location_id)',
    'CREATE UNIQUE INDEX sms_broadcasts_pkey ON public.sms_broadcasts USING btree (id)',
    "CREATE INDEX sms_broadcasts_status_idx ON public.sms_broadcasts USING btree (status, scheduled_at) WHERE (status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text]))",
  ],
  triggers: [
    'CREATE TRIGGER sms_broadcasts_updated_at BEFORE UPDATE ON public.sms_broadcasts FOR EACH ROW EXECUTE FUNCTION sms_broadcasts_set_updated_at()',
  ],
  policies: 0,
  functions: [
    { signature: 'increment_sms_broadcast_delivered(uuid)', owner: 'postgres', security_definer: false, acl: ACL_F,
      def: "CREATE OR REPLACE FUNCTION public.increment_sms_broadcast_delivered(p_broadcast_id uuid)\n RETURNS void\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nAS $function$\n  update sms_broadcasts set total_delivered = total_delivered + 1\n   where id = p_broadcast_id;\n$function$\n" },
    { signature: 'increment_sms_broadcast_metric(uuid,text,integer)', owner: 'postgres', security_definer: false, acl: ACL_F,
      def: "CREATE OR REPLACE FUNCTION public.increment_sms_broadcast_metric(p_broadcast_id uuid, p_metric text, p_delta integer DEFAULT 1)\n RETURNS void\n LANGUAGE plpgsql\n SET search_path TO ''\nAS $function$\nbegin\n  if p_metric not in ('total_sent','total_delivered','total_undelivered','total_failed') then\n    raise exception 'increment_sms_broadcast_metric: unknown metric %', p_metric;\n  end if;\n  update public.sms_broadcasts set\n    total_sent        = coalesce(total_sent,0)        + (case when p_metric='total_sent'        then p_delta else 0 end),\n    total_delivered   = coalesce(total_delivered,0)   + (case when p_metric='total_delivered'   then p_delta else 0 end),\n    total_undelivered = coalesce(total_undelivered,0) + (case when p_metric='total_undelivered' then p_delta else 0 end),\n    total_failed      = coalesce(total_failed,0)      + (case when p_metric='total_failed'      then p_delta else 0 end)\n  where id = p_broadcast_id;\nend $function$\n" },
    { signature: 'increment_sms_broadcast_undelivered(uuid)', owner: 'postgres', security_definer: false, acl: ACL_F,
      def: "CREATE OR REPLACE FUNCTION public.increment_sms_broadcast_undelivered(p_broadcast_id uuid)\n RETURNS void\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nAS $function$\n  update sms_broadcasts set total_undelivered = total_undelivered + 1\n   where id = p_broadcast_id;\n$function$\n" },
    { signature: 'sms_broadcasts_set_updated_at()', owner: 'postgres', security_definer: false, acl: ACL_F,
      def: "CREATE OR REPLACE FUNCTION public.sms_broadcasts_set_updated_at()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'public'\nAS $function$\nbegin\n  new.updated_at = now();\n  return new;\nend;\n$function$\n" },
  ],
}
const EMPTY_CATALOG = { tables: [], columns: [], constraints: [], indexes: [], triggers: [], policies: 0, functions: [] }

// The same query run on prod (read-only) to take PROD_CATALOG.
const CATALOG_SQL = `
WITH t AS (
  SELECT c.oid FROM pg_class c
   WHERE c.oid IN (to_regclass('public.sms_broadcasts'), to_regclass('public.sms_broadcast_recipients'))
), f AS (
  SELECT p.oid FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('public.increment_sms_broadcast_delivered(uuid)'),
                   to_regprocedure('public.increment_sms_broadcast_metric(uuid, text, integer)'),
                   to_regprocedure('public.increment_sms_broadcast_undelivered(uuid)'),
                   to_regprocedure('public.sms_broadcasts_set_updated_at()'))
)
SELECT json_build_object(
  'tables', (SELECT coalesce(json_agg(json_build_object('table', c.relname::text, 'rls', c.relrowsecurity,
      'force_rls', c.relforcerowsecurity, 'owner', pg_get_userbyid(c.relowner)::text, 'acl', c.relacl::text,
      'comment', obj_description(c.oid, 'pg_class')) ORDER BY c.relname), '[]') FROM pg_class c WHERE c.oid IN (SELECT oid FROM t)),
  'columns', (SELECT coalesce(json_agg(json_build_object('table', c.relname::text, 'column', a.attname::text,
      'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid), 'acl', a.attacl::text, 'comment', col_description(c.oid, a.attnum))
      ORDER BY c.relname, a.attnum), '[]')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.oid IN (SELECT oid FROM t) AND a.attnum > 0 AND NOT a.attisdropped),
  'constraints', (SELECT coalesce(json_agg(json_build_object('table', conrelid::regclass::text, 'name', conname::text,
      'def', pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text, conname), '[]')
    FROM pg_constraint WHERE conrelid IN (SELECT oid FROM t)),
  'indexes', (SELECT coalesce(json_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text), '[]')
    FROM pg_index WHERE indrelid IN (SELECT oid FROM t)),
  'triggers', (SELECT coalesce(json_agg(pg_get_triggerdef(oid) ORDER BY tgname), '[]')
    FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM t) AND NOT tgisinternal),
  'policies', (SELECT count(*)::int FROM pg_policy WHERE polrelid IN (SELECT oid FROM t)),
  'functions', (SELECT coalesce(json_agg(json_build_object('signature', p.oid::regprocedure::text,
      'owner', pg_get_userbyid(p.proowner)::text, 'security_definer', p.prosecdef, 'acl', p.proacl::text,
      'def', pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text), '[]')
    FROM pg_proc p WHERE p.oid IN (SELECT oid FROM f))
) AS catalog`
const catalog = async (db) => (await db.query(CATALOG_SQL)).rows[0].catalog

// Prod's rows: 1 broadcast, 6 recipients (fictional ids and text here).
const B1 = '88000000-0000-0000-0000-000000000001'
const C_E = '30000000-0000-0000-0000-00000000000e'
const C_F = '30000000-0000-0000-0000-00000000000f'
const SIX = [IDS.C_MEMBER, IDS.C_MEMBER2, IDS.C_STAFF_MEMBER, IDS.C_B, C_E, C_F]
const SEED = `
  INSERT INTO public.contacts (id, location_id) VALUES ('${C_E}', '${IDS.LOC_A}'), ('${C_F}', '${IDS.LOC_A}');
  INSERT INTO public.sms_broadcasts (id, location_id, name, body, status, created_by)
    VALUES ('${B1}', '${IDS.LOC_A}', 'n', 'x', 'sent', '${IDS.OWNER_A}');
  INSERT INTO public.sms_broadcast_recipients (broadcast_id, contact_id, status)
    SELECT '${B1}', c::uuid, 'delivered' FROM unnest(ARRAY['${SIX.join("','")}']) AS c;`
const counts = async (db) => (await db.query(`SELECT
  (SELECT count(*)::int FROM public.sms_broadcasts) AS broadcasts,
  (SELECT count(*)::int FROM public.sms_broadcast_recipients) AS recipients`)).rows[0]

// Prod's current state: post-677, the tables as the rollback record builds them.
const spec = (extra = {}) => ({ tables: ROLLBACK, policies: 'SELECT 1;', seed: SEED, after677: true, ...extra })

// Every catalog count the file must leave alone, re-measured from outside.
const OTHER_COUNTS = `SELECT
  (SELECT count(*)::int FROM pg_class c WHERE c.relname NOT LIKE '%sms\\_broadcast%' AND c.relnamespace <> 'pg_toast'::regnamespace) AS rels,
  (SELECT count(*)::int FROM pg_proc p WHERE p.proname NOT LIKE '%sms\\_broadcast%') AS procs,
  (SELECT count(*)::int FROM pg_policy) AS policies,
  (SELECT count(*)::int FROM pg_constraint c WHERE c.conname NOT LIKE 'sms\\_broadcast%') AS constraints,
  (SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname NOT LIKE 'sms\\_broadcast%') AS triggers,
  (SELECT count(*)::int FROM public.contacts) AS contacts,
  (SELECT count(*)::int FROM public.locations) AS locations,
  (SELECT count(*)::int FROM public.profiles) AS profiles`

describe('before 688: the replay is prod (1 Oct 2026)', () => {
  let db
  afterEach(async () => { await db?.close(); db = null })

  it("the rollback record builds exactly prod's catalog for the dropped set (the before-state is prod's)", async () => {
    db = await boot(spec())
    expect(await catalog(db)).toEqual(PROD_CATALOG)
    expect(await counts(db)).toEqual({ broadcasts: 1, recipients: 6 })
  }, 120_000)

  it('the counters and the trigger still work as the service role would call them', async () => {
    db = await boot(spec())
    await db.query(`SELECT public.increment_sms_broadcast_delivered('${B1}')`)
    await db.query(`SELECT public.increment_sms_broadcast_metric('${B1}', 'total_sent', 6)`)
    const { rows } = await db.query(`SELECT total_delivered, total_sent, updated_at > created_at AS touched
      FROM public.sms_broadcasts WHERE id = '${B1}'`)
    expect(rows).toEqual([{ total_delivered: 1, total_sent: 6, touched: true }])
  }, 120_000)
})

describe('688 applied', () => {
  let db
  afterEach(async () => { await db?.close(); db = null })

  it('drops both tables, their row types and the four functions; every other catalog count and the parents are unchanged', async () => {
    db = await boot(spec())
    const before = (await db.query(OTHER_COUNTS)).rows[0]
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await catalog(db)).toEqual(EMPTY_CATALOG)
    const { rows } = await db.query(`SELECT to_regclass('public.sms_broadcasts') AS b,
      to_regclass('public.sms_broadcast_recipients') AS r, to_regtype('public.sms_broadcasts') AS bt,
      to_regtype('public.sms_broadcast_recipients') AS rt`)
    expect(rows).toEqual([{ b: null, r: null, bt: null, rt: null }])
    for (const f of FNS) {
      expect((await db.query(`SELECT to_regprocedure($1) AS p`, [`public.${f}`])).rows[0].p, f).toBeNull()
    }
    expect((await db.query(OTHER_COUNTS)).rows[0]).toEqual(before)
  }, 120_000)

  it('a second run fails loudly (one-shot by design), naming why', async () => {
    db = await boot(spec({ migrate: [MIG] }))
    expect(await abortMessage(db, MIG)).toMatch(/mig 688: public\.sms_broadcasts and public\.sms_broadcast_recipients must both exist.*one-shot/)
  }, 120_000)
})

describe('688 aborts the whole file, dropping nothing', () => {
  let db
  afterEach(async () => { await db?.close(); db = null })

  async function expectAbort(before, message, sql = MIG) {
    db = await boot(spec({ before }))
    const cat = await catalog(db)
    const rows = await counts(db)
    expect(await abortMessage(db, sql)).toMatch(message)
    expect(await catalog(db)).toEqual(cat)
    expect(await counts(db)).toEqual(rows)
  }

  it('when a second broadcast appeared (something still writes)', () => expectAbort(
    `INSERT INTO public.sms_broadcasts (location_id, name, body) VALUES ('${IDS.LOC_A}', 'n2', 'y');`,
    /mig 688: public\.sms_broadcasts holds 2 rows, at most 1 expected/,
  ), 120_000)

  it('when a seventh recipient appeared', () => expectAbort(
    `INSERT INTO public.contacts (id, location_id) VALUES ('30000000-0000-0000-0000-0000000000aa', '${IDS.LOC_A}');
     INSERT INTO public.sms_broadcast_recipients (broadcast_id, contact_id) VALUES ('${B1}', '30000000-0000-0000-0000-0000000000aa');`,
    /mig 688: public\.sms_broadcast_recipients holds 7 rows, at most 6 expected/,
  ), 120_000)

  it('when a view reads sms_broadcasts', () => expectAbort(
    `CREATE VIEW public.sms_report AS SELECT id, status FROM public.sms_broadcasts;`,
    /mig 688: objects outside the dropped set depend on it: .*view sms_report/,
  ), 120_000)

  it('when a table outside the set has an FK into sms_broadcast_recipients', () => expectAbort(
    `CREATE TABLE public.sms_audit (id uuid PRIMARY KEY, recipient_id uuid REFERENCES public.sms_broadcast_recipients (id));`,
    /mig 688: objects outside the dropped set depend on it: .*constraint sms_audit_recipient_id_fkey on table sms_audit/,
  ), 120_000)

  it('when a BEGIN ATOMIC function reads sms_broadcasts (tracked in pg_depend)', () => expectAbort(
    `CREATE FUNCTION public.sms_total() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM public.sms_broadcasts; END;`,
    /mig 688: objects outside the dropped set depend on it: .*function sms_total\(\)/,
  ), 120_000)

  it('when a plpgsql function outside the counters names the tables (text, not pg_depend)', () => expectAbort(
    `CREATE FUNCTION public.sms_purge() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM public.sms_broadcast_recipients; END $f$;`,
    /mig 688: functions outside the dropped set name sms_broadcast: sms_purge\(\)/,
  ), 120_000)

  it('when a trigger on another table uses sms_broadcasts_set_updated_at()', () => expectAbort(
    `CREATE TABLE public.other_stamped (id uuid PRIMARY KEY, updated_at timestamptz);
     CREATE TRIGGER other_stamped_updated_at BEFORE UPDATE ON public.other_stamped
       FOR EACH ROW EXECUTE FUNCTION public.sms_broadcasts_set_updated_at();`,
    /mig 688: objects outside the dropped set depend on it: .*trigger other_stamped_updated_at on table other_stamped/,
  ), 120_000)

  it('when sms_broadcasts carries a trigger other than its updated_at', () => expectAbort(
    `CREATE FUNCTION public.sms_notify() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
     CREATE TRIGGER sms_broadcasts_notify AFTER INSERT ON public.sms_broadcasts FOR EACH ROW EXECUTE FUNCTION public.sms_notify();`,
    /mig 688: objects outside the dropped set depend on it: .*trigger sms_broadcasts_notify on table sms_broadcasts/,
  ), 120_000)

  it('when a policy on another table reads sms_broadcasts', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.sms_broadcasts));`,
    /mig 688: (objects outside the dropped set depend on it: .*policy x_via on table x|policies name or sit on the SMS broadcast tables: public\.x\.x_via)/,
  ), 120_000)

  it('when a policy sits on sms_broadcasts itself (683 dropped them all)', () => expectAbort(
    `CREATE POLICY sms_broadcasts_stray ON public.sms_broadcasts FOR SELECT TO service_role USING (true);`,
    /mig 688: (objects outside the dropped set depend on it: .*policy sms_broadcasts_stray|policies name or sit on the SMS broadcast tables: public\.sms_broadcasts\.sms_broadcasts_stray)/,
  ), 120_000)

  it('when a counter function is missing (the schema is not the one the file was written against)', () => expectAbort(
    `DROP FUNCTION public.increment_sms_broadcast_undelivered(uuid);`,
    /mig 688: function public\.increment_sms_broadcast_undelivered\(uuid\) does not exist/,
  ), 120_000)

  // Mutations of the file: the post-check catches a collateral change and a leftover.
  const mutate = (from, to) => {
    const out = MIG.replace(from, to)
    expect(out, `mutation did not apply: ${from}`).not.toBe(MIG)
    return out
  }
  it('mutation: an extra DROP of an unrelated function trips the post-check', () => expectAbort(
    `CREATE FUNCTION public.unrelated() RETURNS int LANGUAGE sql AS 'SELECT 1';`,
    /mig 688: pg_proc outside the dropped set changed: \d+ before, \d+ after/,
    mutate('DROP FUNCTION public.sms_broadcasts_set_updated_at() RESTRICT;',
      'DROP FUNCTION public.sms_broadcasts_set_updated_at() RESTRICT;\nDROP FUNCTION public.unrelated();'),
  ), 120_000)

  it('mutation: without the trigger-function DROP the post-check names it', () => expectAbort('',
    /mig 688: public\.sms_broadcasts_set_updated_at\(\) still exists/,
    mutate('DROP FUNCTION public.sms_broadcasts_set_updated_at() RESTRICT;', ''),
  ), 120_000)
})

describe('no CASCADE: a hidden dependant aborts, it is never dropped with them', () => {
  let db
  afterEach(async () => { await db?.close(); db = null })

  it("the file's code (comments aside) holds no CASCADE, and every DROP says RESTRICT", () => {
    const code = sqlCode(MIG)
    expect(code).not.toMatch(/\bcascade\b/i)
    const drops = code.match(/\bdrop\s+(table|function)\b[^;]*;/gi)
    expect(drops).toHaveLength(6)
    for (const d of drops) expect(d, d).toMatch(/\bRESTRICT;$/)
  })

  it("the file's DROP statements alone (preflight bypassed) refuse to drop past a foreign view", async () => {
    db = await boot(spec({ before: 'CREATE VIEW public.sms_report AS SELECT id FROM public.sms_broadcasts;' }))
    const drops = sqlCode(MIG).match(/\bdrop\s+(table|function)\b[^;]*;/gi).join('\n')
    expect(await abortMessage(db, `BEGIN;\n${drops}\nCOMMIT;`)).toMatch(/cannot drop table sms_broadcasts because other objects depend on it/)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.sms_report`)).rows).toEqual([{ n: 1 }])
  }, 120_000)
})

describe('the rollback record (schema only; the 7 rows are NOT restorable)', () => {
  let db
  afterEach(async () => { await db?.close(); db = null })

  it.each([
    ['post-677 default ACL (prod)', true],
    ['pre-677 default ACL', false],
  ])("restores prod's catalog exactly after 688, under the %s", async (_label, after677) => {
    db = await boot(spec({ after677, migrate: [MIG] }))
    expect(await catalog(db)).toEqual(EMPTY_CATALOG)
    expect(await abortMessage(db, ROLLBACK)).toBeNull()
    expect(await catalog(db)).toEqual(PROD_CATALOG)
    // Schema only: the tables come back empty.
    expect(await counts(db)).toEqual({ broadcasts: 0, recipients: 0 })
  }, 120_000)

  it('says plainly, in the file, that the data is not restorable', () => {
    expect(MIG).toMatch(/-- ROLLBACK RECORD BEGIN[^\n]*schema only/i)
    expect(MIG).toMatch(/data is NOT restorable/)
  })
})
