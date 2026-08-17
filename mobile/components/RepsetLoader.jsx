// LOADER.1 — the Repset mark animated as a "rep counter".
//
// Three tally bars light one at a time (dim → full, like counting reps),
// then the diagonal volt strike scales + fades in across them to finish
// the set. Brief hold, then the whole thing resets and loops (~2.1s).
//
// WHY IT'S BUILT FROM PLAIN <View>s:
//   When this was written, `react-native-svg` was NOT installed and the
//   rule was "must not be added" — a native module would have forced a
//   new store binary and made this animation stop being OTA-shippable.
//   PHASE2 (one-app merge) consciously repealed that exclusion:
//   react-native-svg now ships in the 2.3.0 native lane alongside
//   HealthKit (the member-app tree needs it). This component stays as
//   plain <View>s because it works and there's no reason to rewrite it.
//   The mark is four rounded rectangles: three vertical bars + one
//   rotated bar for the strike. Reanimated 4.5.0 + react-native-worklets
//   0.10.0 are already in the build, so the motion itself rides the OTA
//   lane.
//
// PROPORTIONS are measured off mobile/assets/icon.png (1024×1024):
//   bars at x≈288/458/630, width≈102, y≈265→760 (height≈495), gap≈68;
//   strike from ≈(185,780) to ≈(835,240) — length≈845, thickness≈112,
//   angle≈-40°. Both the bar group and the strike centre on (510,510),
//   so everything here is centred in a square box of `size`. The icon's
//   safe-area padding is scaled out (MARK_SCALE) so the loader fills its
//   box rather than floating in the middle of it.
//
// ACCESSIBILITY: when the OS "Reduce Motion" setting is on we render the
// mark fully lit and completely static — no loop at all. The preference
// is read on mount and re-read live via lib/use-reduced-motion.js.

import { useEffect } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withRepeat,
  withSequence,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated'
import { useReducedMotion } from '../lib/use-reduced-motion'

// Brand values. Deliberately local literals rather than lib/colors.js —
// that module mirrors the LIGHT app palette (un1t-bg is white); these are
// the Repset mark/ink colours used by the icon + splash (#131316).
const BONE = '#F2F0EB'
const VOLT = '#D6F84C'
export const REPSET_INK = '#131316'

// Opacity of an "unlit" tally bar.
const DIM = 0.16

// Geometry as a fraction of `size` (icon fractions × MARK_SCALE).
const MARK_SCALE = 1.18
const f = (px) => (px / 1024) * MARK_SCALE
const BAR_W = f(102)
const BAR_H = f(495)
const BAR_GAP = f(68)
const STRIKE_L = f(845)
const STRIKE_T = f(112)
const STRIKE_ANGLE = '-40deg'

// Timeline (ms). Every shared value runs a sequence summing to _CYCLE so
// the bars and the strike can never drift apart across repeats.
const STAGGER = 240 // gap between one bar lighting and the next
const BAR_IN = 220
const STRIKE_AT = 1000 // ≈48% of the cycle
const STRIKE_IN = 340
const HOLD_END = 1700 // everything lit until here
const FADE_OUT = 260
const TAIL = 140 // dark beat before the next rep
// Underscore-prefixed because nothing reads it: the sequences below compose
// the same total by hand (barLoop is start + BAR_IN + (HOLD_END - start -
// BAR_IN) + FADE_OUT + TAIL, which cancels to exactly this). It stays as the
// written-down statement of that invariant — change any constant above and
// this is the number the sequences must still add up to.
const _CYCLE = HOLD_END + FADE_OUT + TAIL // 2100

// One bar's loop: light at `start`, hold, fade back to DIM, rest.
function barLoop(start) {
  return withRepeat(
    withSequence(
      withDelay(start, withTiming(1, { duration: BAR_IN, easing: Easing.out(Easing.quad) })),
      withDelay(
        HOLD_END - start - BAR_IN,
        withTiming(DIM, { duration: FADE_OUT, easing: Easing.in(Easing.quad) }),
      ),
      withDelay(TAIL, withTiming(DIM, { duration: 0 })),
    ),
    -1,
    false,
  )
}

function strikeLoop() {
  return withRepeat(
    withSequence(
      withDelay(
        STRIKE_AT,
        withTiming(1, { duration: STRIKE_IN, easing: Easing.out(Easing.cubic) }),
      ),
      withDelay(
        HOLD_END - STRIKE_AT - STRIKE_IN,
        withTiming(0, { duration: FADE_OUT, easing: Easing.in(Easing.quad) }),
      ),
      withDelay(TAIL, withTiming(0, { duration: 0 })),
    ),
    -1,
    false,
  )
}

export default function RepsetLoader({ size = 96, label, accessibilityLabel = 'Loading' }) {
  const reduceMotion = useReducedMotion()

  // 0..1 lit-ness. Bars start dim, strike starts absent.
  const bar1 = useSharedValue(DIM)
  const bar2 = useSharedValue(DIM)
  const bar3 = useSharedValue(DIM)
  const strike = useSharedValue(0)

  useEffect(() => {
    if (reduceMotion) {
      // Static, fully-lit mark. No loop is ever started.
      cancelAnimation(bar1)
      cancelAnimation(bar2)
      cancelAnimation(bar3)
      cancelAnimation(strike)
      bar1.value = 1
      bar2.value = 1
      bar3.value = 1
      strike.value = 1
      return undefined
    }

    bar1.value = barLoop(0)
    bar2.value = barLoop(STAGGER)
    bar3.value = barLoop(STAGGER * 2)
    strike.value = strikeLoop()

    // No orphaned loops: Reanimated animations outlive the React tree
    // unless explicitly cancelled.
    return () => {
      cancelAnimation(bar1)
      cancelAnimation(bar2)
      cancelAnimation(bar3)
      cancelAnimation(strike)
    }
  }, [reduceMotion, bar1, bar2, bar3, strike])

  const barW = Math.round(size * BAR_W)
  const barH = Math.round(size * BAR_H)
  const gap = Math.round(size * BAR_GAP)
  const strikeL = Math.round(size * STRIKE_L)
  const strikeT = Math.round(size * STRIKE_T)

  const barBase = {
    width: barW,
    height: barH,
    borderRadius: barW / 2,
    backgroundColor: BONE,
  }

  const bar1Style = useAnimatedStyle(() => ({ opacity: bar1.value }))
  const bar2Style = useAnimatedStyle(() => ({ opacity: bar2.value }))
  const bar3Style = useAnimatedStyle(() => ({ opacity: bar3.value }))
  // Rotate FIRST so scaleX grows the strike along its own axis — it reads
  // as the stroke being drawn across the bars rather than stretched.
  const strikeStyle = useAnimatedStyle(() => ({
    opacity: strike.value,
    transform: [
      { rotate: STRIKE_ANGLE },
      { scaleX: 0.68 + 0.32 * strike.value },
      { scaleY: 0.85 + 0.15 * strike.value },
    ],
  }))

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      className="items-center"
    >
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row' }}>
          <Animated.View style={[barBase, bar1Style]} />
          <Animated.View style={[barBase, bar2Style, { marginLeft: gap }]} />
          <Animated.View style={[barBase, bar3Style, { marginLeft: gap }]} />
        </View>
        <Animated.View
          style={[
            styles.strike,
            strikeStyle,
            {
              width: strikeL,
              height: strikeT,
              borderRadius: strikeT / 2,
              left: (size - strikeL) / 2,
              top: (size - strikeT) / 2,
            },
          ]}
        />
      </View>
      {label ? (
        <Text style={{ color: BONE, opacity: 0.7 }} className="text-sm mt-4">
          {label}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  // Absolutely positioned by left/top + explicit width/height — NOT
  // absoluteFill, whose right:0/bottom:0 would fight the width under Yoga.
  strike: {
    position: 'absolute',
    backgroundColor: VOLT,
  },
})
