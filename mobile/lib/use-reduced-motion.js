// MOBILE-A11Y-REDUCED-MOTION — hook to read the iOS / Android
// "Reduce Motion" accessibility preference and react to changes.
//
// Why this exists:
//   - iOS Settings → Accessibility → Motion → Reduce Motion is a
//     system-wide switch users with vestibular disorders or motion
//     sensitivity rely on. When on, iOS reduces or replaces parallax
//     effects, modal slide animations, app-switcher transitions etc.
//   - React Native's standard `Animated` API and `LayoutAnimation`
//     do NOT honour this preference automatically. Any custom motion
//     in the app keeps playing at full speed unless we gate it.
//   - expo-router's native-stack DOES honour iOS's setting at the
//     OS level (slide-up modals become cross-fades), but only if we
//     leave `animation` at the default. Setting `animation: 'slide'`
//     overrides the system behaviour and is what makes the
//     `animation` prop motion-aware via this hook.
//
// Contract:
//   - Returns a boolean. true = user prefers reduced motion.
//   - Initial value is false until the async read of
//     AccessibilityInfo.isReduceMotionEnabled() completes. This is a
//     deliberate safe-default: the (typically <50ms) flash of full
//     motion at app cold-start is acceptable; a flash of reduced
//     motion would be more disorienting (skipping the launch
//     transition) than the opposite.
//   - Subscribes to runtime changes via the 'reduceMotionChanged'
//     event. iOS fires this immediately when the user toggles the
//     setting in Control Center → so a long-running session that
//     pages an episode in motion sickness can be calmed mid-session.
//   - Listener is unsubscribed on unmount via the AccessibilityInfo
//     subscription handle (RN 0.65+ API; the legacy removeEventListener
//     path is not supported).

import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

// Re-export the helper so existing call sites don't need to change
// which file they import from. The actual implementation lives in
// motion-aware-stack-options.js so it stays testable (this file
// can't be loaded under vitest because of the react-native import).
export { motionAwareStackOptions } from './motion-aware-stack-options'

export function useReducedMotion() {
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let mounted = true

    // Initial read. AccessibilityInfo.isReduceMotionEnabled() returns
    // a Promise on all platforms (iOS, Android, web). On web it
    // resolves to whatever prefers-reduced-motion media query says.
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduceMotion(!!value)
      })
      .catch(() => {
        // Older RN / unsupported platform — silent fallback to false.
        // Motion plays as normal; the worst case is the user with
        // Reduce Motion on sees slightly more motion than expected.
        if (mounted) setReduceMotion(false)
      })

    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (value) => {
        if (mounted) setReduceMotion(!!value)
      },
    )

    return () => {
      mounted = false
      // RN 0.65+ returns an EmitterSubscription with .remove().
      // Defensive: some older versions return undefined; check first.
      if (sub && typeof sub.remove === 'function') sub.remove()
    }
  }, [])

  return reduceMotion
}

