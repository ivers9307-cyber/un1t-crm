// STEPATTRIB.1 — republishing a LIVE graph with an enrolment in flight.
//
// End to end across the real pieces: the publish route (real planner) calls
// the REAL publish_sequence_steps from migration 695 running in PGlite, and
// then the real runner (runSequences) reads its next step from the same
// database. The shape is the live 3-Class Trial (email, wait, email, wait,
// email) whose rows predate 695 (graph_node_id NULL), with an enrolment
// sitting on step 2 and sends attributed to steps 1 and 3.
//
// It proves what an in-flight enrolment sees after a publish that edits a
// later email and appends a node:
//   * every kept row keeps its id (adopted from the stored published graph),
//     so the earlier sends keep their step;
//   * the enrolment's cursor is untouched and its next tick runs step 3 with
//     the NEW content, under the ORIGINAL row id (so that send is attributed
//     to the same step as the sends before the publish);
//   * a second publish (rows now carry node ids) keeps the ids again.
// Forward only (Richard, 1 Oct 2026): a send whose step was already NULL stays
// NULL. Fictional ids only: the repo is public.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: () => null,
}))
vi.mock('@/lib/sequences/steps.js', () => ({
  sendEmailStep: vi.fn(),
  sendWhatsappStep: vi.fn(),
  retiredSmsStep: vi.fn(),
  applyTagStep: vi.fn(),
  updateFieldStep: vi.fn(),
  webhookStep: vi.fn(),
  internalTaskStep: vi.fn(),
  processBranchStep: vi.fn(),
  movePipelineStageStep: vi.fn(),
  glofoxProvisionStep: vi.fn(),
}))

import { POST as publishRoute } from '@/app/api/sequences/[id]/graph/publish/route.js'
import { runSequences } from '@/lib/sequences/scheduler.js'
import { sendEmailStep } from '@/lib/sequences/steps.js'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { compileGraphToSteps } from '@/lib/sequences/graph/compile'

const MIG_695 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/695_sequence_step_identity.sql'), 'utf8')

const SEQ = 'a0000000-0000-0000-0000-000000000001'
const LOC = 'c0000000-0000-0000-0000-000000000003'
const OWNER = { id: 'b0000000-0000-0000-0000-000000000002', role: 'owner', locations: [{ id: LOC, role: 'owner' }] }
const rid = (n) => `d0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const send = (n) => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`

const trial = () => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'e1', type: 'email', config: { subject: 'Welcome', html_content: '<p>1</p>' } },
    { id: 'w1', type: 'wait', config: { days: 2, hours: 0, minutes: 0 } },
    { id: 'e2', type: 'email', config: { subject: 'Class two', html_content: '<p>2</p>' } },
    { id: 'w2', type: 'wait', config: { days: 3, hours: 0, minutes: 0 } },
    { id: 'e3', type: 'email', config: { subject: 'Last one', html_content: '<p>3</p>' } },
  ],
  edges: [
    { from: 'trigger', to: 'e1' }, { from: 'e1', to: 'w1' }, { from: 'w1', to: 'e2' },
    { from: 'e2', to: 'w2' }, { from: 'w2', to: 'e3' },
  ],
})
// The operator's edit: email 2 reworded, a tag appended after the last email.
const edited = () => {
  const g = trial()
  g.nodes[2] = { id: 'e2', type: 'email', config: { subject: 'Class two, reworded', html_content: '<p>2b</p>' } }
  g.nodes.push({ id: 't1', type: 'apply_tag', config: { tag: 'trial_finished' } })
  g.edges.push({ from: 'e3', to: 't1' })
  return g
}

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE public.email_sequences (id uuid PRIMARY KEY, location_id uuid, graph jsonb);
  CREATE TABLE public.sequence_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id uuid NOT NULL REFERENCES public.email_sequences(id) ON DELETE CASCADE,
    step_order integer NOT NULL, delay_minutes integer DEFAULT 0, delay_type text DEFAULT 'after_previous',
    subject text, design_json jsonb, html_content text, template_id uuid, step_type text DEFAULT 'email',
    total_sent integer DEFAULT 0, total_opened integer DEFAULT 0, total_clicked integer DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    delay_days integer DEFAULT 0, delay_hours integer DEFAULT 0, whatsapp_template_id uuid,
    whatsapp_variables jsonb DEFAULT '{}'::jsonb, whatsapp_header_media_url text, sms_body text,
    config jsonb DEFAULT '{}'::jsonb
  );
  CREATE TRIGGER sequence_steps_updated_at BEFORE UPDATE ON public.sequence_steps
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TABLE public.email_sends (
    id uuid PRIMARY KEY, sequence_id uuid,
    sequence_step_id uuid REFERENCES public.sequence_steps(id) ON DELETE SET NULL
  );
`

let pg
const q = async (sql, params = []) => (await pg.query(sql, params)).rows

/** Seed rows exactly as a pre-695 publish of trial() wrote them. */
async function seedLivePublishedTrial() {
  await q('INSERT INTO public.email_sequences (id, location_id, graph) VALUES ($1, $2, $3)', [SEQ, LOC, JSON.stringify(trial())])
  const rows = compileGraphToSteps(trial())
  for (const [i, r] of rows.entries()) {
    await q(`INSERT INTO public.sequence_steps (id, sequence_id, step_order, step_type, subject, html_content,
      template_id, delay_days, delay_hours, delay_minutes, config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [rid(i + 1), SEQ, r.step_order, r.step_type, r.subject ?? null, r.html_content ?? null, r.template_id ?? null,
      r.delay_days, r.delay_hours, r.delay_minutes, JSON.stringify(r.config)])
  }
  // Sends before the publish: one on step 1, one on step 3, one already orphaned by an earlier publish.
  await q(`INSERT INTO public.email_sends VALUES ($1, $4, $2), ($3, $4, NULL), ($5, $4, $6)`,
    [send(1), rid(1), send(2), SEQ, send(3), rid(3)])
}

const stepRows = () => q('SELECT id, step_order, step_type, graph_node_id, subject FROM public.sequence_steps WHERE sequence_id = $1 ORDER BY step_order', [SEQ])
const sendSteps = async () => Object.fromEntries((await q('SELECT id, sequence_step_id FROM public.email_sends ORDER BY id')).map(r => [r.id, r.sequence_step_id]))

// ── a PostgREST-shaped fake backed by PGlite for the tables this flow needs ──
function chain(resolve) {
  const state = { ops: [] }
  const b = new Proxy({}, {
    get(_, method) {
      if (method === 'then') {
        const p = Promise.resolve().then(() => resolve(state))
        return p.then.bind(p)
      }
      return (...args) => { state.ops.push({ method, args }); return b }
    },
  })
  return b
}
const eqArg = (state, col) => state.ops.find(o => o.method === 'eq' && o.args[0] === col)?.args[1]
const has = (state, m) => state.ops.some(o => o.method === m)

async function readSteps(state) {
  const seq = eqArg(state, 'sequence_id')
  const order = eqArg(state, 'step_order')
  const rows = order === undefined
    ? await q('SELECT * FROM public.sequence_steps WHERE sequence_id = $1', [seq])
    : await q('SELECT * FROM public.sequence_steps WHERE sequence_id = $1 AND step_order = $2', [seq, order])
  if (has(state, 'maybeSingle')) {
    if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } }
    return { data: rows[0] ?? null, error: null }
  }
  return { data: rows, error: null }
}

async function callRpc(fn, args) {
  if (fn !== 'publish_sequence_steps') return { data: null, error: { message: `unknown rpc ${fn}` } }
  try {
    const [r] = await q('SELECT public.publish_sequence_steps($1::uuid, $2::jsonb) AS r', [args.p_sequence_id, JSON.stringify(args.p_steps)])
    return { data: r.r, error: null }
  } catch (e) {
    return { data: null, error: { message: String(e.message || e) } }
  }
}

/** The route's client: email_sequences + sequence_steps + the rpc. */
function routeDb() {
  return {
    rpc: (fn, args) => callRpc(fn, args),
    from: (table) => chain(async (state) => {
      if (table === 'sequence_steps') return readSteps(state)
      if (table === 'email_sequences') {
        if (has(state, 'update')) {
          const patch = state.ops.find(o => o.method === 'update').args[0]
          await q('UPDATE public.email_sequences SET graph = $2 WHERE id = $1', [SEQ, JSON.stringify(patch.graph)])
          return { error: null }
        }
        const [row] = await q('SELECT location_id, graph FROM public.email_sequences WHERE id = $1', [SEQ])
        return { data: { ...row, draft_graph: null }, error: null }
      }
      throw new Error(`publish touched ${table}`)
    }),
  }
}

/** The runner's client: one due enrolment on step 2; steps from PGlite. */
function runnerDb(enrollment, updates) {
  return {
    rpc: () => Promise.resolve({ error: null }),
    from: (table) => chain(async (state) => {
      if (table === 'sequence_steps') return readSteps(state)
      if (table === 'sequence_enrollments') {
        const first = state.ops[0]
        if (first.method === 'select') return { data: [enrollment] }
        if (first.method === 'update') { updates.push(first.args[0]); return { data: [{ id: enrollment.id }] } }
        return {}
      }
      if (table === 'email_sequences') {
        return { data: { id: SEQ, status: 'active', location_id: LOC, goal_config: null, send_window: null } }
      }
      if (table === 'contacts') return { data: { id: 'c1', location_id: LOC } }
      if (table === 'locations') return { data: { settings: {} } }
      return {}
    }),
  }
}

const publish = (graph) => publishRoute(
  new Request(`http://localhost/api/sequences/${SEQ}/graph/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph }),
  }),
  { params: { id: SEQ } },
)

beforeEach(async () => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
  pg = new PGlite()
  await pg['exec'](SCHEMA)
  await pg['exec'](MIG_695)
  await seedLivePublishedTrial()
})
afterEach(async () => { await pg.close() })

describe('republishing the live trial with an enrolment in flight', () => {
  it('keeps every row id, so the sends before the publish keep their step', async () => {
    createServerClient.mockReturnValue(routeDb())
    const res = await publish(edited())
    expect(res.status).toBe(200)

    expect((await stepRows()).map(r => [r.step_order, r.id, r.graph_node_id])).toEqual([
      [1, rid(1), 'e1'], [2, rid(2), 'w1'], [3, rid(3), 'e2'], [4, rid(4), 'w2'], [5, rid(5), 'e3'],
      [6, expect.any(String), 't1'],
    ])
    expect((await stepRows())[5].id).not.toMatch(/^d0000000/)
    // Forward only: the send already orphaned stays NULL.
    expect(await sendSteps()).toEqual({ [send(1)]: rid(1), [send(2)]: null, [send(3)]: rid(3) })
  })

  it('the enrolment on step 2 next runs step 3 with the NEW content under the ORIGINAL row id', async () => {
    createServerClient.mockReturnValue(routeDb())
    await publish(edited())

    const enrollment = {
      id: 'en-1', sequence_id: SEQ, contact_id: 'c1', current_step_order: 2,
      error_count: 0, status: 'active', metadata: null,
    }
    const updates = []
    createServerClient.mockReturnValue(runnerDb(enrollment, updates))
    vi.mocked(sendEmailStep).mockResolvedValue(send(9))

    const stats = await runSequences({ now: new Date('2026-10-02T10:00:00Z') })

    expect(stats.errored).toBe(0)
    expect(sendEmailStep).toHaveBeenCalledTimes(1)
    const { step } = vi.mocked(sendEmailStep).mock.calls[0][1]
    expect(step.id).toBe(rid(3))          // the same step the earlier send(3) points at
    expect(step.subject).toBe('Class two, reworded')
    const advance = updates.find(u => 'current_step_order' in u)
    expect(advance).toMatchObject({ current_step_order: 3, status: 'active' })
  })

  it('a second publish keeps the ids again (rows now carry their node id)', async () => {
    createServerClient.mockReturnValue(routeDb())
    await publish(edited())
    const after1 = (await stepRows()).map(r => r.id)

    createServerClient.mockReturnValue(routeDb())
    const g = edited()
    g.nodes[4] = { id: 'e3', type: 'email', config: { subject: 'Last one, v2', html_content: '<p>3b</p>' } }
    await publish(g)

    const after2 = await stepRows()
    expect(after2.map(r => r.id)).toEqual(after1)
    expect(after2[4].subject).toBe('Last one, v2')
  })

  it('removing a node deletes only its row; its sends go NULL as before', async () => {
    createServerClient.mockReturnValue(routeDb())
    const g = trial()
    g.nodes = g.nodes.filter(n => !['w1', 'e2'].includes(n.id))
    g.edges = [{ from: 'trigger', to: 'e1' }, { from: 'e1', to: 'w2' }, { from: 'w2', to: 'e3' }]
    await publish(g)

    expect((await stepRows()).map(r => [r.step_order, r.id])).toEqual([[1, rid(1)], [2, rid(4)], [3, rid(5)]])
    expect(await sendSteps()).toEqual({ [send(1)]: rid(1), [send(2)]: null, [send(3)]: null })
  })
})
