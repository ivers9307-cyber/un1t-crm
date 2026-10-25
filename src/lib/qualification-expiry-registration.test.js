// QUALS.1 — the `qualification_expiry` push category is registered at EVERY
// site a category needs. An unregistered category fails CLOSED (CLAUDE.md):
// only masters would ever see it. Default ON for all six roles, not just
// owners, for the reason AVAIL.1 gives (availability-change-registration.test.js):
// sendPush without a locationId resolves ONE key for the person, so a single
// assignment resolving it false (an owner who is staff somewhere) would
// silence them everywhere. Recipients are narrowed in code
// (src/lib/qualification-digest.js: owners and masters only).

import { describe, it, expect } from 'vitest'
import { MOBILE_PERMISSIONS, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, NOTIFY_KEYS } from '@shared/permissions'
import { EXEMPT_KEYS } from '@shared/permission-bundles'
import { androidChannelId } from '@shared/push-channels'
import { getNotificationCategory } from './notifications-registry'
import { QUALIFICATION_DIGEST_CATEGORY, QUALIFICATION_DIGEST_TYPE } from './qualification-digest'

const KEY = 'notify_qualification_expiry'

describe('qualification_expiry category registration', () => {
  it('the digest sends the BARE category name, and it is this one', () => {
    expect(QUALIFICATION_DIGEST_CATEGORY).toBe('qualification_expiry')
    expect(QUALIFICATION_DIGEST_TYPE).toBe('qualification_digest')
  })

  it('is a personal, mobile-only notify toggle with a label the settings screens can render', () => {
    const entry = MOBILE_PERMISSIONS.find((p) => p.key === KEY)
    expect(entry).toMatchObject({ key: KEY, mobileOnly: true, isNotify: true })
    expect(entry.label).toMatch(/Qualification expiry/)
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

  it('rides the Android "reminders" channel (a scheduled nudge, like inspection_due)', () => {
    expect(androidChannelId({ category: 'qualification_expiry', type: 'qualification_digest' })).toBe('reminders')
  })

  it('is in the registry: cron, owners, email fallback carrying the list', () => {
    expect(getNotificationCategory('qualification_expiry')).toMatchObject({
      category: 'qualification_expiry',
      label: 'Qualification expiry',
      trigger: { kind: 'cron' },
      recipients: { kind: 'roles_at_location' },
      configurable: { leadTimes: false, roles: false },
      fallbackEmail: true,
      emailSubject: 'Qualifications to renew',
    })
  })
})
