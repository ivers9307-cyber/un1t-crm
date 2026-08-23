// SHELLY-UI.1 — the recurring on/off window editor, lifted out of
// SonosScheduleClient.jsx so the Shelly smart-plug surface edits a window
// with the same control, not a second one that looks like it.
//
// Markup and classes are the Sonos originals unchanged — this is a move,
// not a redesign. What was Sonos-specific went out through props:
//   • the per-window volume + favourite controls  → renderExtra
//   • their read-only text                        → summaryExtra
//   • "Save a favourite in the Sonos app first"   → addDisabled/Title
// so Shelly (which has neither) simply passes none of them.
//
// CONTROLLED, not stateful: the parent owns `windows` and every edit comes
// back through one `onChange(nextWindows)`. Callers pair the save-state
// reset with it (Sonos clears its "Saved ✓" flag there) — an editor that
// held its own copy would have to be told when the server list changed, and
// would eventually disagree with what the parent is about to PATCH.
//
// onChange IS SNAPSHOT-BASED: each next list is computed from the `windows`
// prop as of the render the event fired on, not from a functional updater.
// So a caller must NOT wrap the state update in startTransition (or
// otherwise defer it) — two edits landing before the deferred render
// commits would both build on the same stale snapshot and the first would
// be lost. Update state synchronously in the handler, as Sonos does.
//
// The overlap and same-boundary rules are NOT enforced here. They live in
// src/lib/schedule/windows.js and are applied by the API on save, so the
// answer an operator gets is the one the engine will actually act on — a
// client-side copy is a second implementation that can only drift.

'use client'

import { Plus, X } from 'lucide-react'
import { DAY_LABELS, BASE_WINDOW } from '@/lib/schedule/windows'

/**
 * @param {object}   props
 * @param {Array}    props.windows      current windows (controlled)
 * @param {Function} props.onChange     (nextWindows) => void — every edit
 * @param {boolean}  props.editable     false renders the read-only summary
 * @param {number}   props.max          required: this caller's cap, so it
 *   states the number its own API enforces rather than inheriting a default
 *   that could silently disagree (Sonos passes MAX_WINDOWS = 16)
 * @param {object|Function} [props.defaultWindowExtra] a PATCH merged over
 *   BASE_WINDOW when Add appends — device-specific fields only, so a caller
 *   with none (Shelly) passes nothing. A function is called at click time:
 *   Sonos needs the first favourite's id, which only exists once the
 *   household has loaded.
 * @param {Function} [props.renderExtra]  (win, i, setField) => JSX — extra
 *   controls in the same row as On/Off, before Remove. `setField` is
 *   (index, field, value), the same signature the On/Off inputs use.
 * @param {Function} [props.summaryExtra] (win) => JSX — appended to the
 *   read-only line after the times
 * @param {boolean}  [props.addDisabled]      disables Add (a precondition is unmet)
 * @param {string}   [props.addDisabledTitle] why — shown as the button's title
 */
export default function WindowsEditor({
  windows,
  onChange,
  editable,
  max,
  defaultWindowExtra,
  renderExtra,
  summaryExtra,
  addDisabled = false,
  addDisabledTitle,
}) {
  const list = Array.isArray(windows) ? windows : []

  function addWindow() {
    // defence in depth; unreachable via the DOM (the Add button is gated on
    // the same condition)
    if (list.length >= max || addDisabled) return
    const extra = typeof defaultWindowExtra === 'function' ? defaultWindowExtra() : defaultWindowExtra
    onChange([...list, { ...BASE_WINDOW, ...extra }])
  }
  function removeWindow(i) {
    onChange(list.filter((_, idx) => idx !== i))
  }
  function toggleDay(i, dayN) {
    onChange(list.map((win, idx) => {
      if (idx !== i) return win
      const current = Array.isArray(win.days) ? win.days : []
      const days = current.includes(dayN) ? current.filter((d) => d !== dayN) : [...current, dayN].sort((a, b) => a - b)
      return { ...win, days }
    }))
  }
  function setWindowField(i, field, value) {
    onChange(list.map((win, idx) => (idx === i ? { ...win, [field]: value } : win)))
  }

  return (
    <div className="mt-3 border-t border-un1t-border/60 pt-3 space-y-2">
      <p className="text-xs font-semibold text-un1t-text">Windows</p>
      {list.length === 0 && (
        <p className="text-[11px] text-un1t-subtle">No windows yet{editable ? ' — add one below.' : '.'}</p>
      )}
      {/* Index keys are deliberate: a window has no id, and every input's
          value derives from win.* rather than from internal state, so a
          remount after a reorder or removal cannot leave a stale value on
          screen — React re-reads all of it from the row it renders. */}
      {editable ? list.map((win, i) => {
        const days = Array.isArray(win.days) ? win.days : []
        return (
          <div key={i} className="rounded border border-un1t-border/60 p-2 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((d) => {
                const on = days.includes(d.n)
                return (
                  <button key={d.n} type="button" aria-pressed={on} onClick={() => toggleDay(i, d.n)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border transition ${on ? 'bg-blue-500/10 border-blue-500/40 text-blue-700' : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'}`}>
                    {d.label}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                On
                <input type="time" value={win.on} onChange={(e) => setWindowField(i, 'on', e.target.value)}
                  className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
              </label>
              <label className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                Off
                <input type="time" value={win.off} onChange={(e) => setWindowField(i, 'off', e.target.value)}
                  className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
              </label>
              {renderExtra ? renderExtra(win, i, setWindowField) : null}
              <button type="button" onClick={() => removeWindow(i)}
                className="ml-auto text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1">
                <X size={12} /> Remove
              </button>
            </div>
          </div>
        )
      }) : list.map((win, i) => {
        const days = Array.isArray(win.days) ? win.days : []
        return (
          // Read-only. Sonos reaches this when its household is unreachable,
          // which is exactly when there are no live favourites to resolve an
          // id to a name — hence a plain restatement of what is stored rather
          // than a "(not found)" label this data could not support.
          <div key={i} className="rounded border border-un1t-border/60 p-2 text-[11px] text-un1t-subtle">
            {DAY_LABELS.filter((d) => days.includes(d.n)).map((d) => d.label).join(', ') || 'No days'}
            {' · '}{win.on}–{win.off}{summaryExtra ? summaryExtra(win) : null}
          </div>
        )
      })}
      {editable && list.length < max && (
        <button type="button" onClick={addWindow} disabled={addDisabled}
          title={addDisabled ? addDisabledTitle : undefined}
          className="text-[11px] underline text-un1t-subtle inline-flex items-center gap-1 disabled:opacity-40 disabled:no-underline">
          <Plus size={12} /> Add window
        </button>
      )}
    </div>
  )
}
