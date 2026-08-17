import { describe, it, expect } from 'vitest'
import {
  CUSTOMER_ANDROID_CHANNELS,
  customerAndroidChannelId,
  LEGACY_CHANNEL_ALIASES,
} from './customer-push-channels'

// Every data.type the mobile NotificationRouter knows (mobile/app/_layout.jsx)
// must resolve to a channel the registrar creates, or Android auto-creates a
// system "Miscellaneous" channel for the unknown id.
const KNOWN_TYPES = [
  'class_reminder', 'friend_request', 'feed',
  'session_report', 'achievement', 'goal', 'tier_up',
  'monthly_target_hit', 'streak_at_risk', 'winback', 'challenge',
  'onboarding_pace', 'event_reminder',
]

describe('customer push channels', () => {
  it('every known data.type resolves to a created channel', () => {
    const known = Object.keys(CUSTOMER_ANDROID_CHANNELS)
    for (const type of KNOWN_TYPES) {
      expect(known).toContain(customerAndroidChannelId(type))
    }
  })

  it('class reminders are the only high-importance channel', () => {
    expect(customerAndroidChannelId('class_reminder')).toBe('class_reminders')
    expect(CUSTOMER_ANDROID_CHANNELS.class_reminders.importance).toBe('high')
    for (const [id, spec] of Object.entries(CUSTOMER_ANDROID_CHANNELS)) {
      if (id !== 'class_reminders') expect(spec.importance).toBe('default')
    }
  })

  it('event_reminder rides the class_reminders channel, not default (was silently unmapped)', () => {
    expect(customerAndroidChannelId('event_reminder')).toBe('class_reminders')
  })

  it('legacy aliases cover the retired reminders pref key and never shadow a live channel id', () => {
    expect(LEGACY_CHANNEL_ALIASES.class_reminders).toEqual(['reminders'])
    const live = Object.keys(CUSTOMER_ANDROID_CHANNELS)
    for (const [current, aliases] of Object.entries(LEGACY_CHANNEL_ALIASES)) {
      expect(live).toContain(current)
      for (const alias of aliases) expect(live).not.toContain(alias)
    }
  })

  it('onboarding_pace nudges ride the progress channel (no new pref key)', () => {
    expect(customerAndroidChannelId('onboarding_pace')).toBe('progress')
  })

  it('unknown/missing types fall back to the legacy default channel', () => {
    expect(CUSTOMER_ANDROID_CHANNELS.default).toBeDefined()
    expect(customerAndroidChannelId('nope')).toBe('default')
    expect(customerAndroidChannelId()).toBe('default')
  })

  it('specs use only importance keys the registrar can map', () => {
    for (const spec of Object.values(CUSTOMER_ANDROID_CHANNELS)) {
      expect(['max', 'high', 'default']).toContain(spec.importance)
      expect(spec.name).toBeTruthy()
    }
  })
})
