'use client'

// TVSCENE.1 — what the board shows when nothing is live.
//
// Stateless on purpose: the scene is derived from (nowMs - idleSinceMs), and
// the board already re-renders every second for its header clock, so the
// rotation advances with no timer of its own. See src/lib/tv-scenes.js.
//
// This file DRAWS; it does not decide. Which scenes exist, which one is up and
// what the operator card is made of all come from @/lib/tv-scenes
// (eligibleScenes, sceneAt, operatorImageRef, operatorLabel). Restating any of
// those here is how Task 1's blank-stage bugs happened, so the operator scene
// branches on what those functions return and reads no source_type itself.
//
// 720px budget: this component is the flex child that YIELDS (min-h-0), the
// same contract as the tile grid it replaces. Every row inside is shrink-0 and
// nothing here is fixed-height.
//
// Content rules, pinned in IdleStage.test.jsx: a class shows its TIME and NAME
// only (never capacity or a booked count), and the Earned scene lists
// individual member moments only (never a count of them).

import { eligibleScenes, sceneAt, operatorImageRef, operatorLabel } from '@/lib/tv-scenes'

const BONE = '#F1EEE7'
const BONE_2 = '#B1AEA6'
const BONE_3 = '#75726B'
const VOLT = '#D6FF3D'
const VOLT_INK = '#2A3305'
const SURFACE = '#1C1C21'
const HAIRLINE = '#30303A'

function Kicker({ children, fonts }) {
  return (
    <p
      className="shrink-0 text-[11px] uppercase tracking-[0.2em]"
      style={{ fontFamily: fonts.mono, color: BONE_3 }}
    >
      {children}
    </p>
  )
}

function UpNextScene({ rows, fonts }) {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Kicker fonts={fonts}>Up next</Kicker>
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
        {rows.map((r, i) => (
          <div key={`${r.starts_at}-${i}`} className="flex shrink-0 items-baseline gap-6">
            <span
              className="tabular-nums"
              style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 40, color: i === 0 ? VOLT : BONE }}
            >
              {r.starts_at_label}
            </span>
            <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 26, color: i === 0 ? BONE : BONE_2 }}>
              {r.class_name || 'Class'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function EarnedScene({ rows, fonts }) {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Kicker fonts={fonts}>Earned this week</Kicker>
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
        {rows.map((r, i) => {
          const top = Number(r.tier) >= 4
          return (
            <div key={`${r.display_name}-${r.achievement}-${i}`} className="flex shrink-0 items-center gap-6">
              <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 30, color: BONE, minWidth: 260 }}>
                {r.display_name}
              </span>
              <span
                className="rounded-full px-5 py-1.5"
                style={{
                  fontFamily: fonts.display, fontWeight: 700, fontSize: 20,
                  background: top ? VOLT : SURFACE,
                  color: top ? VOLT_INK : BONE,
                  border: `1px solid ${top ? VOLT : HAIRLINE}`,
                }}
              >
                {r.achievement}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function OperatorScene({ operator, fonts }) {
  // Two branches, both decided by tv-scenes.js. An image is drawn only when
  // operatorImageRef returns a string, and that string is the src as it stands:
  // the payload builder already resolved a storage path to a public URL and
  // operatorImageRef already trimmed it, so nothing here re-resolves, re-trims
  // or rebuilds from source_ref. Otherwise the label draws, if it has one.
  // A template renders through the cast canvas in a later pass; until then it
  // shows its label, which is operator-editable copy rather than a hard-coded
  // string.
  const src = operatorImageRef(operator)
  const label = operatorLabel(operator)
  if (src) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <img src={src} alt={label ?? ''} className="max-h-full max-w-full object-contain" />
      </div>
    )
  }
  if (!label) return null
  return (
    <div className="flex min-h-0 flex-1 items-center overflow-hidden">
      <p style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 52, color: BONE, letterSpacing: '-0.02em' }}>
        {label}
      </p>
    </div>
  )
}

/**
 * One idle scene, chosen by elapsed time. Returns null when nothing is
 * eligible so the caller can fall back to its own empty board.
 */
export default function IdleStage({ idle, nowMs, idleSinceMs, fonts }) {
  const eligible = eligibleScenes(idle)
  const key = sceneAt(eligible, Number(nowMs) - Number(idleSinceMs))
  if (!key) return null

  let body = null
  if (key === 'up-next') body = <UpNextScene rows={idle.up_next} fonts={fonts} />
  else if (key === 'earned') body = <EarnedScene rows={idle.earned} fonts={fonts} />
  else if (key === 'operator') body = <OperatorScene operator={idle.operator} fonts={fonts} />
  if (!body) return null

  return (
    <div key={key} className="flex min-h-0 flex-1 flex-col justify-center px-10 py-6">
      {body}
    </div>
  )
}
