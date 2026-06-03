# Sequencing Flow-Graph — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, fully-tested node-graph foundation for the sequencing redesign — a declarative graph that compiles to the existing `sequence_steps` the runner already executes — without touching the runner.

**Architecture:** A flow is a declarative graph (`{ trigger, nodes[], edges[] }`). Three pure functions in `src/lib/sequences/graph/`: `validateGraph` (shared by builder/agent/publish), `compileGraphToSteps` (graph → existing `sequence_steps` rows), `decompileStepsToGraph` (existing steps → graph, for backfill + rendering legacy flows). Plus migration 245 adding `graph`/`draft_graph`/`graph_version` columns to `email_sequences`, and a one-time backfill. **The runner (`scheduler.js`, `steps.js`) is NOT modified in this phase.**

**Tech Stack:** Node ESM, Vitest (pure unit tests, no DB), Zod (structural schema — already a dep), Supabase migration SQL.

---

## Background the implementer must read first

The runner executes `sequence_steps` rows. Each row has these columns (confirmed live in `steps.js`):

| Column | Used by step_type | Notes |
|---|---|---|
| `step_order` (int) | all | execution order; branch jumps via config pointers |
| `step_type` (text) | all | one of the 10 node types |
| `delay_days` / `delay_hours` / `delay_minutes` (int) | `wait` (and any step's pre-delay) | |
| `subject` (text), `html_content` (text), `template_id` (uuid) | `email` | template_id OR inline html |
| `whatsapp_template_id` (uuid), `whatsapp_variables` (jsonb), `whatsapp_header_media_url` (text) | `whatsapp` | |
| `sms_body` (text) | `sms` | |
| `config` (jsonb) | `apply_tag`, `update_field`, `branch`, `webhook`, `internal_task`, `move_pipeline_stage` | per-type config object |

Per-type `config` contract (from `steps.js`):

| step_type | config keys |
|---|---|
| `apply_tag` | `{ tag }` |
| `update_field` | `{ field, value }` |
| `branch` | `{ predicate, then_step_order, else_step_order }` — `predicate` is `{ type:'has_tag', tag }` \| `{ type:'field_equals', field, value }` \| `{ type:'field_in', field, values[] }`. `then_step_order` = the YES target's step_order, `else_step_order` = the NO target's step_order. **Both must be > the branch's own step_order** (runner loop-guard). |
| `webhook` | `{ url, method, ... }` (url required, https) |
| `internal_task` | `{ subject, ... }` (subject required) |
| `move_pipeline_stage` | `{ stage_slug }` |

**The graph model maps onto this:** channel nodes (`email`/`whatsapp`/`sms`/`wait`) carry their content in `node.config` and compile to the dedicated columns; data/logic nodes (`apply_tag`/`update_field`/`branch`/`webhook`/`internal_task`/`move_pipeline_stage`) carry `node.config` that compiles to the `config` jsonb. `branch` is special: its two out-edges (`label:'yes'|'no'`) compile to `config.then_step_order`/`config.else_step_order`.

The graph shape (canonical — this is also the agent's write contract):

```jsonc
{
  "version": 1,
  "trigger": { "type": "booking_created", "config": { } },
  "nodes": [ { "id": "n1", "type": "wait", "config": { "days": 0, "hours": 1, "minutes": 0 } }, … ],
  "edges": [ { "from": "trigger", "to": "n1" }, { "from": "n4", "to": "n5", "label": "yes" }, … ]
}
```

- Reserved source id for trigger edges: the string `"trigger"`.
- A non-branch node has 0 or 1 out-edge (0 = terminal). A `branch` node has exactly 2 out-edges, labelled `yes` and `no`.

---

## File Structure

```
src/lib/sequences/graph/
  schema.js        — type constants + Zod structural schema + small predicates (pure)
  schema.test.js
  validate.js      — validateGraph(graph) → { ok, errors[] }  (pure)
  validate.test.js
  compile.js       — compileGraphToSteps(graph) → stepRow[]   (pure)
  compile.test.js
  decompile.js     — decompileStepsToGraph(steps, trigger) → graph  (pure)
  decompile.test.js
  roundtrip.test.js — compile(decompile(steps)) ≈ steps  (golden fixtures)
  index.js         — barrel re-exporting the public functions
supabase/migrations/245_sequence_graph_columns.sql
scripts/backfill-sequence-graphs.mjs   — one-time backfill (uses decompile)
src/lib/sequences/graph/backfill.js     — buildBackfillUpdates() (pure, tested)
src/lib/sequences/graph/backfill.test.js
```

Each file has one responsibility. All logic is pure → unit-tested with no DB. The migration + script are the only non-pure pieces.

---

## Task 1: Schema constants + Zod structural schema

**Files:**
- Create: `src/lib/sequences/graph/schema.js`
- Test: `src/lib/sequences/graph/schema.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/sequences/graph/schema.test.js
import { describe, it, expect } from 'vitest'
import {
  NODE_TYPES, TRIGGER_TYPES, CHANNEL_NODE_TYPES, CONFIG_NODE_TYPES,
  TRIGGER_SOURCE_ID, isChannelNode, parseGraphShape,
} from './schema.js'

describe('graph schema constants', () => {
  it('lists the 10 node types', () => {
    expect(NODE_TYPES).toEqual([
      'email', 'whatsapp', 'sms', 'wait', 'apply_tag', 'update_field',
      'internal_task', 'webhook', 'branch', 'move_pipeline_stage',
    ])
  })
  it('splits channel vs config nodes', () => {
    expect(CHANNEL_NODE_TYPES).toEqual(['email', 'whatsapp', 'sms', 'wait'])
    expect(CONFIG_NODE_TYPES).toContain('branch')
    expect(CONFIG_NODE_TYPES).not.toContain('email')
    expect(isChannelNode('sms')).toBe(true)
    expect(isChannelNode('branch')).toBe(false)
  })
  it('includes the engine trigger vocabulary', () => {
    for (const t of ['manual', 'booking_created', 'pipeline_stage_change', 'tag_added',
      'event_reminder', 'segment_added', 'segment_removed', 'anniversary', 'inactivity']) {
      expect(TRIGGER_TYPES).toContain(t)
    }
  })
  it('reserves the trigger source id', () => {
    expect(TRIGGER_SOURCE_ID).toBe('trigger')
  })
})

describe('parseGraphShape', () => {
  const good = {
    version: 1,
    trigger: { type: 'manual', config: {} },
    nodes: [{ id: 'n1', type: 'sms', config: { body: 'hi' } }],
    edges: [{ from: 'trigger', to: 'n1' }],
  }
  it('accepts a well-formed graph', () => {
    const r = parseGraphShape(good)
    expect(r.ok).toBe(true)
  })
  it('rejects a missing trigger', () => {
    const r = parseGraphShape({ version: 1, nodes: [], edges: [] })
    expect(r.ok).toBe(false)
  })
  it('rejects an unknown node type', () => {
    const r = parseGraphShape({ ...good, nodes: [{ id: 'n1', type: 'telepathy', config: {} }] })
    expect(r.ok).toBe(false)
  })
  it('rejects an edge label that is not yes/no', () => {
    const r = parseGraphShape({ ...good, edges: [{ from: 'trigger', to: 'n1', label: 'maybe' }] })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/schema.test.js`
Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/sequences/graph/schema.js
//
// FLOW-GRAPH.1 — the canonical node-graph vocabulary + structural (shape)
// validation. Semantic validation (topology, reachability, per-type
// required config) lives in validate.js. This module is pure.
import { z } from 'zod'

export const CHANNEL_NODE_TYPES = ['email', 'whatsapp', 'sms', 'wait']
export const CONFIG_NODE_TYPES = [
  'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch', 'move_pipeline_stage',
]
// Order matters for the test + for stable UI listing.
export const NODE_TYPES = [
  'email', 'whatsapp', 'sms', 'wait',
  'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch', 'move_pipeline_stage',
]

// The engine's trigger vocabulary (triggers.js + cron-triggers.js). Kept as a
// flat list; trigger-specific config is validated per-type in validate.js.
export const TRIGGER_TYPES = [
  'manual', 'booking_created', 'pipeline_stage_change', 'tag_added', 'event_reminder',
  'segment_added', 'segment_removed', 'anniversary', 'inactivity', 'webhook',
  'race_registered', 'race_finished', 'order_status', 'first_booking', 'achievement',
]

export const TRIGGER_SOURCE_ID = 'trigger'

export function isChannelNode(type) {
  return CHANNEL_NODE_TYPES.includes(type)
}

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  config: z.object({}).passthrough().default({}),
  // optional UI hint; ignored by compile/runner
  position: z.object({ x: z.number(), y: z.number() }).optional(),
})

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.enum(['yes', 'no']).optional(),
})

const graphSchema = z.object({
  version: z.number().int().positive(),
  trigger: z.object({ type: z.enum(TRIGGER_TYPES), config: z.object({}).passthrough().default({}) }),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
})

/** Structural (shape) validation only. Returns { ok, data?, error? }. */
export function parseGraphShape(graph) {
  const r = graphSchema.safeParse(graph)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/schema.test.js`
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/graph/schema.js src/lib/sequences/graph/schema.test.js
git commit -m "FLOW-GRAPH.1 — graph vocabulary + structural Zod schema"
```

---

## Task 2: `validateGraph` — semantic validation

**Files:**
- Create: `src/lib/sequences/graph/validate.js`
- Test: `src/lib/sequences/graph/validate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/sequences/graph/validate.test.js
import { describe, it, expect } from 'vitest'
import { validateGraph } from './validate.js'

const base = () => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'n1', type: 'sms', config: { body: 'hi' } },
  ],
  edges: [{ from: 'trigger', to: 'n1' }],
})
const codes = (g) => validateGraph(g).errors.map(e => e.code)

describe('validateGraph', () => {
  it('accepts a minimal valid graph', () => {
    expect(validateGraph(base())).toEqual({ ok: true, errors: [] })
  })

  it('rejects a structurally invalid graph (shape)', () => {
    const r = validateGraph({ nodes: [] })
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('shape')
  })

  it('flags an edge to a non-existent node', () => {
    const g = base(); g.edges.push({ from: 'n1', to: 'ghost' })
    expect(codes(g)).toContain('edge_unknown_target')
  })

  it('flags a duplicate node id', () => {
    const g = base(); g.nodes.push({ id: 'n1', type: 'wait', config: { days: 1 } })
    expect(codes(g)).toContain('duplicate_node_id')
  })

  it('flags an orphan (unreachable from trigger)', () => {
    const g = base(); g.nodes.push({ id: 'n2', type: 'sms', config: { body: 'x' } })
    expect(codes(g)).toContain('orphan_node')
  })

  it('flags a non-branch node with two out-edges', () => {
    const g = base()
    g.nodes.push({ id: 'n2', type: 'sms', config: { body: 'a' } })
    g.nodes.push({ id: 'n3', type: 'sms', config: { body: 'b' } })
    g.edges.push({ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' })
    expect(codes(g)).toContain('too_many_out_edges')
  })

  it('flags a branch missing the no lane', () => {
    const g = base()
    g.nodes[0] = { id: 'n1', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'vip' } } }
    g.nodes.push({ id: 'n2', type: 'sms', config: { body: 'yes' } })
    g.edges.push({ from: 'n1', to: 'n2', label: 'yes' })
    expect(codes(g)).toContain('branch_missing_lane')
  })

  it('flags a cycle (loop guard)', () => {
    const g = base()
    g.nodes.push({ id: 'n2', type: 'wait', config: { days: 1 } })
    g.edges.push({ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' })
    expect(codes(g)).toContain('cycle')
  })

  it('flags missing required config per type', () => {
    expect(codes({ ...base(), nodes: [{ id: 'n1', type: 'apply_tag', config: {} }] }))
      .toContain('missing_config')
    expect(codes({ ...base(), nodes: [{ id: 'n1', type: 'sms', config: {} }] }))
      .toContain('missing_config')
    expect(codes({ ...base(), nodes: [{ id: 'n1', type: 'webhook', config: { url: 'http://x' } }] }))
      .toContain('missing_config') // non-https rejected
  })

  it('attaches the offending nodeId to node-scoped errors', () => {
    const g = base(); g.nodes[0].config = {}
    const err = validateGraph(g).errors.find(e => e.code === 'missing_config')
    expect(err.nodeId).toBe('n1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/validate.test.js`
Expected: FAIL — `Cannot find module './validate.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/sequences/graph/validate.js
//
// FLOW-GRAPH.2 — semantic validation of a flow graph. Shared by the
// builder (inline red flags), the agent (self-correct loop), and publish
// (the gate). Pure. Returns { ok, errors: [{ code, nodeId?, message }] }.
import { parseGraphShape, isChannelNode, TRIGGER_SOURCE_ID } from './schema.js'

function requiredConfigError(node) {
  const c = node.config || {}
  const need = (cond, msg) => (cond ? null : msg)
  switch (node.type) {
    case 'email':
      return need(c.subject || c.template_id, 'email needs a subject or a template')
    case 'whatsapp':
      return need(c.template_id || c.whatsapp_template_id, 'WhatsApp needs a template')
    case 'sms':
      return need(typeof c.body === 'string' && c.body.trim(), 'SMS needs a body')
    case 'wait':
      return need((c.days || c.hours || c.minutes), 'wait needs a non-zero delay')
    case 'apply_tag':
      return need(c.tag && String(c.tag).trim(), 'apply_tag needs a tag')
    case 'update_field':
      return need(c.field && String(c.field).trim(), 'update_field needs a field')
    case 'internal_task':
      return need(c.subject && String(c.subject).trim(), 'task needs a subject')
    case 'move_pipeline_stage':
      return need(c.stage_slug && String(c.stage_slug).trim(), 'move_pipeline_stage needs a stage_slug')
    case 'webhook':
      return need(typeof c.url === 'string' && /^https:\/\//.test(c.url), 'webhook needs an https url')
    case 'branch':
      return need(c.predicate && c.predicate.type, 'branch needs a predicate')
    default:
      return null
  }
}

export function validateGraph(graph) {
  const shape = parseGraphShape(graph)
  if (!shape.ok) {
    return { ok: false, errors: [{ code: 'shape', message: shape.error.message }] }
  }
  const g = shape.data
  const errors = []
  const push = (code, message, nodeId) => errors.push(nodeId ? { code, nodeId, message } : { code, message })

  // unique ids
  const ids = new Set()
  for (const n of g.nodes) {
    if (ids.has(n.id)) push('duplicate_node_id', `duplicate node id "${n.id}"`, n.id)
    ids.add(n.id)
  }
  const known = new Set([TRIGGER_SOURCE_ID, ...g.nodes.map(n => n.id)])

  // edges reference known nodes
  for (const e of g.edges) {
    if (!known.has(e.from)) push('edge_unknown_source', `edge from unknown node "${e.from}"`)
    if (!known.has(e.to)) push('edge_unknown_target', `edge to unknown node "${e.to}"`)
  }

  // out-edge cardinality + branch lanes
  const outByNode = new Map()
  for (const e of g.edges) {
    if (!outByNode.has(e.from)) outByNode.set(e.from, [])
    outByNode.get(e.from).push(e)
  }
  for (const n of g.nodes) {
    const outs = outByNode.get(n.id) || []
    if (n.type === 'branch') {
      const labels = new Set(outs.map(o => o.label))
      if (outs.length !== 2 || !labels.has('yes') || !labels.has('no')) {
        push('branch_missing_lane', 'branch needs exactly one yes and one no out-edge', n.id)
      }
    } else if (outs.length > 1) {
      push('too_many_out_edges', `${n.type} node has more than one out-edge`, n.id)
    }
    const cfgErr = requiredConfigError(n)
    if (cfgErr) push('missing_config', cfgErr, n.id)
  }

  // reachability from trigger (BFS over edges)
  const adj = new Map()
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e.to)
  }
  const seen = new Set([TRIGGER_SOURCE_ID])
  const queue = [TRIGGER_SOURCE_ID]
  while (queue.length) {
    const cur = queue.shift()
    for (const to of (adj.get(cur) || [])) {
      if (!seen.has(to)) { seen.add(to); queue.push(to) }
    }
  }
  for (const n of g.nodes) {
    if (!seen.has(n.id)) push('orphan_node', `node "${n.id}" is unreachable from the trigger`, n.id)
  }

  // cycle detection (DFS colouring) over the node graph
  const WHITE = 0, GREY = 1, BLACK = 2
  const colour = new Map(g.nodes.map(n => [n.id, WHITE]))
  let cyclic = false
  const dfs = (id) => {
    colour.set(id, GREY)
    for (const to of (adj.get(id) || [])) {
      if (to === TRIGGER_SOURCE_ID) continue
      if (colour.get(to) === GREY) { cyclic = true; return }
      if (colour.get(to) === WHITE) dfs(to)
    }
    colour.set(id, BLACK)
  }
  for (const n of g.nodes) if (colour.get(n.id) === WHITE) dfs(n.id)
  if (cyclic) push('cycle', 'the flow contains a loop — steps must always move forward')

  return { ok: errors.length === 0, errors }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/validate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/graph/validate.js src/lib/sequences/graph/validate.test.js
git commit -m "FLOW-GRAPH.2 — validateGraph (shape + topology + per-type config)"
```

---

## Task 3: `compileGraphToSteps`

**Files:**
- Create: `src/lib/sequences/graph/compile.js`
- Test: `src/lib/sequences/graph/compile.test.js`

The compiler does a deterministic topological walk from `trigger`, assigning `step_order = 1..N`. For each node it emits a `sequence_steps`-shaped row (the columns from the Background table). For a `branch`, it sets `config.then_step_order` (yes target) and `config.else_step_order` (no target).

**Determinism rule:** visit in BFS order from trigger; for a branch, enqueue the `yes` target before the `no` target. This guarantees branch targets get a higher step_order than the branch (satisfying the runner loop-guard) for any acyclic graph, and produces stable output.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/sequences/graph/compile.test.js
import { describe, it, expect } from 'vitest'
import { compileGraphToSteps } from './compile.js'

const linear = {
  version: 1,
  trigger: { type: 'booking_created', config: {} },
  nodes: [
    { id: 'a', type: 'wait', config: { days: 0, hours: 1, minutes: 0 } },
    { id: 'b', type: 'sms', config: { body: 'hello' } },
  ],
  edges: [{ from: 'trigger', to: 'a' }, { from: 'a', to: 'b' }],
}

const branched = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'br', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'attended' } } },
    { id: 'y', type: 'email', config: { subject: 'How was it?', template_id: 't1' } },
    { id: 'n', type: 'sms', config: { body: 'come back' } },
  ],
  edges: [
    { from: 'trigger', to: 'br' },
    { from: 'br', to: 'y', label: 'yes' },
    { from: 'br', to: 'n', label: 'no' },
  ],
}

describe('compileGraphToSteps', () => {
  it('assigns sequential step_order from the trigger', () => {
    const steps = compileGraphToSteps(linear)
    expect(steps.map(s => [s.step_order, s.step_type])).toEqual([[1, 'wait'], [2, 'sms']])
  })
  it('maps channel-node config to the dedicated columns', () => {
    const steps = compileGraphToSteps(linear)
    expect(steps[0]).toMatchObject({ step_type: 'wait', delay_hours: 1, delay_days: 0, delay_minutes: 0 })
    expect(steps[1]).toMatchObject({ step_type: 'sms', sms_body: 'hello' })
  })
  it('compiles a branch to then/else step_order pointers (yes before no)', () => {
    const steps = compileGraphToSteps(branched)
    const br = steps.find(s => s.step_type === 'branch')
    const yes = steps.find(s => s.step_type === 'email')
    const no = steps.find(s => s.step_type === 'sms')
    expect(br.config.then_step_order).toBe(yes.step_order)
    expect(br.config.else_step_order).toBe(no.step_order)
    expect(br.config.then_step_order).toBeGreaterThan(br.step_order) // loop guard
    expect(br.config.else_step_order).toBeGreaterThan(br.step_order)
    expect(br.config.predicate).toEqual({ type: 'has_tag', tag: 'attended' })
  })
  it('puts data-node config in the config column', () => {
    const g = { ...linear, nodes: [{ id: 'a', type: 'apply_tag', config: { tag: 'vip' } }], edges: [{ from: 'trigger', to: 'a' }] }
    expect(compileGraphToSteps(g)[0]).toMatchObject({ step_type: 'apply_tag', config: { tag: 'vip' } })
  })
  it('is deterministic (stable order across runs)', () => {
    expect(compileGraphToSteps(branched)).toEqual(compileGraphToSteps(branched))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/compile.test.js`
Expected: FAIL — `Cannot find module './compile.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/sequences/graph/compile.js
//
// FLOW-GRAPH.3 — compile a flow graph into sequence_steps rows that the
// existing runner executes unchanged. Pure. Channel nodes map to dedicated
// columns; data/logic nodes map to the config jsonb; branch out-edges map
// to config.then_step_order / config.else_step_order. Deterministic BFS,
// enqueueing a branch's `yes` target before its `no` target.
import { isChannelNode, TRIGGER_SOURCE_ID } from './schema.js'

function outEdges(edges, from) {
  return edges.filter(e => e.from === from)
}

// BFS order from trigger → array of node ids, stable.
function orderNodes(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const order = []
  const seen = new Set()
  const queue = [...outEdges(graph.edges, TRIGGER_SOURCE_ID).map(e => e.to)]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    order.push(id)
    const node = byId.get(id)
    const outs = outEdges(graph.edges, id)
    if (node.type === 'branch') {
      const yes = outs.find(o => o.label === 'yes')
      const no = outs.find(o => o.label === 'no')
      if (yes) queue.push(yes.to)
      if (no) queue.push(no.to)
    } else {
      for (const o of outs) queue.push(o.to)
    }
  }
  return order
}

function channelColumns(node) {
  const c = node.config || {}
  switch (node.type) {
    case 'email':
      return { subject: c.subject ?? null, html_content: c.html_content ?? null, template_id: c.template_id ?? null }
    case 'whatsapp':
      return {
        whatsapp_template_id: c.template_id ?? c.whatsapp_template_id ?? null,
        whatsapp_variables: c.variables ?? c.whatsapp_variables ?? {},
        whatsapp_header_media_url: c.header_media_url ?? null,
      }
    case 'sms':
      return { sms_body: c.body ?? null }
    case 'wait':
      return { delay_days: c.days ?? 0, delay_hours: c.hours ?? 0, delay_minutes: c.minutes ?? 0 }
    default:
      return {}
  }
}

export function compileGraphToSteps(graph) {
  const order = orderNodes(graph)
  const stepOrderById = new Map(order.map((id, i) => [id, i + 1]))
  const byId = new Map(graph.nodes.map(n => [n.id, n]))

  return order.map((id) => {
    const node = byId.get(id)
    const row = {
      step_order: stepOrderById.get(id),
      step_type: node.type,
      delay_days: 0, delay_hours: 0, delay_minutes: 0,
    }
    if (isChannelNode(node.type)) {
      Object.assign(row, channelColumns(node))
    } else if (node.type === 'branch') {
      const outs = outEdges(graph.edges, id)
      const yes = outs.find(o => o.label === 'yes')
      const no = outs.find(o => o.label === 'no')
      row.config = {
        ...(node.config || {}),
        then_step_order: yes ? stepOrderById.get(yes.to) : null,
        else_step_order: no ? stepOrderById.get(no.to) : null,
      }
    } else {
      row.config = { ...(node.config || {}) }
    }
    return row
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/compile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/graph/compile.js src/lib/sequences/graph/compile.test.js
git commit -m "FLOW-GRAPH.3 — compileGraphToSteps (graph → sequence_steps)"
```

---

## Task 4: `decompileStepsToGraph`

**Files:**
- Create: `src/lib/sequences/graph/decompile.js`
- Test: `src/lib/sequences/graph/decompile.test.js`

The inverse: ordered steps → graph. Node id = `n<step_order>`. Edges: a non-branch step at order `k` flows to the step at order `k+1` (if one exists); a `branch` flows to `config.then_step_order` (label `yes`) and `config.else_step_order` (label `no`). Channel columns → `node.config`; config jsonb → `node.config` (minus the then/else pointers, which become edges).

- [ ] **Step 1: Write the failing test**

```js
// src/lib/sequences/graph/decompile.test.js
import { describe, it, expect } from 'vitest'
import { decompileStepsToGraph } from './decompile.js'

const trigger = { type: 'booking_created', config: { event_type_id: 'e1' } }

describe('decompileStepsToGraph', () => {
  it('builds a linear graph with sequential edges', () => {
    const steps = [
      { step_order: 1, step_type: 'wait', delay_days: 0, delay_hours: 1, delay_minutes: 0 },
      { step_order: 2, step_type: 'sms', sms_body: 'hi' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.trigger).toEqual(trigger)
    expect(g.nodes.map(n => [n.id, n.type])).toEqual([['n1', 'wait'], ['n2', 'sms']])
    expect(g.edges).toEqual([
      { from: 'trigger', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ])
    expect(g.nodes[0].config).toEqual({ days: 0, hours: 1, minutes: 0 })
    expect(g.nodes[1].config).toEqual({ body: 'hi' })
  })

  it('rebuilds branch lanes from then/else pointers', () => {
    const steps = [
      { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 2, else_step_order: 3 } },
      { step_order: 2, step_type: 'email', subject: 'yes', template_id: 'x' },
      { step_order: 3, step_type: 'sms', sms_body: 'no' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toContainEqual({ from: 'trigger', to: 'n1' })
    expect(g.edges).toContainEqual({ from: 'n1', to: 'n2', label: 'yes' })
    expect(g.edges).toContainEqual({ from: 'n1', to: 'n3', label: 'no' })
    // a branch never falls through to k+1
    expect(g.edges.filter(e => e.from === 'n1' && !e.label)).toEqual([])
    // pointers are dropped from node config (they are edges now)
    expect(g.nodes[0].config).toEqual({ predicate: { type: 'has_tag', tag: 't' } })
  })

  it('emits no out-edge for the terminal step', () => {
    const steps = [{ step_order: 1, step_type: 'sms', sms_body: 'bye' }]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toEqual([{ from: 'trigger', to: 'n1' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/decompile.test.js`
Expected: FAIL — `Cannot find module './decompile.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/sequences/graph/decompile.js
//
// FLOW-GRAPH.4 — inverse of compile: existing sequence_steps → a flow
// graph for display + the one-time backfill. Pure. Node id = n<step_order>.
import { isChannelNode } from './schema.js'

function nodeConfigFromStep(step) {
  switch (step.step_type) {
    case 'email':
      return { subject: step.subject ?? null, html_content: step.html_content ?? null, template_id: step.template_id ?? null }
    case 'whatsapp':
      return {
        template_id: step.whatsapp_template_id ?? null,
        variables: step.whatsapp_variables ?? {},
        header_media_url: step.whatsapp_header_media_url ?? null,
      }
    case 'sms':
      return { body: step.sms_body ?? null }
    case 'wait':
      return { days: step.delay_days ?? 0, hours: step.delay_hours ?? 0, minutes: step.delay_minutes ?? 0 }
    case 'branch': {
      // strip the pointer keys — they become edges
      const { then_step_order, else_step_order, ...rest } = step.config || {}
      void then_step_order; void else_step_order
      return rest
    }
    default:
      return { ...(step.config || {}) }
  }
}

export function decompileStepsToGraph(steps, trigger) {
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  const idOf = (order) => `n${order}`
  const orders = new Set(sorted.map(s => s.step_order))

  const nodes = sorted.map(s => ({ id: idOf(s.step_order), type: s.step_type, config: nodeConfigFromStep(s) }))

  const edges = [{ from: 'trigger', to: idOf(sorted[0].step_order) }]
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    if (s.step_type === 'branch') {
      const c = s.config || {}
      if (c.then_step_order != null && orders.has(c.then_step_order)) {
        edges.push({ from: idOf(s.step_order), to: idOf(c.then_step_order), label: 'yes' })
      }
      if (c.else_step_order != null && orders.has(c.else_step_order)) {
        edges.push({ from: idOf(s.step_order), to: idOf(c.else_step_order), label: 'no' })
      }
    } else {
      const next = sorted[i + 1]
      if (next) edges.push({ from: idOf(s.step_order), to: idOf(next.step_order) })
    }
  }
  return { version: 1, trigger: trigger || { type: 'manual', config: {} }, nodes, edges }
}
```

Guard for the empty-sequence case: if `sorted.length === 0`, return `{ version:1, trigger, nodes:[], edges:[] }`. Add that as the first line of the function body and a test:

```js
it('handles a sequence with no steps', () => {
  expect(decompileStepsToGraph([], trigger)).toEqual({ version: 1, trigger, nodes: [], edges: [] })
})
```

Implementation guard (prepend in `decompileStepsToGraph`):

```js
if (!Array.isArray(steps) || steps.length === 0) {
  return { version: 1, trigger: trigger || { type: 'manual', config: {} }, nodes: [], edges: [] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/decompile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/graph/decompile.js src/lib/sequences/graph/decompile.test.js
git commit -m "FLOW-GRAPH.4 — decompileStepsToGraph (sequence_steps → graph)"
```

---

## Task 5: Round-trip golden test + barrel

**Files:**
- Create: `src/lib/sequences/graph/roundtrip.test.js`
- Create: `src/lib/sequences/graph/index.js`

- [ ] **Step 1: Write the round-trip test**

```js
// src/lib/sequences/graph/roundtrip.test.js
import { describe, it, expect } from 'vitest'
import { compileGraphToSteps } from './compile.js'
import { decompileStepsToGraph } from './decompile.js'
import { validateGraph } from './validate.js'

// Fixtures shaped like real prod sequence_steps.
const fixtures = {
  linear: [
    { step_order: 1, step_type: 'wait', delay_days: 0, delay_hours: 1, delay_minutes: 0 },
    { step_order: 2, step_type: 'whatsapp', whatsapp_template_id: 'wt1', whatsapp_variables: { 1: 'first_name' }, whatsapp_header_media_url: null },
    { step_order: 3, step_type: 'email', subject: 'Hi', html_content: '<p>hi</p>', template_id: null },
  ],
  branched: [
    { step_order: 1, step_type: 'wait', delay_days: 2, delay_hours: 0, delay_minutes: 0 },
    { step_order: 2, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 'attended' }, then_step_order: 3, else_step_order: 4 } },
    { step_order: 3, step_type: 'email', subject: 'How was it?', html_content: null, template_id: 't9' },
    { step_order: 4, step_type: 'sms', sms_body: 'come back this week' },
  ],
}

// Compare only the fields the runner reads (ignore defaulted nulls/empties).
function normalise(steps) {
  return steps.map(s => {
    const o = { step_order: s.step_order, step_type: s.step_type }
    for (const k of ['delay_days', 'delay_hours', 'delay_minutes', 'subject', 'html_content',
      'template_id', 'sms_body', 'whatsapp_template_id']) {
      if (s[k] != null) o[k] = s[k]
    }
    if (s.config) o.config = s.config
    return o
  })
}

describe('graph round-trip — decompile then recompile equals the input', () => {
  for (const [name, steps] of Object.entries(fixtures)) {
    it(`${name}: compile(decompile(steps)) ≈ steps`, () => {
      const graph = decompileStepsToGraph(steps, { type: 'manual', config: {} })
      expect(validateGraph(graph).ok).toBe(true)
      const recompiled = compileGraphToSteps(graph)
      expect(normalise(recompiled)).toEqual(normalise(steps))
    })
  }
})
```

- [ ] **Step 2: Run it to verify it passes** (compile + decompile already exist)

Run: `npx vitest run src/lib/sequences/graph/roundtrip.test.js`
Expected: PASS. If the branched fixture fails on `whatsapp_variables`/empty config, extend `normalise` to include the key — but do NOT change compile/decompile to make a cosmetic test pass; only include fields the runner reads.

- [ ] **Step 3: Write the barrel**

```js
// src/lib/sequences/graph/index.js
//
// FLOW-GRAPH — public surface for the node-graph foundation.
export { validateGraph } from './validate.js'
export { compileGraphToSteps } from './compile.js'
export { decompileStepsToGraph } from './decompile.js'
export {
  NODE_TYPES, TRIGGER_TYPES, CHANNEL_NODE_TYPES, CONFIG_NODE_TYPES,
  TRIGGER_SOURCE_ID, isChannelNode, parseGraphShape,
} from './schema.js'
```

- [ ] **Step 4: Run the whole graph suite**

Run: `npx vitest run src/lib/sequences/graph/`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/graph/roundtrip.test.js src/lib/sequences/graph/index.js
git commit -m "FLOW-GRAPH.5 — round-trip golden test + package barrel"
```

---

## Task 6: Migration 245 — graph columns

**Files:**
- Create: `supabase/migrations/245_sequence_graph_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 245_sequence_graph_columns.sql
-- FLOW-GRAPH.6 — add the declarative node-graph to email_sequences.
-- The graph is the source of truth for editing + agent authoring; it
-- compiles to sequence_steps (the unchanged execution artifact). Nullable,
-- no behaviour change on deploy. `draft_graph` holds an unpublished edit;
-- `graph` is the published/canonical one.
ALTER TABLE email_sequences
  ADD COLUMN IF NOT EXISTS graph        JSONB,
  ADD COLUMN IF NOT EXISTS draft_graph  JSONB,
  ADD COLUMN IF NOT EXISTS graph_version INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN email_sequences.graph IS
  'Canonical declarative flow graph {trigger,nodes[],edges[]}. Compiles to sequence_steps (FLOW-GRAPH, 2026-06).';
COMMENT ON COLUMN email_sequences.draft_graph IS
  'Unpublished draft graph; Publish promotes it to graph + recompiles steps.';
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with the `apply_migration` MCP tool (name `245_sequence_graph_columns`). Then run the security advisor (`get_advisors`, type=security) — expect no new findings (we added nullable columns to an existing RLS-protected table).

- [ ] **Step 3: Verify columns exist**

Run (MCP `execute_sql`): `select column_name from information_schema.columns where table_name='email_sequences' and column_name in ('graph','draft_graph','graph_version');`
Expected: 3 rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/245_sequence_graph_columns.sql
git commit -m "FLOW-GRAPH.6 — mig 245: graph/draft_graph/graph_version columns"
```

---

## Task 7: One-time backfill

**Files:**
- Create: `src/lib/sequences/graph/backfill.js`
- Test: `src/lib/sequences/graph/backfill.test.js`
- Create: `scripts/backfill-sequence-graphs.mjs`

- [ ] **Step 1: Write the failing test for the pure helper**

```js
// src/lib/sequences/graph/backfill.test.js
import { describe, it, expect } from 'vitest'
import { buildBackfillUpdates } from './backfill.js'

describe('buildBackfillUpdates', () => {
  it('produces one {id, graph} update per sequence, skipping those already backfilled', () => {
    const rows = [
      { id: 's1', trigger_type: 'manual', trigger_config: {}, graph: null,
        steps: [{ step_order: 1, step_type: 'sms', sms_body: 'hi' }] },
      { id: 's2', trigger_type: 'booking_created', trigger_config: { event_type_id: 'e' }, graph: { version: 1 },
        steps: [{ step_order: 1, step_type: 'wait', delay_days: 1 }] },
    ]
    const out = buildBackfillUpdates(rows)
    expect(out.map(u => u.id)).toEqual(['s1']) // s2 already has a graph → skipped
    expect(out[0].graph.trigger).toEqual({ type: 'manual', config: {} })
    expect(out[0].graph.nodes[0].type).toBe('sms')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/sequences/graph/backfill.test.js`
Expected: FAIL — `Cannot find module './backfill.js'`.

- [ ] **Step 3: Write the helper**

```js
// src/lib/sequences/graph/backfill.js
// FLOW-GRAPH.7 — pure helper: turn sequence rows (with steps) into
// {id, graph} updates, skipping any sequence that already has a graph.
import { decompileStepsToGraph } from './decompile.js'

export function buildBackfillUpdates(rows) {
  const out = []
  for (const r of rows || []) {
    if (r.graph) continue
    const trigger = { type: r.trigger_type || 'manual', config: r.trigger_config || {} }
    out.push({ id: r.id, graph: decompileStepsToGraph(r.steps || [], trigger) })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/sequences/graph/backfill.test.js`
Expected: PASS.

- [ ] **Step 5: Write the one-off script**

```js
// scripts/backfill-sequence-graphs.mjs
// One-time: populate email_sequences.graph from existing sequence_steps.
// Idempotent (skips sequences that already have a graph). Run with:
//   node scripts/backfill-sequence-graphs.mjs
import { createClient } from '@supabase/supabase-js'
import { buildBackfillUpdates } from '../src/lib/sequences/graph/backfill.js'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data: seqs, error } = await db
  .from('email_sequences')
  .select('id, trigger_type, trigger_config, graph, sequence_steps(*)')
if (error) { console.error(error); process.exit(1) }

const rows = (seqs || []).map(s => ({ ...s, steps: s.sequence_steps }))
const updates = buildBackfillUpdates(rows)
console.log(`Backfilling ${updates.length} of ${rows.length} sequences…`)
for (const u of updates) {
  const { error: e } = await db.from('email_sequences').update({ graph: u.graph }).eq('id', u.id)
  if (e) console.error(`  ${u.id}: ${e.message}`)
}
console.log('Done.')
```

- [ ] **Step 6: Run the backfill once (after mig 245 is applied)**

Run: `node scripts/backfill-sequence-graphs.mjs` with the prod env vars loaded.
Expected: `Backfilling N of N sequences… Done.` Spot-check one row's `graph` in the DB.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sequences/graph/backfill.js src/lib/sequences/graph/backfill.test.js scripts/backfill-sequence-graphs.mjs
git commit -m "FLOW-GRAPH.7 — one-time graph backfill (buildBackfillUpdates + script)"
```

---

## Task 8: Full CI mirror + PR

- [ ] **Step 1: Run the full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run build
```
Expected: all green. (No new imports into routes/pages in this phase, but `npm run build` confirms the new lib files resolve.)

- [ ] **Step 2: Push the branch + open the PR**

```bash
git push -u origin flow-graph-phase1
gh pr create --base main --head flow-graph-phase1 \
  --title "FLOW-GRAPH Phase 1 — node-graph foundation (validate/compile/decompile + mig 245)" \
  --body "Phase 1 of the sequencing redesign (docs/SEQUENCING_REDESIGN_2026-06.md). Pure, fully-tested graph foundation. Runner UNCHANGED. Adds graph columns + one-time backfill. No UI yet. Verified: tests/lint/build/parity green."
```

- [ ] **Step 3: Merge once CI is green** (squash, delete branch). Phase 2 (the guided-rail builder) builds on this.

---

## Self-review notes (done)

- **Spec coverage:** schema + `validateGraph` + `compileGraphToSteps` + `decompileStepsToGraph` + `graph` column + backfill — all present (Tasks 1–7). Runner untouched (no task modifies `scheduler.js`/`steps.js`). ✓
- **Type consistency:** `validateGraph → {ok,errors}`, `compileGraphToSteps → row[]`, `decompileStepsToGraph(steps,trigger) → graph`, `TRIGGER_SOURCE_ID='trigger'`, node `{id,type,config}`, edge `{from,to,label?}` — used identically across compile/decompile/validate/tests. ✓
- **No placeholders:** every code + test block is complete. The one discovery dependency (per-type `config` contract) is captured in the Background table from `steps.js`. ✓
- **Open risk:** the exact `whatsapp`/`webhook`/`internal_task` config sub-keys beyond the required one are pass-through (`...node.config`), so compile/decompile preserve them without enumerating — the round-trip test (Task 5) is the safety net. If a real prod sequence round-trips lossily, add its shape to the `fixtures` in `roundtrip.test.js` and fix the mapping, not the test.
