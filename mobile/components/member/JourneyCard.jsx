// First-6-weeks journey card — the member-facing half of the Pulse
// first-90-days feature (spec: un1t-crm docs/superpowers/specs/
// 2026-06-28-pulse-hub-first-90-days-design.md).
//
// Approved mockup: segmented progress ring LEFT, copy RIGHT (week label +
// motivational message), week tick bar BELOW. Chalk-on-iron Afterglow identity;
// the resting Pearl accent marks earned progress (no zone data is in scope
// here, so the chrome rests on Pearl rather than an earned zone colour).
// Celebration variant (pearl glow + trophy) when the member hits the target;
// the shared shaper hides the card again a few days later.
//
// HARD PRODUCT CONSTRAINT (pulse-scope-no-booking): purely motivational —
// no copy in this component or in shared/onboarding-journey.js may contain
// booking language. All member-visible sentences live in the shared shaper
// (tested with /book/i); the only literals here are structural labels.
//
// Props:
//   card         — output of shapeJourneyCard() (shared/onboarding-journey.js);
//                  null/undefined renders nothing (fail-invisible).
//   reduceMotion — from useReduceMotion(); segments snap instead of sweeping.

import { View, Text, Animated } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Svg, { Path } from 'react-native-svg'
import { PEARL, VOLT } from '../../lib/member/brand'
import { useProgressSweep } from '../../lib/member/motion'

const AnimatedPath = Animated.createAnimatedComponent(Path)

const TRACK = '#2A2A31' // iron-hairline — visible on the surface, clearly "empty"

export default function JourneyCard({ card, reduceMotion }) {
  if (!card) return null
  const completed = card.status === 'completed'

  return (
    <View
      className="rounded-[24px] p-5 overflow-hidden"
      style={
        completed
          ? // Celebration: volt glow band (P4b — completion is EARNED; same
            // treatment as the tier hero's lit accent).
            { backgroundColor: voltAlpha(0.1), borderWidth: 1, borderColor: voltAlpha(0.35) }
          : { backgroundColor: '#1C1C21', borderWidth: 1, borderColor: TRACK }
      }
    >
      <View className="flex-row items-center" style={{ gap: 18 }}>
        {/* Ring left — one arc segment per target class, earned ones in pearl */}
        <SegmentedRing ticks={card.ticks} completed={completed} reduceMotion={reduceMotion} />

        {/* Copy right — week label + count + status-variant message */}
        <View className="flex-1 min-w-0">
          <Text
            className="font-mono text-[10px] uppercase"
            style={{ color: completed ? VOLT : PEARL, letterSpacing: 2 }}
          >
            {completed ? 'Complete' : card.weekLabel}
          </Text>
          <Text className="mt-0.5 text-base font-display-bold text-chalk" numberOfLines={1}>
            {card.countLabel}
          </Text>
          <Text className="mt-1 text-xs font-body leading-4 text-chalk-2">{card.message}</Text>
        </View>
      </View>

      {/* Week tick bar below — one segment per week of the window */}
      <WeekTickBar week={card.week} totalWeeks={card.totalWeeks} completed={completed} />
    </View>
  )
}

// ── Segmented progress ring ──────────────────────────────────────
//
// One arc segment per target class (9 by default). Filled segments are pearl
// (volt once the journey completes — P4b); unfilled stay on the neutral track. On mount the earned segments light up
// one after another (a single sweep value drives staggered opacities — snaps
// straight to done under Reduce Motion, matching lib/motion.js semantics).
function SegmentedRing({ ticks, completed, reduceMotion }) {
  const SIZE = 76
  const STROKE = 7
  const R = (SIZE - STROKE) / 2
  const segments = ticks.length
  const filled = ticks.filter((t) => t.filled).length
  const sweep = useProgressSweep(1, { reduceMotion, duration: 900 })

  // Per-segment geometry: divide the circle into `segments` slices with a
  // small gap between them; start at 12 o'clock.
  const sliceDeg = 360 / segments
  const gapDeg = Math.min(10, sliceDeg / 3)
  const paths = ticks.map((t, i) => ({
    d: arcPath(SIZE / 2, SIZE / 2, R, i * sliceDeg + gapDeg / 2, (i + 1) * sliceDeg - gapDeg / 2),
    filled: t.filled,
    // Stagger: segment i fades in during its own slice of the sweep.
    opacity: t.filled
      ? sweep.interpolate({
          inputRange: [i / Math.max(filled, 1), Math.min((i + 1) / Math.max(filled, 1), 1)],
          outputRange: [0, 1],
          extrapolate: 'clamp',
        })
      : null,
  }))

  return (
    <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={SIZE} height={SIZE}>
        {/* Track under every position, so unearned ticks always show */}
        {paths.map((p, i) => (
          <Path
            key={`t${i}`}
            d={p.d}
            stroke={TRACK}
            strokeWidth={STROKE}
            strokeLinecap="round"
            fill="none"
          />
        ))}
        {/* Earned segments — pearl while accruing, volt once complete (P4b) */}
        {paths.map((p, i) =>
          p.filled ? (
            <AnimatedPath
              key={`f${i}`}
              d={p.d}
              // P4b: volt once the journey is complete; pearl while accruing.
              stroke={completed ? VOLT : PEARL}
              strokeWidth={STROKE}
              strokeLinecap="round"
              fill="none"
              opacity={p.opacity}
            />
          ) : null
        )}
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center' }}>
        {completed ? (
          <Ionicons name="trophy" size={24} color={VOLT} />
        ) : (
          <Text className="text-base font-display-black text-chalk">
            {filled}/{segments}
          </Text>
        )}
      </View>
    </View>
  )
}

// ── Week tick bar ────────────────────────────────────────────────
//
// One slim segment per week of the window (6 by default). Weeks already
// reached are lit (neutral chalk — time elapsed, distinct from the pearl
// "classes earned" ring); the whole bar goes volt on completion (P4b).
function WeekTickBar({ week, totalWeeks, completed }) {
  const weeks = Number.isFinite(totalWeeks) && totalWeeks > 0 ? Math.floor(totalWeeks) : 6
  const current = Number.isFinite(week) ? week : 0
  return (
    <View className="mt-4 flex-row" style={{ gap: 6 }}>
      {Array.from({ length: weeks }, (_, i) => {
        const reached = completed || i < current
        return (
          <View
            key={i}
            className="h-1.5 flex-1 rounded-full"
            style={{
              backgroundColor: completed
                ? VOLT
                : reached
                  ? 'rgba(241,238,231,0.75)'
                  : '#24242A', // iron-raised
            }}
          />
        )
      })}
    </View>
  )
}

// SVG arc path along a circle: angles in degrees, 0° at 12 o'clock, clockwise.
function arcPath(cx, cy, r, startDeg, endDeg) {
  const start = polar(cx, cy, r, startDeg)
  const end = polar(cx, cy, r, endDeg)
  const largeArc = endDeg - startDeg > 180 ? 1 : 0
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

// '#rrggbb'-safe volt alpha for the completion celebration tint (RN colour
// parser). P4b: completion is EARNED, so the tint is volt.
function voltAlpha(alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  return `${VOLT}${a.toString(16).padStart(2, '0')}`
}
