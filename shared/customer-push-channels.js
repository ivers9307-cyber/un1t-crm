// KEEP IN SYNC with champ-app/shared/customer-push-channels.js (verbatim copy).
//
// Android notification channels for the CUSTOMER app (champ-app) — channel
// specs + data.type→channel map. Customer push payloads carry no `category`
// field; the router key is `data.type` (same key the champ-app notification
// router switches on in mobile/app/_layout.jsx).
//
// Two consumers:
//   - champ-app mobile/lib/push-register.js creates the channels on Android.
//   - BOTH servers' src/lib/customer-push.js stamp `channelId` on each Expo
//     message (un1t-crm crons send class reminders / winbacks / challenges;
//     champ-app sends social + session pushes).
//
// ⚠️ Android channels are IMMUTABLE once created on a device — importance
// can never be raised programmatically after creation; a re-spec needs a
// NEW channel id. Treat the ids below as append-only.
//
// Importance is a lowercase string key (servers must not import
// expo-notifications); the mobile registrar maps it via
// Notifications.AndroidImportance[key.toUpperCase()]:
//   high    → heads-up banner + sound (time-sensitive)
//   default → sound, no heads-up (informational)
//
// iOS ignores channelId entirely.

export const CUSTOMER_ANDROID_CHANNELS = Object.freeze({
  reminders: Object.freeze({
    name: 'Class reminders',
    description: 'Reminders before your booked classes.',
    importance: 'high',
  }),
  social: Object.freeze({
    name: 'Social',
    description: 'Friend requests and reactions from your gym friends.',
    importance: 'default',
  }),
  progress: Object.freeze({
    name: 'Progress',
    description: 'Session reports, achievements, goals, streaks and challenges.',
    importance: 'default',
  }),
  // Legacy channel — every install created it pre-channels, and it's the
  // fallback for unknown types (Android would otherwise auto-create a
  // system "Miscellaneous" channel). Keep the original lowercase name.
  default: Object.freeze({
    name: 'default',
    description: 'Everything else.',
    importance: 'default',
  }),
})

// data.type → channel id.
const CUSTOMER_TYPE_CHANNELS = Object.freeze({
  // Pre-class reminder cron (un1t-crm, mig 323) — time-sensitive.
  class_reminder: 'reminders',
  // Social layer (champ-app routes).
  friend_request: 'social',
  feed: 'social',
  // Progress & engagement (session end, goal/tier crons, challenges).
  session_report: 'progress',
  achievement: 'progress',
  goal: 'progress',
  tier_up: 'progress',
  monthly_target_hit: 'progress',
  streak_at_risk: 'progress',
  winback: 'progress',
  challenge: 'progress',
  // First-90-days pace nudge (un1t-crm notify-onboarding-pace cron, PULSE-90).
  onboarding_pace: 'progress',
})

/**
 * Resolve the Android channel id for a customer push payload's data.type.
 * Unknown/missing types fall back to the legacy 'default' channel.
 *
 * @param {string} [type]  payload.data.type
 * @returns {string} a key of CUSTOMER_ANDROID_CHANNELS
 */
export function customerAndroidChannelId(type) {
  return (type && CUSTOMER_TYPE_CHANNELS[type]) || 'default'
}
