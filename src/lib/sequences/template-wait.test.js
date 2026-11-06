import { describe, it, expect } from 'vitest'
import {
  templateWaitDecision, withoutTemplateWait, templateStamp,
  TEMPLATE_WAIT_RETRY_MS, TEMPLATE_WAIT_MAX_MS,
} from './template-wait.js'

const now = new Date('2026-11-06T12:00:00.000Z')

describe('templateWaitDecision', () => {
  it('startsWaitOnFirstDeferral', () => {
    const d = templateWaitDecision({ metadata: null, stepOrder: 2, templateId: 't1', now })
    expect(d.action).toBe('defer')
    expect(d.nextAt).toBe(new Date(now.getTime() + TEMPLATE_WAIT_RETRY_MS).toISOString())
    expect(d.metadata.template_wait).toEqual({ template_id: 't1', step_order: 2, since: now.toISOString() })
  })
  it('keepsSinceOnLaterDeferral', () => {
    const since = new Date(now.getTime() - 5 * 3_600_000).toISOString()
    const d = templateWaitDecision({
      metadata: { template_wait: { template_id: 't1', step_order: 2, since } }, stepOrder: 2, templateId: 't1', now,
    })
    expect(d.action).toBe('defer')
    expect(d.metadata.template_wait.since).toBe(since)
  })
  it('exitsAt48Hours', () => {
    const since = new Date(now.getTime() - TEMPLATE_WAIT_MAX_MS).toISOString()
    const d = templateWaitDecision({
      metadata: { template_wait: { template_id: 't1', step_order: 2, since } }, stepOrder: 2, templateId: 't1', now,
    })
    expect(d).toEqual({ action: 'exit' })
  })
  it('waitRecordResetsWhenTemplateChanges', () => {
    const since = new Date(now.getTime() - 60 * 3_600_000).toISOString()
    const d = templateWaitDecision({
      metadata: { template_wait: { template_id: 'A', step_order: 2, since } }, stepOrder: 2, templateId: 'B', now,
    })
    expect(d.action).toBe('defer')
    expect(d.metadata.template_wait).toEqual({ template_id: 'B', step_order: 2, since: now.toISOString() })
  })
  it('preservesOtherMetadataKeys', () => {
    const d = templateWaitDecision({ metadata: { test: true }, stepOrder: 1, templateId: 't1', now })
    expect(d.metadata.test).toBe(true)
  })
})

describe('helpers', () => {
  it('stampFormat', () => {
    expect(templateStamp('abc')).toBe('[wa_tpl:abc] ')
  })
  it('withoutTemplateWait strips the record, or returns null when nothing changes', () => {
    expect(withoutTemplateWait({ test: true, template_wait: { a: 1 } })).toEqual({ test: true })
    expect(withoutTemplateWait({ test: true })).toBeNull()
    expect(withoutTemplateWait(null)).toBeNull()
  })
})
