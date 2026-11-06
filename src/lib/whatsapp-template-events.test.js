// src/lib/whatsapp-template-events.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { templateColumnUpdate, templateNotification, templateEventRow, applyTemplateEvent } from './whatsapp-template-events.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sequences/template-wait', () => ({ onTemplateApproved: vi.fn(async () => ({ woken: 0, resumed: 0, leftPaused: 0 })) }))
const { onTemplateApproved } = await import('@/lib/sequences/template-wait')

const status = (event, reason) => ({ field: 'message_template_status_update', value: { event, reason, message_template_id: 1, message_template_name: 'welcome_offer', message_template_language: 'en' } })
const quality = (next, prev) => ({ field: 'message_template_quality_update', value: { new_quality_score: next, previous_quality_score: prev, message_template_id: 1, message_template_name: 'welcome_offer' } })
const category = (next, prev) => ({ field: 'template_category_update', value: { new_category: next, previous_category: prev, message_template_id: 1, message_template_name: 'welcome_offer' } })

describe('templateColumnUpdate', () => {
  it('maps status event → status + rejection_reason (NONE → null)', () => {
    expect(templateColumnUpdate('message_template_status_update', status('REJECTED', 'INVALID_FORMAT').value)).toEqual({ status: 'REJECTED', rejection_reason: 'INVALID_FORMAT' })
    expect(templateColumnUpdate('message_template_status_update', status('APPROVED', 'NONE').value)).toEqual({ status: 'APPROVED', rejection_reason: null })
  })
  it('maps quality → quality_rating', () => {
    expect(templateColumnUpdate('message_template_quality_update', quality('RED', 'YELLOW').value)).toEqual({ quality_rating: 'RED' })
  })
  it('maps category → category', () => {
    expect(templateColumnUpdate('template_category_update', category('UTILITY', 'MARKETING').value)).toEqual({ category: 'UTILITY' })
  })
  it('returns null for an unknown field', () => {
    expect(templateColumnUpdate('messages', {})).toBeNull()
  })
})

describe('templateNotification', () => {
  it('notifies on APPROVED', () => {
    const n = templateNotification('message_template_status_update', status('APPROVED').value, 'welcome_offer')
    expect(n).toMatchObject({ title: 'Template approved' })
    expect(n.body).toContain('approved')
  })
  it('notifies on REJECTED with the reason', () => {
    const n = templateNotification('message_template_status_update', status('REJECTED', 'INVALID_FORMAT').value, 'welcome_offer')
    expect(n.body).toContain('INVALID_FORMAT')
  })
  it('notifies on PAUSED/DISABLED/LIMIT_EXCEEDED', () => {
    expect(templateNotification('message_template_status_update', status('PAUSED').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_status_update', status('DISABLED').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_status_update', status('LIMIT_EXCEEDED').value, 'x')).not.toBeNull()
  })
  it('is silent on PENDING / IN_APPEAL / DELETED', () => {
    expect(templateNotification('message_template_status_update', status('PENDING').value, 'x')).toBeNull()
    expect(templateNotification('message_template_status_update', status('IN_APPEAL').value, 'x')).toBeNull()
    expect(templateNotification('message_template_status_update', status('DELETED').value, 'x')).toBeNull()
  })
  it('notifies on quality YELLOW or RED, silent on GREEN/UNKNOWN', () => {
    expect(templateNotification('message_template_quality_update', quality('RED').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_quality_update', quality('YELLOW').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_quality_update', quality('GREEN').value, 'x')).toBeNull()
    expect(templateNotification('message_template_quality_update', quality('UNKNOWN').value, 'x')).toBeNull()
  })
  it('notifies on a real category change, silent on no-op', () => {
    expect(templateNotification('template_category_update', category('UTILITY', 'MARKETING').value, 'x').body).toContain('MARKETING → UTILITY')
    expect(templateNotification('template_category_update', category('MARKETING', 'MARKETING').value, 'x')).toBeNull()
  })
})

describe('templateEventRow', () => {
  it('status → kind status, from null, to event, reason (NONE→null)', () => {
    expect(templateEventRow('message_template_status_update', status('REJECTED', 'SCAM').value)).toEqual({ kind: 'status', from_value: null, to_value: 'REJECTED', reason: 'SCAM' })
    expect(templateEventRow('message_template_status_update', status('APPROVED', 'NONE').value)).toEqual({ kind: 'status', from_value: null, to_value: 'APPROVED', reason: null })
  })
  it('quality → from prev, to new', () => {
    expect(templateEventRow('message_template_quality_update', quality('RED', 'YELLOW').value)).toEqual({ kind: 'quality', from_value: 'YELLOW', to_value: 'RED', reason: null })
  })
  it('category → from prev, to new', () => {
    expect(templateEventRow('template_category_update', category('UTILITY', 'MARKETING').value)).toEqual({ kind: 'category', from_value: 'MARKETING', to_value: 'UTILITY', reason: null })
  })
})

describe('applyTemplateEvent approval hook', () => {
  const row = { id: 'r1', location_id: 'loc1', name: 'n', status: 'PENDING', quality_rating: null, category: 'MARKETING', rejection_reason: null }
  function db({ updateError = null } = {}) {
    const inserts = []
    return {
      inserts,
      from(table) {
        if (table === 'whatsapp_template_events') return { insert: async (r) => { inserts.push(r); return { error: null } } }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          update: () => ({ eq: async () => ({ error: updateError }) }),
        }
      },
    }
  }
  beforeEach(() => vi.mocked(onTemplateApproved).mockClear())
  it('approvedTransitionCallsHook', async () => {
    const d = db()
    await applyTemplateEvent(d, 'message_template_status_update', status('APPROVED').value)
    expect(onTemplateApproved).toHaveBeenCalledTimes(1)
    expect(onTemplateApproved).toHaveBeenCalledWith(d, row)
  })
  it('nonApprovedTransitionSkipsHook', async () => {
    await applyTemplateEvent(db(), 'message_template_status_update', status('REJECTED', 'X').value)
    expect(onTemplateApproved).not.toHaveBeenCalled()
  })
  it('updateErrorSkipsHookAndAudit', async () => {
    const d = db({ updateError: { message: 'nope' } })
    const r = await applyTemplateEvent(d, 'message_template_status_update', status('APPROVED').value)
    expect(r).toEqual({ skipped: 'update_failed' })
    expect(d.inserts).toHaveLength(0)
    expect(onTemplateApproved).not.toHaveBeenCalled()
  })
})
