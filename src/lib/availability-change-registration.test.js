// AVAIL.1 — the `availability_change` push category is registered at EVERY
// site a category needs. An unregistered category fails CLOSED (CLAUDE.md):
// only masters would ever see it. Default ON for all six roles, not just the
// roster builders: sendPushOnce passes no locationId, so ONE assignment that
// resolves the key false (an owner who is `staff` somewhere, PUSH-LOC.1)
// silences the person everywhere. Recipients are narrowed in code instead.

import { describe, it, expect } from 'vitest'
import { MOBILE_PERMISSIONS, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, NOTIFY_KEYS } from '@shared/permissions'
import { EXEMPT_KEYS } from '@shared/permission-bundles'
import { androidChannelId } from '@shared/push-channels'
import { getNotificationCategory } from './notifications-registry'

const KEY = 'notify_availability_change'

describe('availability_change category registration', () => {
  it('is a personal, mobile-only notify toggle with a label the settings screens can render', () => {
    const entry = MOBILE_PERMISSIONS.find((p) => p.key === KEY)
    expect(entry).toMatchObject({ key: KEY, mobileOnly: true, isNotify: true })
    expect(entry.label).toMatch(/Availability changes/)
    expect(NOTIFY_KEYS).toContain(KEY)
  })

  it('defaults ON for every role', () => {
    const roles = Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE)
    expect(roles.sort()).toEqual(['head_coach', 'manager', 'master', 'owner', 'reception', 'staff'])
    for (const role of roles) expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role][KEY], role).toBe(true)
  })

  it('is exempt from the location feature gate, like every notify_* key', () => {
    expect(EXEMPT_KEYS).toContain(KEY)
  })

  it('rides the Android "updates" channel (an FYI, nothing to decide)', () => {
    expect(androidChannelId({ category: 'availability_change', type: 'availability_changed' })).toBe('updates')
  })

  it('is in the registry: event + cron, roster builders, no email fallback', () => {
    expect(getNotificationCategory('availability_change')).toMatchObject({
      category: 'availability_change',
      label: 'Availability changes',
      trigger: { kind: 'event' },
      recipients: { kind: 'roles_at_location' },
      configurable: { leadTimes: false, roles: false },
      fallbackEmail: false,
    })
  })
})
