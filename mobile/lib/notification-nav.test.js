// NOTIF.3 — tests for the push data.type → mobile-route mapping.
// Pure (runs under vitest's node env like the other mobile/lib tests).
// Routes must point at screens that actually exist under mobile/app/;
// deep links only fire when the payload carries the entity id — a
// missing id falls back to the relevant inbox/list.

import { describe, it, expect } from 'vitest'
import { routeForNotification } from './notification-nav'

describe('routeForNotification', () => {
  it('deep-links when the payload carries the entity id', () => {
    expect(routeForNotification({ type: 'task_reminder', task_id: 't1' })).toBe('/tasks/t1')
    expect(routeForNotification({ type: 'booking_reminder', booking_id: 'b1' })).toBe('/bookings/b1')
    expect(routeForNotification({ type: 'lead_new', contact_id: 'c1' })).toBe('/contacts/c1')
    expect(routeForNotification({ type: 'whatsapp_inbound', conversation_id: 'w1' })).toBe('/whatsapp/w1')
    expect(routeForNotification({ type: 'whatsapp_agent_handoff', conversation_id: 'w2' })).toBe('/whatsapp/w2')
    expect(routeForNotification({ type: 'instagram_inbound', conversation_id: 'i1' })).toBe('/instagram/i1')
    expect(routeForNotification({ type: 'instagram_agent_handoff', conversation_id: 'i2' })).toBe('/instagram/i2')
    expect(routeForNotification({ type: 'invoice_approved', invoice_id: 'inv1' })).toBe('/invoices/inv1')
    expect(routeForNotification({ type: 'invoice_declined', invoice_id: 'inv2' })).toBe('/invoices/inv2')
    expect(routeForNotification({ type: 'expense_approved', claim_id: 'e1' })).toBe('/expenses/e1')
    expect(routeForNotification({ type: 'expense_declined', claim_id: 'e2' })).toBe('/expenses/e2')
    expect(routeForNotification({ type: 'contract_issued', contract_id: 'k1' })).toBe('/contracts/k1')
    expect(routeForNotification({ type: 'issue_submitted', issue_id: 'is1' })).toBe('/issues/inbox/is1')
    expect(routeForNotification({ type: 'issue_resolved', issue_id: 'is2' })).toBe('/issues/is2')
  })

  it('falls back to the relevant list when the id is missing', () => {
    expect(routeForNotification({ type: 'task_reminder' })).toBe('/tasks')
    expect(routeForNotification({ type: 'booking_reminder' })).toBe('/(tabs)/bookings')
    expect(routeForNotification({ type: 'lead_new' })).toBe('/contacts')
    expect(routeForNotification({ type: 'whatsapp_inbound' })).toBe('/(tabs)/whatsapp')
    expect(routeForNotification({ type: 'instagram_inbound' })).toBe('/(tabs)/whatsapp')
    expect(routeForNotification({ type: 'invoice_approved' })).toBe('/(tabs)/invoices')
    expect(routeForNotification({ type: 'expense_declined' })).toBe('/(tabs)/expenses')
    expect(routeForNotification({ type: 'contract_issued' })).toBe('/contracts')
    expect(routeForNotification({ type: 'issue_submitted' })).toBe('/issues/inbox')
    expect(routeForNotification({ type: 'issue_resolved' })).toBe('/issues')
  })

  it('routes manager decision-queue types to the approvals inbox', () => {
    for (const type of ['swap_open', 'swap_awaiting', 'time_off_inbound', 'expense_submitted']) {
      expect(routeForNotification({ type })).toBe('/approvals')
    }
  })

  it('routes staff swap-response types to the dashboard (swap cards live there)', () => {
    for (const type of ['swap_inbound', 'swap_claimed', 'swap_accepted', 'swap_withdrawn', 'swap_declined']) {
      expect(routeForNotification({ type, swap_id: 's1' })).toBe('/(tabs)')
    }
  })

  it('routes schedule-affecting types to the schedule tab', () => {
    for (const type of ['swap_decision', 'time_off_decision', 'schedule_published', 'schedule_updated', 'shift_adjusted']) {
      expect(routeForNotification({ type })).toBe('/(tabs)/schedule')
    }
  })

  it('routes WhatsApp health/template alerts to the WhatsApp tab', () => {
    for (const type of ['wa_quality', 'number_health', 'flow_health', 'template_status']) {
      expect(routeForNotification({ type })).toBe('/(tabs)/whatsapp')
    }
  })

  it('routes checklist types', () => {
    expect(routeForNotification({ type: 'checklist_overdue', instance_id: 'x' })).toBe('/checklists/today')
    // No manager checklist surface on mobile — home shows the studio dashboard.
    expect(routeForNotification({ type: 'checklist_compliance', instance_id: 'x' })).toBe('/(tabs)')
  })

  it('deliberately does not navigate for the admin delivery test', () => {
    expect(routeForNotification({ type: 'admin_test_push' })).toBe(null)
  })

  it('marks unknown types as undefined so the caller can log them', () => {
    expect(routeForNotification({ type: 'some_future_type' })).toBe(undefined)
  })

  it('returns null for missing/blank payloads', () => {
    expect(routeForNotification(null)).toBe(null)
    expect(routeForNotification({})).toBe(null)
  })
})
