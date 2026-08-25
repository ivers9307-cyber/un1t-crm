// PHASE2 stage C — merged push routing for the one-app world. Two pure
// decisions, both consumed by the root layout:
//
//   resolveNotificationTap(data)      — which SHELL owns this tap, and
//                                       where inside it to deep-link.
//   presentationForNotification(data) — how a FOREGROUND push presents
//                                       (staff keeps today's sound+badge
//                                       banner; member keeps champ's
//                                       silent banner).
//
// Staff notification-nav is consulted FIRST, the member map second — the
// two type sets are disjoint today, and staff-first means any future
// collision resolves in favour of the pre-merge behaviour. Contract
// mirrors both nav modules: {side, path} to navigate, null for a known
// type with deliberately no navigation, undefined for an unknown type
// (the caller logs the gap).

import { routeForNotification } from './notification-nav'
import { routeForMemberNotification, isMemberNotificationType } from './member/notification-nav'

export function resolveNotificationTap(data) {
  const staffRoute = routeForNotification(data)
  if (typeof staffRoute === 'string') return { side: 'staff', path: staffRoute }
  if (staffRoute === null && !isMemberNotificationType(data?.type)) {
    // Known-staff-no-nav (e.g. admin_test_push) — and routeForNotification's
    // missing-type null, which the member map can't claim either.
    return null
  }
  const memberRoute = routeForMemberNotification(data)
  if (typeof memberRoute === 'string') return { side: 'member', path: memberRoute }
  if (memberRoute === null) return null // known member type, deliberately no nav
  return undefined
}

// Champ presented foreground member pushes silently (banner, no sound, no
// badge); the staff app presents with sound + badge. Unknown types present
// staff-style — that is today's behaviour, since the staff handler applied
// to every push.
export function presentationForNotification(data) {
  const member = isMemberNotificationType(data?.type)
  return {
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: !member,
    shouldSetBadge: !member,
  }
}
