// PHASE2 stage C — merged push routing. One tap router serves both
// shells: staff notification-nav is consulted FIRST, the member map
// second, and the result carries the OWNING SIDE so the root router can
// flip the persisted side before deep-linking. Foreground presentation
// likewise branches per side: staff pushes keep today's sound+badge
// banner; member pushes keep champ's silent banner.

import { describe, it, expect } from 'vitest'
import { resolveNotificationTap, presentationForNotification } from './notification-side'
import { isMemberNotificationType } from './member/notification-nav'

describe('resolveNotificationTap', () => {
  it('staff type → staff side, staff route', () => {
    expect(resolveNotificationTap({ type: 'task_reminder', task_id: 't1' }))
      .toEqual({ side: 'staff', path: '/tasks/t1' })
    expect(resolveNotificationTap({ type: 'whatsapp_inbound', conversation_id: 'c9' }))
      .toEqual({ side: 'staff', path: '/whatsapp/c9' })
  })

  it('member type → member side, member route', () => {
    expect(resolveNotificationTap({ type: 'session_report', session_id: 's1' }))
      .toEqual({ side: 'member', path: '/sessions/s1' })
    expect(resolveNotificationTap({ type: 'class_reminder' }))
      .toEqual({ side: 'member', path: '/home' })
    expect(resolveNotificationTap({ type: 'friend_request' }))
      .toEqual({ side: 'member', path: '/social?seg=friends' })
  })

  it('known type with deliberate no-nav → null (both maps)', () => {
    // staff: admin test push routes nowhere
    expect(resolveNotificationTap({ type: 'admin_test_push' })).toBe(null)
    // member: session_report without an id is known but unroutable
    expect(resolveNotificationTap({ type: 'session_report' })).toBe(null)
  })

  it('unknown type → undefined (caller logs the gap, no navigation)', () => {
    expect(resolveNotificationTap({ type: 'totally_new_type' })).toBe(undefined)
  })

  it('malformed payload → null (staff nav treats missing type as no-nav, today\'s behaviour)', () => {
    expect(resolveNotificationTap(null)).toBe(null)
    expect(resolveNotificationTap({})).toBe(null)
  })
})

describe('isMemberNotificationType', () => {
  it('true for every member map type', () => {
    for (const t of ['session_report', 'achievement', 'goal', 'streak_at_risk', 'winback',
      'monthly_target_hit', 'tier_up', 'challenge', 'friend_request', 'feed',
      'class_reminder', 'onboarding_pace']) {
      expect(isMemberNotificationType(t)).toBe(true)
    }
  })

  it('false for staff and unknown types', () => {
    expect(isMemberNotificationType('task_reminder')).toBe(false)
    expect(isMemberNotificationType('whatsapp_inbound')).toBe(false)
    expect(isMemberNotificationType('nope')).toBe(false)
    expect(isMemberNotificationType(undefined)).toBe(false)
  })
})

describe('presentationForNotification', () => {
  it('member types keep champ\'s silent foreground banner', () => {
    expect(presentationForNotification({ type: 'session_report' })).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    })
  })

  it('staff types keep today\'s sound+badge banner', () => {
    expect(presentationForNotification({ type: 'whatsapp_inbound' })).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    })
  })

  it('unknown/missing types present as staff (today\'s default handler applied to everything)', () => {
    expect(presentationForNotification({ type: 'mystery' }).shouldPlaySound).toBe(true)
    expect(presentationForNotification(undefined).shouldPlaySound).toBe(true)
  })
})
