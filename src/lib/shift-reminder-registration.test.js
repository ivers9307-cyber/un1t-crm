// SHIFTREMIND.1 — the `shift_reminder` push category is registered at EVERY
// site a category needs, default ON for every role.
//
// Why one file pins all of them: an unregistered sendPush category fails
// CLOSED (CLAUDE.md). resolvePermission's last tier is
// `defaults[role][key] === true`, so a key missing from one role's defaults
// silently sends that role nothing, and only `master` (who bypasses the
// tiers) would ever see the push while testing it.

import { describe, it, expect } from 'vitest'
import { MOBILE_PERMISSIONS, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, NOTIFY_KEYS } from '@shared/permissions'
import { EXEMPT_KEYS } from '@shared/permission-bundles'
import { androidChannelId } from '@shared/push-channels'
import { getNotificationCategory } from './notifications-registry'

const KEY = 'notify_shift_reminder'

describe('shift_reminder category registration', () => {
  it('is a personal, mobile-only notify toggle with a label the settings screens can render', () => {
    const entry = MOBILE_PERMISSIONS.find((p) => p.key === KEY)
    expect(entry).toMatchObject({ key: KEY, mobileOnly: true, isNotify: true })
    expect(entry.label).toMatch(/Shift reminders/)
    expect(entry.hint).toMatch(/8pm the evening before/)
    expect(NOTIFY_KEYS).toContain(KEY)
  })

  it('defaults ON for every role (a missing role default is a silent opt-out)', () => {
    const roles = Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE)
    expect(roles.sort()).toEqual(['head_coach', 'manager', 'master', 'owner', 'reception', 'staff'])
    for (const role of roles) {
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role][KEY], `${role}.${KEY}`).toBe(true)
    }
  })

  it('is exempt from the location feature gate, like every other notify_* key', () => {
    expect(EXEMPT_KEYS).toContain(KEY)
  })

  it('rides the Android "reminders" channel, by category and with its data.type', () => {
    expect(androidChannelId({ category: 'shift_reminder' })).toBe('reminders')
    expect(androidChannelId({ category: 'shift_reminder', type: 'shift_reminder' })).toBe('reminders')
  })

  it('is in the notifications registry as a cron category WITH the email fallback', () => {
    expect(getNotificationCategory('shift_reminder')).toMatchObject({
      category: 'shift_reminder',
      label: 'Shift reminders',
      trigger: { kind: 'cron' },
      recipients: { kind: 'assignee' },
      configurable: { leadTimes: false, roles: false },
      fallbackEmail: true,
    })
  })
})
