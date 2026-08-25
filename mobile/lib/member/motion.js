// Restrained, OTA-safe motion helpers built on React Native's built-in
// Animated API (no extra dependency, no native module). Every animation here
// honours the OS "Reduce Motion" setting: when it's on, values jump straight to
// their final state with no tween.
//
// Used by the Home hero (count-up on the tier points + streak, tier ring
// animating in on mount).

import { useEffect, useRef, useState } from 'react'
import { Animated, AccessibilityInfo, Easing } from 'react-native'

/**
 * Track the OS "Reduce Motion" preference. Returns a boolean that starts
 * `false` and updates once the async read resolves + on any later change.
 */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => { if (mounted) setReduce(!!v) })
      .catch(() => {})
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => {
      if (mounted) setReduce(!!v)
    })
    return () => { mounted = false; sub?.remove?.() }
  }, [])
  return reduce
}

/**
 * Count a number up from 0 → `value` over `duration` ms on mount / when `value`
 * changes. Returns the current integer to render. With reduce-motion on (or a
 * non-finite value) it returns `value` immediately — no animation.
 *
 * @param {number} value    target value
 * @param {object} [opts]
 * @param {number} [opts.duration=800]
 * @param {boolean} [opts.reduceMotion=false]
 * @returns {number}
 */
export function useCountUp(value, { duration = 800, reduceMotion = false } = {}) {
  const target = Number.isFinite(value) ? value : 0
  const anim = useRef(new Animated.Value(0)).current
  const [display, setDisplay] = useState(reduceMotion ? target : 0)

  useEffect(() => {
    if (reduceMotion || !Number.isFinite(value)) {
      setDisplay(target)
      return
    }
    anim.setValue(0)
    const id = anim.addListener(({ value: v }) => {
      setDisplay(Math.round(v * target))
    })
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // JS listener needs the value on the JS thread
    })
    animation.start()
    return () => { animation.stop(); anim.removeListener(id) }
    // Re-run when the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, reduceMotion])

  return display
}

/**
 * A 0→1 progress driver that animates in on mount (for the tier ring / bar
 * sweeping to `pct`). Returns an Animated.Value in [0, pct]. With reduce-motion
 * on it's set to `pct` immediately.
 *
 * @param {number} pct  0..1 final fill
 * @param {object} [opts]
 * @param {number} [opts.duration=900]
 * @param {boolean} [opts.reduceMotion=false]
 * @returns {Animated.Value}
 */
export function useProgressSweep(pct, { duration = 900, reduceMotion = false } = {}) {
  const target = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : 0
  const anim = useRef(new Animated.Value(reduceMotion ? target : 0)).current

  useEffect(() => {
    if (reduceMotion) {
      anim.setValue(target)
      return
    }
    anim.setValue(0)
    const animation = Animated.timing(anim, {
      toValue: target,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    })
    animation.start()
    return () => animation.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, reduceMotion])

  return anim
}
