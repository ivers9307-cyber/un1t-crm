// STEPATTRIB.1 — the publish plan that keeps step rows' ids across publishes.
//
// A graph publish used to delete every sequence_steps row and insert the
// compiled ones. email_sends.sequence_step_id is ON DELETE SET NULL, so every
// earlier send lost its step (22,771 of 22,793 on 30 Sep) and the Performance
// panel's per-step table emptied on each publish. The plan below decides, per
// compiled row, which existing row (if any) it updates in place.
//
// Forward only (Richard, 1 Oct 2026): nothing here re-attributes a send.
// Fictional ids only: the repo is public.

import { describe, it, expect } from 'vitest'
import { planStepPublish } from './step-identity.js'
import { compileGraphToSteps } from './compile.js'

const SEQ = 'a0000000-0000-0000-0000-000000000001'
const rid = (n) => `d0000000-0000-0000-0000-${String(n).padStart(12, '0')}`

// The 3-Class Trial shape: email, wait, email, wait, email.
const trial = (overrides = {}) => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'e1', type: 'email', config: { subject: 'Welcome', html_content: '<p>1</p>' } },
    { id: 'w1', type: 'wait', config: { days: 2 } },
    { id: 'e2', type: 'email', config: { subject: 'Class two', html_content: '<p>2</p>' } },
    { id: 'w2', type: 'wait', config: { days: 3 } },
    { id: 'e3', type: 'email', config: { subject: 'Last one', html_content: '<p>3</p>' } },
  ],
  edges: [
    { from: 'trigger', to: 'e1' }, { from: 'e1', to: 'w1' }, { from: 'w1', to: 'e2' },
    { from: 'e2', to: 'w2' }, { from: 'w2', to: 'e3' },
  ],
  ...overrides,
})

/** DB rows exactly as a publish of `graph` writes them (what prod holds). */
function rowsOf(graph, { withNodeIds = true, firstId = 1 } = {}) {
  return compileGraphToSteps(graph, { withNodeIds: true }).map((r, i) => {
    const row = {
      id: rid(firstId + i), sequence_id: SEQ,
      subject: null, html_content: null, template_id: null, whatsapp_template_id: null,
      whatsapp_variables: {}, whatsapp_header_media_url: null, sms_body: null,
      config: {}, ...r,
    }
    if (!withNodeIds) row.graph_node_id = null
    return row
  })
}

const plan = (graph, existingRows, previousGraph = null) => planStepPublish({
  compiled: compileGraphToSteps(graph, { withNodeIds: true }),
  existingRows,
  previousGraph,
})
const idsByNode = (p) => Object.fromEntries(p.steps.map(s => [s.graph_node_id, s.id ?? null]))

describe('planStepPublish — rows that already carry their node id', () => {
  it('republishing an unchanged graph updates every row in place (same ids, nothing removed)', () => {
    const rows = rowsOf(trial())
    const p = plan(trial(), rows)
    expect(p.steps.map(s => s.id)).toEqual(rows.map(r => r.id))
    expect(p.removed).toEqual([])
    expect(p.inserted).toBe(0)
  })

  it('an edited node keeps its row id and carries the new content', () => {
    const rows = rowsOf(trial())
    const edited = trial()
    edited.nodes[4] = { id: 'e3', type: 'email', config: { subject: 'Last one, edited', html_content: '<p>3b</p>' } }
    const p = plan(edited, rows)
    const e3 = p.steps.find(s => s.graph_node_id === 'e3')
    expect(e3.id).toBe(rid(5))
    expect(e3.subject).toBe('Last one, edited')
  })

  it('a node inserted mid-flow gets a new row; the kept rows keep their ids at their new orders', () => {
    const rows = rowsOf(trial())
    const g = trial()
    g.nodes.splice(1, 0, { id: 'x1', type: 'apply_tag', config: { tag: 'welcomed' } })
    g.edges = [
      { from: 'trigger', to: 'e1' }, { from: 'e1', to: 'x1' }, { from: 'x1', to: 'w1' }, { from: 'w1', to: 'e2' },
      { from: 'e2', to: 'w2' }, { from: 'w2', to: 'e3' },
    ]
    const p = plan(g, rows)
    expect(idsByNode(p)).toEqual({ e1: rid(1), x1: null, w1: rid(2), e2: rid(3), w2: rid(4), e3: rid(5) })
    expect(p.steps.find(s => s.graph_node_id === 'e3').step_order).toBe(6)
    expect(p.inserted).toBe(1)
    expect(p.removed).toEqual([])
  })

  it('a removed node is the only row removed', () => {
    const rows = rowsOf(trial())
    const g = trial()
    g.nodes = g.nodes.filter(n => !['w2', 'e3'].includes(n.id))
    g.edges = g.edges.filter(e => !['w2', 'e3'].includes(e.to))
    const p = plan(g, rows)
    expect(p.steps.map(s => s.id)).toEqual([rid(1), rid(2), rid(3)])
    expect(p.removed.sort()).toEqual([rid(4), rid(5)])
  })

  it('a node whose type changed gets a new row (a WhatsApp step never inherits an email step\'s sends)', () => {
    const rows = rowsOf(trial())
    const g = trial()
    g.nodes[0] = { id: 'e1', type: 'whatsapp', config: { template_id: 'wt-1', variables: {} } }
    const p = plan(g, rows)
    expect(idsByNode(p).e1).toBeNull()
    expect(p.removed).toEqual([rid(1)])
  })

  it('adopts at most one row per node when rows share a node id (defensive: the index forbids it)', () => {
    const rows = rowsOf(trial())
    rows.push({ ...rows[0], id: rid(99), step_order: 99 })
    const p = plan(trial(), rows)
    expect(idsByNode(p).e1).toBe(rid(1))
    expect(p.removed).toEqual([rid(99)])
  })
})

describe('planStepPublish — rows from before STEPATTRIB.1 (graph_node_id NULL)', () => {
  it('adopts every row the stored published graph compiles to (prod: 33 of 33 on 2 Oct)', () => {
    const rows = rowsOf(trial(), { withNodeIds: false })
    const p = plan(trial(), rows, trial())
    expect(p.steps.map(s => s.id)).toEqual(rows.map(r => r.id))
    expect(p.adopted).toBe(5)
    expect(p.removed).toEqual([])
  })

  it('adopts through an edit: the previous graph identifies the row, the new graph rewrites it', () => {
    const rows = rowsOf(trial(), { withNodeIds: false })
    const g = trial()
    g.nodes[2] = { id: 'e2', type: 'email', config: { subject: 'Class two, v2', html_content: '<p>2b</p>' } }
    const p = plan(g, rows, trial())
    expect(idsByNode(p).e2).toBe(rid(3))
    expect(p.steps.find(s => s.graph_node_id === 'e2').subject).toBe('Class two, v2')
  })

  it('does not adopt a row the previous graph does not reproduce (edited outside the builder)', () => {
    const rows = rowsOf(trial(), { withNodeIds: false })
    rows[2] = { ...rows[2], subject: 'changed by a legacy step route' }
    const p = plan(trial(), rows, trial())
    expect(idsByNode(p).e2).toBeNull()
    expect(p.removed).toEqual([rid(3)])
    expect(p.adopted).toBe(4)
  })

  it('compares config by value, not key order (jsonb comes back reordered)', () => {
    const g = trial()
    g.nodes.push({ id: 't1', type: 'apply_tag', config: { tag: 'done', mode: 'add' } })
    g.edges.push({ from: 'e3', to: 't1' })
    const rows = rowsOf(g, { withNodeIds: false })
    const t1 = rows.find(r => r.step_type === 'apply_tag')
    t1.config = { next_step_order: 'end', mode: 'add', tag: 'done' }
    const p = plan(g, rows, g)
    expect(p.adopted).toBe(6)
  })

  it('adopts nothing when the sequence was never published from the builder (no stored graph)', () => {
    const rows = rowsOf(trial(), { withNodeIds: false })
    const p = plan(trial(), rows, null)
    expect(p.steps.every(s => s.id === undefined)).toBe(true)
    expect(p.removed).toHaveLength(5)
  })

  it('adopts nothing, and does not throw, when the stored graph cannot be compiled', () => {
    const rows = rowsOf(trial(), { withNodeIds: false })
    const p = plan(trial(), rows, { nodes: 'not an array' })
    expect(p.adopted).toBe(0)
    expect(p.removed).toHaveLength(5)
  })

  it('does not adopt when two legacy rows share the step_order the graph points at', () => {
    const rows = rowsOf(trial(), { withNodeIds: false })
    rows.push({ ...rows[0], id: rid(50) })
    const p = plan(trial(), rows, trial())
    expect(idsByNode(p).e1).toBeNull()
    expect(p.adopted).toBe(4)
  })

  it('never adopts a legacy row for a node another row already carries', () => {
    const rows = rowsOf(trial())
    rows.push({ ...rows[0], id: rid(60), graph_node_id: null })
    const p = plan(trial(), rows, trial())
    expect(idsByNode(p).e1).toBe(rid(1))
    expect(p.removed).toEqual([rid(60)])
  })
})
