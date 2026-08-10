'use client'

// GAPS-P4 — the one place the send-time quiet-hours advisory is rendered.
//
// Four surfaces create a send (UnifiedSendComposer, CampaignEditor,
// SMSBroadcastEditor, WABroadcastEditor) and all four could put a message on
// somebody's phone at 22:44. Rather than four copies of the same warning, they
// all mount this component and hand it the instant the send would actually go
// out.
//
// The contract is INFORM AND OFFER, never change behaviour:
//   • it never disables or hides the send button;
//   • it never rewrites the scheduled time on its own — the suggestion is a
//     button the operator chooses to press;
//   • nothing here reaches the server-side send path.
// A manual "Send now" is a deliberate act. A send that quietly does not go out
// reads as a broken button and is worse than a late email.
//
// All the date logic lives in the pure, unit-tested @/lib/send-quiet-hours;
// this file is the fetch, the 30s tick, and the markup.

import { useEffect, useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { evaluateSendTime } from '@/lib/send-quiet-hours'

/**
 * Fetch a location's quiet-hours config.
 *
 * Returns `{ config, loaded }`. `config` is null until the fetch settles and
 * stays null if it fails, which normalizeQuietHours reads as "use the default
 * window" — a failed settings lookup must not mean "no quiet hours". `loaded`
 * only exists so the notice does not flash for a location that has switched
 * the feature off.
 */
export function useSendQuietHours(locationId) {
  const [config, setConfig] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!locationId) { setLoaded(true); return }
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/locations/${locationId}/send-quiet-hours`)
        const json = await res.json()
        if (!alive) return
        if (json?.success && json.data) {
          setConfig({
            enabled: json.data.enabled,
            startHour: json.data.start_hour,
            endHour: json.data.end_hour,
          })
        }
      } catch {
        // Swallow: config stays null, the code-side default applies.
      } finally {
        if (alive) setLoaded(true)
      }
    })()
    return () => { alive = false }
  }, [locationId])

  return { config, loaded }
}

/**
 * A clock that re-renders the notice as the wall clock moves, so a composer
 * left open at 20:58 starts warning at 21:00 instead of lying until reload.
 * 30s is fine: the boundary this decides is an hour edge.
 */
function useTick() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * @param {object} props
 * @param {string} props.locationId
 * @param {Date|string|number|null} [props.at]  the instant the send would go
 *        out. Omit (or pass null) for a "send now" click, which resolves to
 *        the ticking current time.
 * @param {(iso: string) => void} [props.onSuggest]  called with the next
 *        acceptable slot as an ISO instant when the operator presses the
 *        suggestion. Omit on a surface with no schedule control: the slot is
 *        then stated as text instead of offered as a button.
 * @param {string} [props.className]
 */
export default function SendQuietHoursNotice({ locationId, at = null, onSuggest, className = '' }) {
  const { config, loaded } = useSendQuietHours(locationId)
  // One clock for both modes: "send now" IS `now`, and a scheduled time still
  // needs it for the relative wording ("tonight" / "tomorrow").
  const now = useTick()

  const verdict = useMemo(
    () => evaluateSendTime({ at: at ?? now, now, config }),
    [at, now, config],
  )

  if (!loaded || !verdict.quiet) return null

  return (
    <div
      role="status"
      className={`rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 flex items-start gap-2 ${className}`}
    >
      <Clock size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0">
        <p>
          This lands at {verdict.whenLabel}, inside quiet hours for this location ({verdict.windowLabel}).
        </p>
        {onSuggest ? (
          <button
            type="button"
            onClick={() => onSuggest(verdict.nextSlotIso)}
            className="mt-1 underline underline-offset-2 font-medium hover:no-underline"
          >
            Set the send time to {verdict.nextSlotLabel} instead
          </button>
        ) : (
          <p className="mt-1">The next slot outside quiet hours is {verdict.nextSlotLabel}.</p>
        )}
        <p className="text-[11px] text-amber-700/80 mt-1">
          Nothing is blocked. This is a heads-up, not a gate.
        </p>
      </div>
    </div>
  )
}
