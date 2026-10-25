// mobile/lib/widget-push-reload.test.js
// WIDGET.1 Task 13 — pure decision: does this push type change one of the
// What Needs Me widget's three counts (approvals / mail / inbox)? See the
// header comment in widget-push-reload.js for the full type-by-type
// rationale, cross-checked against the actual sendPush() call sites.

import { describe, it, expect } from 'vitest'
import { shouldReloadWidgetsForPush } from './widget-push-reload'

describe('shouldReloadWidgetsForPush', () => {
  it.each([
    // approvals
    'swap_open',
    'swap_awaiting',
    'time_off_inbound',
    'agent_request',
    'host_event_review',
    'expense_submitted',
    'issue_submitted',
    // mail
    'email_inbound',
    // inbox
    'whatsapp_inbound',
    'instagram_inbound',
    'whatsapp_agent_handoff',
    'instagram_agent_handoff',
  ])('reloads on %s — it can move a home-queue count', (type) => {
    expect(shouldReloadWidgetsForPush({ type })).toBe(true)
  })

  it.each([
    // personal swap notices — not the manager's approvals queue
    'swap_inbound',
    'swap_claimed',
    'swap_accepted',
    'swap_withdrawn',
    'swap_declined',
    'swap_decision',
    'swap_open_pool',
    'time_off_decision',
    // decision notices to the submitter — leaving the queue on an action
    // the approver's own client already knows about
    'invoice_approved',
    'invoice_declined',
    'expense_approved',
    'expense_declined',
    'issue_resolved',
    // about an already-counted item — count doesn't change
    'agent_request_expired',
    'agent_request_stale',
    // agent still handling it — needsAction hasn't flipped
    'agent_activity',
    // no home-queue bucket at all
    'contract_issued',
    'checklist_overdue',
    'checklist_compliance',
    'lead_new',
    'task_reminder',
    'booking_reminder',
    'schedule_published',
    'schedule_updated',
    'shift_adjusted',
    'wa_quality',
    'number_health',
    'flow_health',
    'template_status',
    'admin_test_push',
  ])('does not reload on %s', (type) => {
    expect(shouldReloadWidgetsForPush({ type })).toBe(false)
  })

  it('does not reload when there is no data payload', () => {
    expect(shouldReloadWidgetsForPush(null)).toBe(false)
    expect(shouldReloadWidgetsForPush(undefined)).toBe(false)
  })

  it('does not reload when data carries no type', () => {
    expect(shouldReloadWidgetsForPush({})).toBe(false)
    expect(shouldReloadWidgetsForPush({ ticket_id: 'abc' })).toBe(false)
  })

  it('does not reload on a non-string type', () => {
    expect(shouldReloadWidgetsForPush({ type: 123 })).toBe(false)
  })

  it('does not reload on an unrecognised type', () => {
    expect(shouldReloadWidgetsForPush({ type: 'some_future_push_type' })).toBe(false)
  })
})
