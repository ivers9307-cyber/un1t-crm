'use client'

// TVSCENE.1 — what the board shows when nothing is live.
//
// The rotation is stateless on purpose: the scene is derived from
// (nowMs - idleSinceMs), and the board already re-renders every second for its
// header clock, so the rotation advances with no timer of its own. See
// src/lib/tv-scenes.js.
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
//
// One piece of state lives here: the image URLs that failed to load, each with
// the board-clock time it failed. A dead image (deleted from the bucket, a bad
// URL, no network) is a scene with nothing to show, so for
// IMAGE_FAILURE_WINDOW_MS the stage reads the row as having no image and the
// usual rules apply: the label draws if there is one, otherwise the scene drops
// out of the rotation, and if that leaves nothing the stage hands over to its
// `fallback`. Failures are keyed by URL, so a later, different push is judged
// on its own, and they EXPIRE: a kiosk keeps one page load for days, so a
// failure that lasted until reload would let one blip at 3am silently drop the
// operator scene until somebody restarted Chromium. After the window the image
// is simply requested again; a still-dead one fails again and re-enters the
// window, so it is retried once per window, not once per frame.

import { useState } from 'react'
import { eligibleScenes, sceneAt, operatorImageRef, operatorLabel } from '@/lib/tv-scenes'

/** How long a failed image URL is treated as dead before it is requested again. */
export const IMAGE_FAILURE_WINDOW_MS = 10 * 60 * 1000

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

function OperatorScene({ operator, fonts, onImageError }) {
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
        <img
          src={src}
          alt={label ?? ''}
          onError={() => onImageError(src)}
          className="max-h-full max-w-full object-contain"
        />
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

/** Did a URL fail within the window ending at `nowMs`? A clock that moved backwards is not "recent". */
function failedWithinWindow(failedAtMs, nowMs) {
  const elapsed = nowMs - failedAtMs
  return elapsed >= 0 && elapsed < IMAGE_FAILURE_WINDOW_MS
}

/**
 * The idle block as the stage should see it while some image URLs are known to
 * be dead: an operator row whose image failed recently has no image, so it
 * keeps its label (if any) and loses its ref. Everything downstream
 * (eligibility, the image/label branch) is still decided by tv-scenes.js on
 * that row.
 */
function withoutDeadImage(idle, failedImages, nowMs) {
  const src = operatorImageRef(idle?.operator)
  if (src === null || !failedImages.has(src)) return idle
  if (!failedWithinWindow(failedImages.get(src), nowMs)) return idle
  return { ...idle, operator: { ...idle.operator, source_ref: null } }
}

/**
 * One idle scene, chosen by elapsed time. When no scene has anything to show
 * (nothing eligible, or the only content was an image that would not load) it
 * returns `fallback`, null by default.
 *
 * `fallback` is a prop rather than the caller testing for null because
 * `<IdleStage />` is always a non-null ELEMENT, however little it renders, so
 * `idleStage ?? <EmptyBoard />` on the bare element can never reach the empty
 * board. It also lets the stage fall back for a reason only it knows (a dead
 * image).
 */
export default function IdleStage({ idle, nowMs, idleSinceMs, fonts, fallback = null }) {
  // url -> the board-clock time it failed. The clock is the `nowMs` prop, so
  // the window is decided by the same time the rotation uses.
  const [failedImages, setFailedImages] = useState(() => new Map())
  const now = Number(nowMs)
  const showable = withoutDeadImage(idle, failedImages, now)
  const key = sceneAt(eligibleScenes(showable), now - Number(idleSinceMs))
  if (!key) return fallback

  const onImageError = (src) => setFailedImages((prev) => {
    // Forget what has already expired while we are here, so the map is bounded
    // by the URLs that failed in the last window, not by every push ever made.
    const next = new Map()
    for (const [url, at] of prev) if (failedWithinWindow(at, now)) next.set(url, at)
    return next.set(src, now)
  })

  let body
  if (key === 'up-next') body = <UpNextScene rows={showable.up_next} fonts={fonts} />
  else if (key === 'earned') body = <EarnedScene rows={showable.earned} fonts={fonts} />
  else body = <OperatorScene operator={showable.operator} fonts={fonts} onImageError={onImageError} />

  return (
    <div key={key} className="flex min-h-0 flex-1 flex-col justify-center px-10 py-6">
      {body}
    </div>
  )
}
