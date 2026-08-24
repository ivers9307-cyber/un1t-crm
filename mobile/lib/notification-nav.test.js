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
    // EMAIL-INBOUND-PUSH.1 — inbound ticket mail opens the ticket thread.
    expect(routeForNotification({ type: 'email_inbound', ticket_id: 'e1' })).toBe('/email/e1')
    // AGENT-ACTIVITY.1 — "X is chatting with Mia" opens the right channel thread.
    expect(routeForNotification({ type: 'agent_activity', conversation_id: 'w3', channel: 'whatsapp' })).toBe('/whatsapp/w3')
    expect(routeForNotification({ type: 'agent_activity', conversation_id: 'i3', channel: 'instagram' })).toBe('/instagram/i3')
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
    expect(routeForNotification({ type: 'email_inbound' })).toBe('/(tabs)/email')
    expect(routeForNotification({ type: 'invoice_approved' })).toBe('/(tabs)/invoices')
    expect(routeForNotification({ type: 'expense_declined' })).toBe('/(tabs)/expenses')
    expect(routeForNotification({ type: 'contract_issued' })).toBe('/contracts')
    expect(routeForNotification({ type: 'issue_submitted' })).toBe('/issues/inbox')
    expect(routeForNotification({ type: 'issue_resolved' })).toBe('/issues')
  })

  // APPROVALS-STUDIO.1 — team decision types land on the Everything-else tab;
  // customer approvals (agent_request) land on the Customers tab.
  it('routes manager decision-queue types to the approvals inbox team tab', () => {
    for (const type of ['swap_open', 'swap_awaiting', 'time_off_inbound', 'expense_submitted']) {
      expect(routeForNotification({ type })).toBe('/approvals?tab=team')
    }
  })

  it('routes customer approval pushes to the Customers tab', () => {
    expect(routeForNotification({ type: 'agent_request', request_id: 'r9' })).toBe('/approvals?tab=customers&focus=r9')
    expect(routeForNotification({ type: 'agent_request' })).toBe('/approvals')
  })

  it('appends ?focus= for decision-queue types when the payload carries the entity id', () => {
    expect(routeForNotification({ type: 'swap_open', swap_id: 's1' })).toBe('/approvals?tab=team&focus=s1')
    expect(routeForNotification({ type: 'swap_awaiting', swap_id: 's2' })).toBe('/approvals?tab=team&focus=s2')
    expect(routeForNotification({ type: 'time_off_inbound', request_id: 'r1' })).toBe('/approvals?tab=team&focus=r1')
    expect(routeForNotification({ type: 'expense_submitted', claim_id: 'c1' })).toBe('/approvals?tab=team&focus=c1')
    // Unsafe id shapes are dropped rather than built into the URL.
    expect(routeForNotification({ type: 'swap_open', swap_id: 'a?b=c' })).toBe('/approvals?tab=team')
    expect(routeForNotification({ type: 'time_off_inbound', request_id: 42 })).toBe('/approvals?tab=team')
  })

  it('routes staff swap-response types to the Dashboard tab (swap cards live there)', () => {
    for (const type of ['swap_inbound', 'swap_claimed', 'swap_accepted', 'swap_withdrawn', 'swap_declined']) {
      expect(routeForNotification({ type, swap_id: 's1' })).toBe('/(tabs)/dashboard')
    }
  })

  it('routes schedule-affecting types to the schedule tab', () => {
    for (const type of ['swap_decision', 'time_off_decision', 'schedule_published', 'schedule_updated', 'shift_adjusted']) {
      expect(routeForNotification({ type })).toBe('/(tabs)/schedule')
    }
  })

  it('appends ?date= for roster types when the payload carries the affected date', () => {
    expect(routeForNotification({ type: 'schedule_published', start_date: '2026-07-06', end_date: '2026-07-12' }))
      .toBe('/(tabs)/schedule?date=2026-07-06')
    expect(routeForNotification({ type: 'schedule_updated', start_date: '2026-07-13', end_date: '2026-07-19' }))
      .toBe('/(tabs)/schedule?date=2026-07-13')
    expect(routeForNotification({ type: 'shift_adjusted', assignment_id: 'a1', block_date: '2026-07-10' }))
      .toBe('/(tabs)/schedule?date=2026-07-10')
    expect(routeForNotification({ type: 'swap_decision', swap_id: 's1', status: 'approved', block_date: '2026-07-08' }))
      .toBe('/(tabs)/schedule?date=2026-07-08')
    expect(routeForNotification({ type: 'time_off_decision', request_id: 'r1', status: 'approved', start_date: '2026-07-20' }))
      .toBe('/(tabs)/schedule?date=2026-07-20')
    // Malformed dates fall back to the bare tab rather than a junk URL.
    expect(routeForNotification({ type: 'schedule_published', start_date: 'next week' })).toBe('/(tabs)/schedule')
    expect(routeForNotification({ type: 'shift_adjusted', block_date: '2026-7-1' })).toBe('/(tabs)/schedule')
    expect(routeForNotification({ type: 'swap_decision', swap_id: 's1', block_date: null })).toBe('/(tabs)/schedule')
    // Older payloads without the date still land on the schedule tab.
    expect(routeForNotification({ type: 'time_off_decision', request_id: 'r1' })).toBe('/(tabs)/schedule')
    expect(routeForNotification({ type: 'swap_decision', swap_id: 's1' })).toBe('/(tabs)/schedule')
  })

  it('routes WhatsApp health/template alerts to the WhatsApp tab', () => {
    for (const type of ['wa_quality', 'number_health', 'flow_health', 'template_status']) {
      expect(routeForNotification({ type })).toBe('/(tabs)/whatsapp')
    }
  })

  it('routes checklist types', () => {
    expect(routeForNotification({ type: 'checklist_overdue', instance_id: 'x' })).toBe('/checklists/today')
    // No manager checklist surface on mobile — the Dashboard tab shows the
    // studio dashboard (HOME-LOC.7 moved it off Home).
    expect(routeForNotification({ type: 'checklist_compliance', instance_id: 'x' })).toBe('/(tabs)/dashboard')
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
