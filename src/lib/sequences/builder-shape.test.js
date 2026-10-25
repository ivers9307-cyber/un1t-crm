// SEQPAGEGATE.1 — what the sequence builder (client components) may know
// about a sequence. The page used to pass the whole email_sequences row,
// webhook_secret included, into the RSC payload. Fictional values only.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from '../../../tests/helpers/js-code.js'
import {
  SEQUENCE_BUILDER_ROW_SELECT, SEQUENCE_BUILDER_PAGE_SELECT, toBuilderSequence, toPerformanceSteps,
} from './builder-shape.js'
import { collectSchema, parseSelect } from '../../../scripts/check-select-columns.mjs'

const ROW = {
  id: 's1', location_id: 'loc1', name: 'Welcome flow', description: 'memo', status: 'active',
  trigger_type: 'webhook', trigger_config: { a: 1 }, audience_filter: null, goal_config: null,
  send_window: null, re_enrolment_cooldown_days: 0,
  webhook_token: 'a'.repeat(32), webhook_secret: 'SYNTH-SECRET',
  graph: { nodes: [] }, draft_graph: null, graph_version: 3, active: true,
  total_enrolled: 9, from_email: 'from@example.test', created_by: 'u1',
  sequence_steps: [{ id: 'st1', step_type: 'email', config: { next_step_order: 'end' }, html_content: '<p>SYNTH-HTML</p>', design_json: { x: 1 }, subject: 'Hi' }],
}

describe('toBuilderSequence (SEQPAGEGATE.1)', () => {
  it('is an allow-list: the builder fields + has_webhook_secret, nothing else', () => {
    expect(Object.keys(toBuilderSequence(ROW)).sort()).toEqual([
      'audience_filter', 'description', 'goal_config', 'has_webhook_secret', 'id', 'location_id', 'name',
      're_enrolment_cooldown_days', 'send_window', 'status', 'trigger_config', 'trigger_type', 'webhook_token',
    ])
  })

  it('never carries the secret, only whether one is set', () => {
    const out = toBuilderSequence(ROW)
    expect(out).not.toHaveProperty('webhook_secret')
    expect(out.has_webhook_secret).toBe(true)
    expect(JSON.stringify(out)).not.toContain('SYNTH-')
    expect(toBuilderSequence({ ...ROW, webhook_secret: null }).has_webhook_secret).toBe(false)
    // '' is "no secret" to the inbound route (`if (seq.webhook_secret)`), so here too.
    expect(toBuilderSequence({ ...ROW, webhook_secret: '' }).has_webhook_secret).toBe(false)
  })

  it('carries the webhook token only while the trigger is a webhook', () => {
    expect(toBuilderSequence(ROW).webhook_token).toBe('a'.repeat(32))
    expect(toBuilderSequence({ ...ROW, trigger_type: 'manual' }).webhook_token).toBeNull()
  })

  it('null in, null out', () => {
    expect(toBuilderSequence(null)).toBeNull()
  })
})

describe('toPerformanceSteps (SEQPAGEGATE.1)', () => {
  it('passes id, step_type and config only (no email bodies)', () => {
    expect(toPerformanceSteps(ROW.sequence_steps)).toEqual([{ id: 'st1', step_type: 'email', config: { next_step_order: 'end' } }])
    expect(toPerformanceSteps(undefined)).toEqual([])
  })
})

describe('the selects name real columns and no *', () => {
  it('row select: no *, and the secret is read (server-side) only to compute the boolean', () => {
    expect(SEQUENCE_BUILDER_ROW_SELECT).not.toContain('*')
    expect(SEQUENCE_BUILDER_ROW_SELECT).toContain('webhook_secret')
  })

  it('page select = row select + graph, draft_graph, sequence_steps(*) (server-only, for resolveSequenceGraph)', () => {
    expect(SEQUENCE_BUILDER_PAGE_SELECT).toBe(`${SEQUENCE_BUILDER_ROW_SELECT}, graph, draft_graph, sequence_steps(*)`)
  })

  // check:select-columns cannot see a select passed through a constant, so
  // resolve it against the same migration replay (the C59 pattern).
  // parseSelect drops a `*` ref, so the steps embed cannot fail the filter.
  it('every column exists on email_sequences (migration replay)', () => {
    const { schema } = collectSchema('supabase/migrations')
    const refs = parseSelect(SEQUENCE_BUILDER_PAGE_SELECT, 'email_sequences', schema)
    expect(refs.filter((r) => !schema.get(r.table)?.has(r.column))).toEqual([])
    for (const column of ['webhook_secret', 'draft_graph', 're_enrolment_cooldown_days']) {
      expect(refs).toContainEqual({ table: 'email_sequences', column })
    }
  })
})

describe('no client component reads the stored secret off the sequence', () => {
  // Comments blanked by the TypeScript parser's ranges, never a regex (GUARDSTRIP.1).
  const read = (rel) => stripComments(readFileSync(path.resolve(import.meta.dirname, '../../components/sequences', rel), 'utf8'))

  it.each(['SequenceSettings.jsx', 'SequenceFlowBuilder.jsx'])('%s', (file) => {
    const code = read(file)
    expect(code).not.toMatch(/sequence\??\.webhook_secret/)
    expect(code).toMatch(/has_webhook_secret/)
  })
})
