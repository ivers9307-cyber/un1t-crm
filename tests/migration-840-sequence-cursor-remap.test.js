// SEQCURSOR.1 — behavioural test for migration 840: a republish moves every
// active or paused enrolment with the step it was due to run next, in the same
// transaction as the step rows, so a step inserted above one already sent is
// never sent again. Boots PGlite with prod's sequence_steps (copied from the
// 698 test), runs the REAL 698 then the REAL 840. Fictional ids only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_698 = mig('698_sequence_step_identity.sql')
const MIG_840 = mig('840_publish_sequence_steps_cursor_remap.sql')

const SEQ = 'a0000000-0000-0000-0000-000000000001'
const SEQ2 = 'a0000000-0000-0000-0000-000000000002'
const sid = (n) => `d0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const enr = (n) => `c0000000-0000-0000-0000-${String(n).padStart(12, '0')}`

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
  CREATE TABLE public.sequence_enrollments (id uuid PRIMARY KEY, sequence_id uuid, current_step_order integer, status text DEFAULT 'active');
`


// email(1) → wait(2) → email(3), all with node ids.
const SEED = `
  INSERT INTO public.email_sequences (id) VALUES ('${SEQ}'), ('${SEQ2}');
  INSERT INTO public.sequence_steps (id, sequence_id, step_order, step_type, subject, graph_node_id, config) VALUES
    ('${sid(1)}', '${SEQ}', 1, 'email', 'Welcome', 'e1', '{"next_step_order": 2}'),
    ('${sid(2)}', '${SEQ}', 2, 'wait',  NULL,      'w1', '{"next_step_order": 3}'),
    ('${sid(3)}', '${SEQ}', 3, 'email', 'Two',     'e2', '{"next_step_order": "end"}'),
    ('${sid(9)}', '${SEQ2}', 1, 'email', 'Other',  'x1', '{"next_step_order": 2}'),
    ('${sid(8)}', '${SEQ2}', 2, 'email', 'Other 2','x2', '{"next_step_order": "end"}');
`
const step = (id, node, order, type, next) => ({
  id, graph_node_id: node, step_order: order, step_type: type, delay_days: 0, delay_hours: 0, delay_minutes: 0,
  subject: type === 'email' ? node : null, config: { next_step_order: next },
})

let db
const run = (sql) => db['exec'](sql)
const publish = async (steps, seq = SEQ) => (await db.query(
  'SELECT public.publish_sequence_steps($1::uuid, $2::jsonb) AS r', [seq, JSON.stringify(steps)])).rows[0].r
const enrol = (n, cursor, status = 'active', seq = SEQ) => run(
  `INSERT INTO public.sequence_enrollments (id, sequence_id, current_step_order, status) VALUES ('${enr(n)}', '${seq}', ${cursor}, '${status}')`)
const cursor = async (n) => (await db.query('SELECT current_step_order AS c FROM public.sequence_enrollments WHERE id = $1', [enr(n)])).rows[0].c
/** The step an enrolment runs next: the row at cursor + 1. */
const nextStep = async (n) => (await db.query(
  `SELECT s.id FROM public.sequence_steps s JOIN public.sequence_enrollments e
      ON e.sequence_id = s.sequence_id AND s.step_order = e.current_step_order + 1 WHERE e.id = $1`, [enr(n)])).rows[0]?.id ?? null

beforeEach(async () => {
  db = new PGlite()
  await run(BASE)
  await run(MIG_698)
  await run(MIG_840)
  await run(SEED)
})
afterEach(async () => { await db.close() })

describe('840 — publish moves enrolments with their next step', () => {
  it('a step inserted above one already sent is not sent again', async () => {
    await enrol(1, 2) // Welcome sent and the wait done: next is "Two" (order 3)
    await enrol(2, 1, 'paused') // Welcome sent, waiting: next is the wait (order 2)
    // New email at the top: every kept row moves down one.
    const r = await publish([
      step(null, 'e0', 1, 'email', 2),
      step(sid(1), 'e1', 2, 'email', 3),
      step(sid(2), 'w1', 3, 'wait', 4),
      step(sid(3), 'e2', 4, 'email', 'end'),
    ])
    expect(r.remapped).toBe(2)
    expect(await nextStep(1)).toBe(sid(3))
    expect(await nextStep(2)).toBe(sid(2))
  })

  it('an enrolment whose next step was deleted moves to the first kept step after it', async () => {
    await enrol(1, 1) // next is the wait, which the publish removes
    const r = await publish([
      step(null, 'e0', 1, 'email', 2),
      step(sid(1), 'e1', 2, 'email', 3),
      step(sid(3), 'e2', 3, 'email', 'end'),
    ])
    expect(r.remapped).toBe(1)
    expect(await nextStep(1)).toBe(sid(3))
  })

  it('a publish that moves nothing changes no cursor', async () => {
    await enrol(1, 1)
    const r = await publish([step(sid(1), 'e1', 1, 'email', 2), step(sid(2), 'w1', 2, 'wait', 3), step(sid(3), 'e2', 3, 'email', 'end')])
    expect(r).toMatchObject({ updated: 3, remapped: 0 })
    expect(await cursor(1)).toBe(1)
  })

  it('completed and exited enrolments, and other sequences, are left alone', async () => {
    await enrol(1, 3, 'completed')
    await enrol(2, 1, 'exited')
    await enrol(3, 0, 'active', SEQ2)
    await publish([
      step(null, 'e0', 1, 'email', 2),
      step(sid(1), 'e1', 2, 'email', 3),
      step(sid(2), 'w1', 3, 'wait', 4),
      step(sid(3), 'e2', 4, 'email', 'end'),
    ])
    expect(await cursor(1)).toBe(3)
    expect(await cursor(2)).toBe(1)
    expect(await cursor(3)).toBe(0)
  })

  it('a chain of moves does not cascade (one statement)', async () => {
    await enrol(1, 0) // next order 1 -> new 2
    await enrol(2, 1) // next order 2 -> new 3
    await publish([
      step(null, 'e0', 1, 'email', 2),
      step(sid(1), 'e1', 2, 'email', 3),
      step(sid(2), 'w1', 3, 'wait', 4),
      step(sid(3), 'e2', 4, 'email', 'end'),
    ])
    expect(await cursor(1)).toBe(1)
    expect(await cursor(2)).toBe(2)
  })

  it('a bad payload changes no cursor (atomic)', async () => {
    await enrol(1, 1)
    await expect(publish([step(null, 'e0', 1, 'email', 2), { id: 'not-a-uuid', step_order: 2 }])).rejects.toThrow()
    expect(await cursor(1)).toBe(1)
  })

  it('stays service_role only and SECURITY INVOKER', async () => {
    const { rows } = await db.query(`SELECT prosecdef FROM pg_proc WHERE oid = 'public.publish_sequence_steps(uuid, jsonb)'::regprocedure`)
    expect(rows[0].prosecdef).toBe(false)
    for (const role of ['anon', 'authenticated']) {
      const { rows: r } = await db.query(`SELECT has_function_privilege($1, 'public.publish_sequence_steps(uuid, jsonb)', 'EXECUTE') AS h`, [role])
      expect(r[0].h).toBe(false)
    }
  })
})
