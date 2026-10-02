// STEPATTRIB.1 review — differential: an in-place publish (the real planner +
// the real mig 698 function, in PGlite) leaves sequence_steps CONTENT-IDENTICAL
// to what the old delete-all + insert wrote, across random builder edits
// (delete a node, insert one anywhere incl. before an enrolment's cursor, edit,
// retype in place, reorder, branches with yes/no lanes that rejoin or end).
// The runner is step_order-driven and reads only these columns, so an in-flight
// enrolment on step k gets exactly the step k+1 it got before this change; the
// only difference is that a kept node keeps its row id (asserted too), so its
// sends keep their step. Rows start as a pre-698 publish wrote them (no node
// id), so round 0 also exercises adoption from the stored graph. Seeded PRNG:
// a failure names its seed. Fictional ids only: the repo is public.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { compileGraphToSteps } from '@/lib/sequences/graph/compile'
import { planStepPublish, STEP_IDENTITY_COLUMNS } from '@/lib/sequences/graph/step-identity'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/698_sequence_step_identity.sql'), 'utf8')
const SEQ = 'a0000000-0000-0000-0000-000000000001'
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE public.email_sequences (id uuid PRIMARY KEY, graph jsonb);
  CREATE TABLE public.sequence_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id uuid NOT NULL REFERENCES public.email_sequences(id) ON DELETE CASCADE,
    step_order integer NOT NULL, delay_minutes integer DEFAULT 0, delay_type text DEFAULT 'after_previous',
    subject text, design_json jsonb, html_content text, template_id uuid, step_type text DEFAULT 'email',
    total_sent integer DEFAULT 0, total_opened integer DEFAULT 0, total_clicked integer DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    delay_days integer DEFAULT 0, delay_hours integer DEFAULT 0, whatsapp_template_id uuid,
    whatsapp_variables jsonb DEFAULT '{}'::jsonb, whatsapp_header_media_url text, sms_body text,
    config jsonb DEFAULT '{}'::jsonb);
  CREATE TRIGGER sequence_steps_updated_at BEFORE UPDATE ON public.sequence_steps FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TABLE public.email_sends (id serial PRIMARY KEY, sequence_step_id uuid REFERENCES public.sequence_steps(id) ON DELETE SET NULL);
`
const CONTENT = ['step_order', 'step_type', 'delay_days', 'delay_hours', 'delay_minutes', 'delay_type', 'subject', 'html_content',
  'design_json', 'template_id', 'whatsapp_template_id', 'whatsapp_variables', 'whatsapp_header_media_url', 'sms_body', 'config']

// Deterministic PRNG.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

let nextId = 0
function makeNode(r, type) {
  const id = `n${++nextId}`
  const t = type ?? ['email', 'wait', 'whatsapp', 'apply_tag', 'branch'][Math.floor(r() * 5)]
  const v = Math.floor(r() * 1000)
  const config = {
    email: { subject: `S${v}`, html_content: `<p>${v}</p>` },
    wait: { days: v % 4, hours: v % 3, minutes: 0 },
    whatsapp: { template_id: `e0000000-0000-0000-0000-${String(v).padStart(12, '0')}`, variables: { 1: `v${v}` } },
    apply_tag: { tag: `t${v}` },
    branch: { field: 'tag', op: 'has', value: `b${v}` },
  }[t]
  return { id, type: t, config }
}

/** A builder-shaped graph: a main line; a branch's yes arm continues the line, its no arm is 0-2 nodes that rejoin or end. */
function linearize(r, line) {
  const nodes = []; const edges = []
  let prev = 'trigger'
  const link = (from, to, label) => edges.push(label ? { from, to, label } : { from, to })
  for (let i = 0; i < line.length; i++) {
    const n = line[i]; nodes.push(n)
    if (prev) link(prev.from ?? prev, n.id, prev.label)
    if (n.type === 'branch') {
      const rejoin = line[i + 1]?.id
      const arm = n.noArm || []
      let p = { from: n.id, label: 'no' }
      for (const a of arm) { nodes.push(a); link(p.from, a.id, p.label); p = { from: a.id } }
      if (rejoin && arm.length && r() < 0.5) link(p.from, rejoin)
      if (rejoin && !arm.length) link(n.id, rejoin, 'no')
      prev = { from: n.id, label: 'yes' }
    } else prev = { from: n.id }
  }
  return { version: 1, trigger: { type: 'manual', config: {} }, nodes, edges }
}

function mutate(r, line) {
  const out = line.map(n => ({ ...n, config: { ...n.config }, noArm: n.noArm?.map(a => ({ ...a })) }))
  const op = Math.floor(r() * 5)
  const at = Math.floor(r() * (out.length + 1))
  if (op === 0 && out.length > 1) out.splice(Math.min(at, out.length - 1), 1) // delete
  else if (op === 1) out.splice(at, 0, makeNode(r)) // insert (incl. before the cursor)
  else if (op === 2 && out.length) { const i = Math.min(at, out.length - 1); out[i] = { ...out[i], config: { ...out[i].config, subject: `edited${at}` } } } // edit
  else if (op === 3 && out.length) { const i = Math.min(at, out.length - 1); const t = makeNode(r); out[i] = { ...t, id: out[i].id } } // retype in place
  else if (out.length > 1) { const i = Math.min(at, out.length - 2); [out[i], out[i + 1]] = [out[i + 1], out[i]] } // reorder
  for (const n of out) if (n.type === 'branch' && !n.noArm) n.noArm = Array.from({ length: Math.floor(r() * 3) }, () => makeNode(r, ['email', 'wait', 'apply_tag'][Math.floor(r() * 3)]))
  return out
}

let pg
const q = async (sql, p = []) => (await pg.query(sql, p)).rows

const norm = (row) => Object.fromEntries(CONTENT.map(c => {
  let v = row[c] ?? null
  if (c === 'delay_type') v = v ?? 'after_previous'
  if (['delay_days', 'delay_hours', 'delay_minutes'].includes(c)) v = Number(v ?? 0)
  if (c === 'whatsapp_variables' || c === 'config') v = JSON.stringify(sortKeys(v ?? {}))
  return [c, v]
}))
function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])); return v }

/** What main wrote: delete all, insert the compiled rows. */
async function mainPublish(graph) {
  await q('DELETE FROM public.sequence_steps WHERE sequence_id = $1', [SEQ])
  for (const s of compileGraphToSteps(graph)) {
    const cols = Object.keys(s)
    await q(`INSERT INTO public.sequence_steps (sequence_id, ${cols.join(',')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')})`,
      [SEQ, ...cols.map(c => (s[c] && typeof s[c] === 'object') ? JSON.stringify(s[c]) : s[c])])
  }
  await q('UPDATE public.email_sequences SET graph = $2 WHERE id = $1', [SEQ, JSON.stringify(graph)])
}
/** What the route now does. */
async function newPublish(graph) {
  const [{ graph: previousGraph }] = await q('SELECT graph FROM public.email_sequences WHERE id = $1', [SEQ])
  const existingRows = await q(`SELECT ${STEP_IDENTITY_COLUMNS} FROM public.sequence_steps WHERE sequence_id = $1`, [SEQ])
  const plan = planStepPublish({ compiled: compileGraphToSteps(graph, { withNodeIds: true }), existingRows, previousGraph })
  await q('SELECT public.publish_sequence_steps($1::uuid, $2::jsonb)', [SEQ, JSON.stringify(plan.steps)])
  await q('UPDATE public.email_sequences SET graph = $2 WHERE id = $1', [SEQ, JSON.stringify(graph)])
}
const rows = () => q('SELECT * FROM public.sequence_steps WHERE sequence_id = $1 ORDER BY step_order', [SEQ])

beforeEach(async () => {
  pg = new PGlite(); await pg['exec'](SCHEMA); await pg['exec'](MIG)
  await q('INSERT INTO public.email_sequences (id) VALUES ($1)', [SEQ])
})
afterEach(async () => { await pg.close() })

describe('an in-place publish equals the old replace, by content, across random edits', () => {
  for (let seed = 1; seed <= 30; seed++) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed)
      let line = mutate(r, Array.from({ length: 2 + Math.floor(r() * 6) }, () => makeNode(r)))
      let graph = linearize(r, line)
      await mainPublish(graph) // pre-698 rows (graph_node_id NULL), as prod holds them
      for (let round = 0; round < 6; round++) {
        const before = await rows()
        const byNodeBefore = new Map(before.filter(x => x.graph_node_id).map(x => [x.graph_node_id, x]))
        for (const x of before) await q('INSERT INTO public.email_sends (sequence_step_id) VALUES ($1)', [x.id])
        line = mutate(r, line)
        const prevGraph = graph
        graph = linearize(r, line)
        await newPublish(graph)
        const got = (await rows()).map(norm)
        // Baseline: what main would have left, compiled fresh.
        const want = compileGraphToSteps(graph).map(s => norm(s))
        expect(got).toEqual(want)
        // Identity: a node present before and after with the same type keeps its row (round 0: via adoption).
        const after = await rows()
        const prevTypes = new Map(prevGraph.nodes.map(n => [n.id, n.type]))
        const reachableBefore = new Set(compileGraphToSteps(prevGraph, { withNodeIds: true }).map(s => s.graph_node_id))
        for (const x of after) {
          expect(x.graph_node_id).toBeTruthy()
          const old = byNodeBefore.get(x.graph_node_id)
          if (round > 0 && old && prevTypes.get(x.graph_node_id) === x.step_type && reachableBefore.has(x.graph_node_id)) expect(x.id).toBe(old.id)
        }
        // No send points at a row of a different node now.
        const dangling = await q(`SELECT count(*)::int n FROM public.email_sends e LEFT JOIN public.sequence_steps s ON s.id = e.sequence_step_id
          WHERE e.sequence_step_id IS NOT NULL AND s.id IS NULL`)
        expect(dangling[0].n).toBe(0)
      }
    })
  }
})
