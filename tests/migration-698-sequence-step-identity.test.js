// STEPATTRIB.1 (follow-ups C99) — behavioural test for migration 698.
//
// A graph publish used to delete every sequence_steps row and insert the
// compiled ones. email_sends.sequence_step_id is ON DELETE SET NULL, so each
// publish orphaned every earlier send's step (22,771 of 22,793 on 30 Sep).
// 698 adds the identity (sequence_steps.graph_node_id, unique per sequence)
// and public.publish_sequence_steps(uuid, jsonb), which applies a publish in
// ONE transaction: delete the rows not kept, update the kept rows in place,
// insert the new ones. Forward only (Richard, 1 Oct 2026): no history is
// re-attributed and the file writes no row.
//
// No local Supabase stack exists, so this boots PGlite (PostgreSQL 17) with
// prod's sequence_steps (columns, defaults, the updated_at trigger; catalog
// read 2 Oct 2026), the one FK into it (email_sends, SET NULL), and runs the
// REAL file. It proves:
//   * the column, the partial unique index and the function exist; the
//     function is SECURITY INVOKER with a pinned search_path and only
//     service_role may execute it (mig 667);
//   * a republish keeps every kept row's id, so its sends keep their step;
//   * a removed node is the only row deleted and only its sends go NULL;
//   * an updated row is a fresh row in all but id (stale columns reset), and
//     an inserted row takes the column defaults;
//   * a bad payload changes NOTHING (atomic): a bad uuid mid-array, a
//     duplicate node id, a missing step_order, a non-array, an unknown
//     sequence;
//   * an id belonging to another sequence is never touched;
//   * a second run is a no-op; the rollback record removes all three objects.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/698_sequence_step_identity.sql'), 'utf8')

/** The rollback record: the commented block between its two markers, uncommented. */
function rollbackOf(sql) {
  const m = sql.match(/-- ROLLBACK BEGIN\n([\s\S]*?)-- ROLLBACK END/)
  if (!m) throw new Error('698 has no rollback record')
  return m[1].split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n')
}

const SEQ = 'a0000000-0000-0000-0000-000000000001'
const SEQ2 = 'a0000000-0000-0000-0000-000000000002'
const TPL = 'e0000000-0000-0000-0000-000000000001'
const sid = (n) => `d0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const send = (n) => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`

// sequence_steps as prod holds it (2 Oct 2026), FKs to template tables left
// out (not what this file touches).
const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

  CREATE TABLE public.email_sequences (id uuid PRIMARY KEY, location_id uuid, graph jsonb);
  CREATE TABLE public.sequence_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id uuid NOT NULL REFERENCES public.email_sequences(id) ON DELETE CASCADE,
    step_order integer NOT NULL,
    delay_minutes integer DEFAULT 0,
    delay_type text DEFAULT 'after_previous',
    subject text,
    design_json jsonb,
    html_content text,
    template_id uuid,
    step_type text DEFAULT 'email',
    total_sent integer DEFAULT 0,
    total_opened integer DEFAULT 0,
    total_clicked integer DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    delay_days integer DEFAULT 0,
    delay_hours integer DEFAULT 0,
    whatsapp_template_id uuid,
    whatsapp_variables jsonb DEFAULT '{}'::jsonb,
    whatsapp_header_media_url text,
    sms_body text,
    config jsonb DEFAULT '{}'::jsonb
  );
  CREATE INDEX idx_sequence_steps_sequence ON public.sequence_steps (sequence_id);
  CREATE TRIGGER sequence_steps_updated_at BEFORE UPDATE ON public.sequence_steps
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  GRANT SELECT ON public.sequence_steps TO authenticated;

  CREATE TABLE public.email_sends (
    id uuid PRIMARY KEY,
    sequence_id uuid,
    sequence_step_id uuid REFERENCES public.sequence_steps(id) ON DELETE SET NULL
  );
  CREATE TABLE public.sequence_enrollments (id uuid PRIMARY KEY, sequence_id uuid, current_step_order integer);
`

// The live 3-Class-Trial shape, rows as a pre-698 publish wrote them.
const SEED = `
  INSERT INTO public.email_sequences (id) VALUES ('${SEQ}'), ('${SEQ2}');
  INSERT INTO public.sequence_steps (id, sequence_id, step_order, step_type, subject, html_content, delay_days, config) VALUES
    ('${sid(1)}', '${SEQ}', 1, 'email', 'Welcome',   '<p>1</p>', 0, '{"next_step_order": 2}'),
    ('${sid(2)}', '${SEQ}', 2, 'wait',  NULL,        NULL,       2, '{"next_step_order": 3}'),
    ('${sid(3)}', '${SEQ}', 3, 'email', 'Class two', '<p>2</p>', 0, '{"next_step_order": 4}'),
    ('${sid(4)}', '${SEQ}', 4, 'wait',  NULL,        NULL,       3, '{"next_step_order": 5}'),
    ('${sid(5)}', '${SEQ}', 5, 'email', 'Last one',  '<p>3</p>', 0, '{"next_step_order": "end"}'),
    ('${sid(9)}', '${SEQ2}', 1, 'email', 'Other sequence', '<p>x</p>', 0, '{"next_step_order": "end"}');
  INSERT INTO public.email_sends (id, sequence_id, sequence_step_id) VALUES
    ('${send(1)}', '${SEQ}', '${sid(1)}'), ('${send(2)}', '${SEQ}', '${sid(3)}'),
    ('${send(3)}', '${SEQ}', '${sid(5)}'), ('${send(4)}', '${SEQ}', NULL),
    ('${send(9)}', '${SEQ2}', '${sid(9)}');
  INSERT INTO public.sequence_enrollments VALUES ('c0000000-0000-0000-0000-000000000001', '${SEQ}', 2);
`

const row = (o) => ({
  step_order: o.step_order, step_type: o.step_type, delay_days: 0, delay_hours: 0, delay_minutes: 0, ...o,
})
// The compiled rows of the same graph (what the route sends), ids from the plan.
const republish = () => [
  row({ id: sid(1), graph_node_id: 'e1', step_order: 1, step_type: 'email', subject: 'Welcome', html_content: '<p>1</p>', template_id: null, config: { next_step_order: 2 } }),
  row({ id: sid(2), graph_node_id: 'w1', step_order: 2, step_type: 'wait', delay_days: 2, config: { next_step_order: 3 } }),
  row({ id: sid(3), graph_node_id: 'e2', step_order: 3, step_type: 'email', subject: 'Class two', html_content: '<p>2</p>', template_id: null, config: { next_step_order: 4 } }),
  row({ id: sid(4), graph_node_id: 'w2', step_order: 4, step_type: 'wait', delay_days: 3, config: { next_step_order: 5 } }),
  row({ id: sid(5), graph_node_id: 'e3', step_order: 5, step_type: 'email', subject: 'Last one', html_content: '<p>3</p>', template_id: null, config: { next_step_order: 'end' } }),
]

let db
const runSql = (sql) => db['exec'](sql)
const publish = (steps, seq = SEQ) => db.query(
  'SELECT public.publish_sequence_steps($1::uuid, $2::jsonb) AS r', [seq, JSON.stringify(steps)])
const steps = async (seq = SEQ) => (await db.query(
  `SELECT id, step_order, step_type, graph_node_id, subject, html_content, design_json, template_id, delay_days,
          delay_type, whatsapp_variables, config, total_sent
     FROM public.sequence_steps WHERE sequence_id = $1 ORDER BY step_order, id`, [seq])).rows
const sends = async () => Object.fromEntries((await db.query(
  'SELECT id, sequence_step_id FROM public.email_sends ORDER BY id')).rows.map((r) => [r.id, r.sequence_step_id]))
/** Run a statement expected to fail; return its message. */
async function failure(promise) {
  try { await promise; return null } catch (e) { return String(e.message || e) }
}

beforeEach(async () => {
  db = new PGlite()
  await runSql(BASE)
  await runSql(SEED)
  await runSql(MIG)
})
afterEach(async () => { await db.close() })

describe('698 — the objects', () => {
  it('adds graph_node_id (text, nullable) and a partial unique index per sequence', async () => {
    const { rows: [col] } = await db.query(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sequence_steps' AND column_name = 'graph_node_id'`)
    expect(col).toEqual({ data_type: 'text', is_nullable: 'YES' })
    const { rows: [idx] } = await db.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'sequence_steps_graph_node_uniq'`)
    expect(idx.indexdef).toMatch(/CREATE UNIQUE INDEX .* \(sequence_id, graph_node_id\) WHERE \(graph_node_id IS NOT NULL\)/)
  })

  it('writes no row: existing steps keep a NULL key until their next publish', async () => {
    expect((await steps()).every((s) => s.graph_node_id === null)).toBe(true)
  })

  it('the function is SECURITY INVOKER with a pinned search_path, executable by service_role only', async () => {
    const { rows: [fn] } = await db.query(`SELECT prosecdef, proconfig FROM pg_proc
      WHERE oid = 'public.publish_sequence_steps(uuid, jsonb)'::regprocedure`)
    expect(fn.prosecdef).toBe(false)
    expect(fn.proconfig).toEqual(['search_path=""'])
    for (const [role, can] of [['anon', false], ['authenticated', false], ['public', false], ['service_role', true]]) {
      const { rows: [r] } = await db.query(
        `SELECT has_function_privilege($1, 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE') AS h`, [role])
      expect(r.h, role).toBe(can)
    }
  })

  it('refuses a signed-in session outright', async () => {
    await runSql('BEGIN; SET LOCAL ROLE authenticated;')
    const msg = await failure(publish(republish()))
    await runSql('ROLLBACK;')
    expect(msg).toMatch(/permission denied for function publish_sequence_steps/)
  })
})

describe('698 — publish_sequence_steps', () => {
  it('a republish keeps every row id, so every send keeps its step', async () => {
    const before = await sends()
    const { rows: [{ r }] } = await publish(republish())
    expect(r).toEqual({ updated: 5, inserted: 0, deleted: 0 })
    expect((await steps()).map((s) => [s.id, s.graph_node_id])).toEqual(
      [[sid(1), 'e1'], [sid(2), 'w1'], [sid(3), 'e2'], [sid(4), 'w2'], [sid(5), 'e3']])
    expect(await sends()).toEqual(before)
  })

  it('works as service_role (the route\'s client)', async () => {
    await runSql('BEGIN; SET LOCAL ROLE service_role;')
    const { rows: [{ r }] } = await publish(republish())
    await runSql('COMMIT;')
    expect(r.updated).toBe(5)
  })

  it('edit + insert + remove: only the removed node\'s row goes, only its sends go NULL', async () => {
    const next = republish().filter((s) => s.graph_node_id !== 'w2')
    next[2] = { ...next[2], subject: 'Class two, v2', config: { next_step_order: 4 } } // e2 edited
    next[3] = { ...next[3], step_order: 5, config: { next_step_order: 'end' } }       // e3 moves to 5
    next.splice(3, 0, row({ graph_node_id: 't1', step_order: 4, step_type: 'apply_tag', config: { tag: 'trial_done', next_step_order: 5 } }))
    const { rows: [{ r }] } = await publish(next)
    expect(r).toEqual({ updated: 4, inserted: 1, deleted: 1 })
    const after = await steps()
    expect(after.map((s) => [s.step_order, s.graph_node_id])).toEqual(
      [[1, 'e1'], [2, 'w1'], [3, 'e2'], [4, 't1'], [5, 'e3']])
    expect(after.find((s) => s.graph_node_id === 'e2')).toMatchObject({ id: sid(3), subject: 'Class two, v2' })
    expect(after.find((s) => s.graph_node_id === 'e3').id).toBe(sid(5))
    const t1 = after.find((s) => s.graph_node_id === 't1')
    expect(t1).toMatchObject({ delay_type: 'after_previous', total_sent: 0, whatsapp_variables: {}, subject: null })
    expect(await sends()).toEqual({ [send(1)]: sid(1), [send(2)]: sid(3), [send(3)]: sid(5), [send(4)]: null, [send(9)]: sid(9) })
  })

  it('an in-flight enrolment\'s cursor is untouched (the runner is step_order driven)', async () => {
    await publish(republish())
    const { rows: [e] } = await db.query('SELECT current_step_order FROM public.sequence_enrollments')
    expect(e.current_step_order).toBe(2)
  })

  it('an updated row is a fresh row in all but its id: stale columns are reset', async () => {
    await runSql(`UPDATE public.sequence_steps SET design_json = '{"legacy": true}', delay_type = 'fixed',
      template_id = '${TPL}' WHERE id = '${sid(1)}'`)
    await publish(republish())
    const e1 = (await steps()).find((s) => s.id === sid(1))
    expect(e1).toMatchObject({ design_json: null, delay_type: 'after_previous', template_id: null, subject: 'Welcome' })
  })

  it('carries every column a compiled row can name', async () => {
    const wa = row({ graph_node_id: 'wa', step_order: 1, step_type: 'whatsapp', whatsapp_template_id: TPL,
      whatsapp_variables: { 1: 'first_name', url_button: 'pay_link_suffix' }, whatsapp_header_media_url: 'https://example.test/a.png',
      config: { next_step_order: 2 } })
    const sms = row({ graph_node_id: 'sm', step_order: 2, step_type: 'sms', sms_body: 'hi', delay_hours: 4, delay_minutes: 5, config: { next_step_order: 'end' } })
    await publish([wa, sms])
    const { rows } = await db.query(`SELECT step_type, whatsapp_template_id, whatsapp_variables, whatsapp_header_media_url,
      sms_body, delay_hours, delay_minutes, config FROM public.sequence_steps WHERE sequence_id = $1 ORDER BY step_order`, [SEQ])
    expect(rows).toEqual([
      { step_type: 'whatsapp', whatsapp_template_id: TPL, whatsapp_variables: { 1: 'first_name', url_button: 'pay_link_suffix' },
        whatsapp_header_media_url: 'https://example.test/a.png', sms_body: null, delay_hours: 0, delay_minutes: 0, config: { next_step_order: 2 } },
      { step_type: 'sms', whatsapp_template_id: null, whatsapp_variables: {}, whatsapp_header_media_url: null,
        sms_body: 'hi', delay_hours: 4, delay_minutes: 5, config: { next_step_order: 'end' } },
    ])
  })

  it('never touches another sequence\'s row named in the payload; a fresh row is inserted instead', async () => {
    const next = [row({ id: sid(9), graph_node_id: 'e1', step_order: 1, step_type: 'email', subject: 'hijack', config: { next_step_order: 'end' } })]
    const { rows: [{ r }] } = await publish(next)
    expect(r).toEqual({ updated: 0, inserted: 1, deleted: 5 })
    expect((await steps(SEQ2))[0]).toMatchObject({ id: sid(9), subject: 'Other sequence' })
    expect((await steps())[0].id).not.toBe(sid(9))
  })

  it('an id named twice updates once and inserts the second', async () => {
    const next = republish()
    next.push({ ...next[0], graph_node_id: 'e1b', step_order: 6 })
    const { rows: [{ r }] } = await publish(next)
    expect(r).toEqual({ updated: 5, inserted: 1, deleted: 0 })
  })

  describe('a bad payload changes nothing (one transaction)', () => {
    const cases = [
      ['a bad uuid mid-array', () => { const n = republish(); n[3] = { ...n[3], template_id: 'not-a-uuid' }; return n }, /invalid input syntax for type uuid/],
      ['a duplicate node id', () => { const n = republish(); n[4] = { ...n[4], graph_node_id: 'e1' }; return n }, /sequence_steps_graph_node_uniq/],
      ['a missing step_order', () => { const n = republish(); delete n[2].step_order; return n }, /step_order/],
      ['not an array', () => ({ steps: [] }), /must be a JSON array/],
    ]
    for (const [label, payload, err] of cases) {
      it(label, async () => {
        const before = [await steps(), await sends()]
        expect(await failure(publish(payload()))).toMatch(err)
        expect([await steps(), await sends()]).toEqual(before)
      })
    }

    it('an unknown sequence', async () => {
      expect(await failure(publish(republish(), 'a0000000-0000-0000-0000-0000000000ff'))).toMatch(/not found/)
    })
  })
})

describe('698 — re-run and rollback', () => {
  it('a second run is a no-op', async () => {
    await publish(republish())
    await runSql(MIG)
    expect((await steps()).map((s) => s.graph_node_id)).toEqual(['e1', 'w1', 'e2', 'w2', 'e3'])
  })

  it('the rollback record removes the function, the index and the column', async () => {
    await runSql(rollbackOf(MIG))
    const { rows: [r] } = await db.query(`SELECT
      to_regprocedure('public.publish_sequence_steps(uuid, jsonb)') IS NULL AS fn_gone,
      to_regclass('public.sequence_steps_graph_node_uniq') IS NULL AS idx_gone,
      NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sequence_steps' AND column_name = 'graph_node_id') AS col_gone`)
    expect(r).toEqual({ fn_gone: true, idx_gone: true, col_gone: true })
    const { rows: [n] } = await db.query('SELECT count(*)::int AS n FROM public.sequence_steps WHERE sequence_id = $1', [SEQ])
    expect(n.n).toBe(5)
  })
})
