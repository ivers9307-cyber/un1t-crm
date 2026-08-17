// PHASE2 (one-app merge, stage B) — the member push-tap → route mapping,
// extracted as a PURE function from the switch inside champ's root-layout
// NotificationRouter (champ-app/mobile/app/_layout.jsx). Ported "as far as
// compiling": nothing consumes it yet — champ's NotificationRouter itself
// read useAuth(), so mounting it is stage-C work (the staff NotificationRouter
// in app/_layout.jsx keeps handling pushes exactly as today).
//
// Mirrors the staff lib/notification-nav.js contract:
//   string  → route to push
//   null    → known type, deliberately no navigation
//   undefined → unknown type (caller logs the gap).
// Group folders add no URL segment, so these paths hit the (member) tree by
// implicit path mapping once it is reachable.

// Membership predicate for the merged root handler (stage C): true iff the
// type belongs to the member map above — i.e. routeForMemberNotification
// would NOT report it unknown. Used to pick the foreground presentation and
// to keep known-member no-nav types from being logged as gaps.
export function isMemberNotificationType(type) {
  if (typeof type !== 'string') return false
  return routeForMemberNotification({ type }) !== undefined
}

export function routeForMemberNotification(data) {
  if (!data || typeof data.type !== 'string') return undefined
  switch (data.type) {
    case 'session_report':
      return data.session_id ? `/sessions/${data.session_id}` : null
    case 'achievement':
      return '/account/achievements'
    case 'goal':
      return '/account/goals'
    case 'streak_at_risk':
    case 'winback':
    case 'monthly_target_hit':
    case 'tier_up':
      // Land on the member dashboard. NOTE: '/' is the STAFF home until the
      // stage-C resolver lands — the member home lives at '/home' after the
      // (tabs)/index → home rename. Stage C decides the final landing route.
      return '/home'
    case 'challenge':
      return '/challenges'
    case 'friend_request':
      return '/social?seg=friends'
    case 'feed':
      return '/social?seg=feed'
    case 'class_reminder':
      // Pre-class reminder (un1t-crm cron, mig 323). No booking/class detail
      // screen exists in the member tree (booking lives in Glofox — see
      // "Pulse scope"), so land on the dashboard.
      return '/home'
    case 'onboarding_pace':
      // First-6-weeks pace nudge — the journey card tops the member home.
      return '/home'
    default:
      return undefined
  }
}
