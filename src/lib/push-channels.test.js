import { describe, it, expect } from 'vitest'
import { ANDROID_CHANNELS, androidChannelId } from '@shared/push-channels'
import {
  CUSTOMER_ANDROID_CHANNELS,
  customerAndroidChannelId,
} from '@shared/customer-push-channels'
import { NOTIFICATION_CATEGORIES } from './notifications-registry'

// The data.type values the mobile router knows (mobile/lib/notification-nav.js
// is the payload owner's canonical list) — every one must resolve to a channel
// that the registrar actually creates, or Android auto-creates a system
// "Miscellaneous" channel for the unknown id.
const STAFF_TYPES = [
  'task_reminder', 'booking_reminder',
  'swap_inbound', 'swap_claimed', 'swap_accepted', 'swap_withdrawn',
  'swap_declined', 'swap_open', 'swap_awaiting', 'swap_decision',
  'time_off_inbound', 'time_off_decision',
  'schedule_published', 'schedule_updated', 'shift_adjusted',
  'lead_new', 'whatsapp_inbound', 'whatsapp_agent_handoff',
  'instagram_inbound', 'instagram_agent_handoff',
  'invoice_approved', 'invoice_declined',
  'expense_submitted', 'expense_approved', 'expense_declined',
  'contract_issued', 'checklist_overdue', 'checklist_compliance',
  'issue_submitted', 'issue_resolved',
  'wa_quality', 'number_health', 'flow_health', 'template_status',
]

const CUSTOMER_TYPES = [
  'class_reminder', 'friend_request', 'feed',
  'session_report', 'achievement', 'goal', 'tier_up',
  'monthly_target_hit', 'streak_at_risk', 'winback', 'challenge',
  'onboarding_pace',
]

describe('staff push channels (shared/push-channels)', () => {
  it('every resolved channel id is a channel the registrar creates', () => {
    const known = Object.keys(ANDROID_CHANNELS)
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(known).toContain(androidChannelId({ category }))
    }
    for (const type of STAFF_TYPES) {
      expect(known).toContain(androidChannelId({ type }))
    }
  })

  it('keeps the legacy default channel for unknown payloads', () => {
    expect(ANDROID_CHANNELS.default).toBeDefined()
    expect(androidChannelId({})).toBe('default')
    expect(androidChannelId()).toBe('default')
    expect(androidChannelId({ category: 'nope', type: 'nope' })).toBe('default')
  })

  it('routes chat to messages and decision queues to approvals', () => {
    expect(androidChannelId({ category: 'whatsapp' })).toBe('messages')
    expect(androidChannelId({ category: 'instagram' })).toBe('messages')
    expect(androidChannelId({ category: 'swap' })).toBe('approvals')
    expect(androidChannelId({ category: 'time_off' })).toBe('approvals')
    expect(androidChannelId({ category: 'expense_submitted' })).toBe('approvals')
  })

  it('type overrides demote FYI outcomes and WA health alerts', () => {
    // swap outcomes are FYIs even though category swap = approvals
    expect(androidChannelId({ category: 'swap', type: 'swap_decision' })).toBe('updates')
    expect(androidChannelId({ category: 'swap', type: 'swap_claimed' })).toBe('updates')
    // but the inbound/awaiting decision types stay on approvals
    expect(androidChannelId({ category: 'swap', type: 'swap_awaiting' })).toBe('approvals')
    // WA health rides category whatsapp but is an ops alert, not chat
    expect(androidChannelId({ category: 'whatsapp', type: 'number_health' })).toBe('alerts')
    expect(androidChannelId({ category: 'whatsapp', type: 'whatsapp_inbound' })).toBe('messages')
  })

  it('channel specs use only importance keys the registrar can map', () => {
    for (const spec of Object.values(ANDROID_CHANNELS)) {
      expect(['max', 'high', 'default']).toContain(spec.importance)
      expect(spec.name).toBeTruthy()
    }
  })
})

describe('customer push channels (shared/customer-push-channels)', () => {
  it('every known data.type resolves to a created channel', () => {
    const known = Object.keys(CUSTOMER_ANDROID_CHANNELS)
    for (const type of CUSTOMER_TYPES) {
      expect(known).toContain(customerAndroidChannelId(type))
    }
  })

  it('class reminders are the only high-importance customer channel', () => {
    expect(customerAndroidChannelId('class_reminder')).toBe('reminders')
    expect(CUSTOMER_ANDROID_CHANNELS.reminders.importance).toBe('high')
    const others = Object.entries(CUSTOMER_ANDROID_CHANNELS)
      .filter(([id]) => id !== 'reminders')
    for (const [, spec] of others) {
      expect(spec.importance).toBe('default')
    }
  })

  it('unknown/missing types fall back to the legacy default channel', () => {
    expect(CUSTOMER_ANDROID_CHANNELS.default).toBeDefined()
    expect(customerAndroidChannelId('nope')).toBe('default')
    expect(customerAndroidChannelId()).toBe('default')
  })
})
