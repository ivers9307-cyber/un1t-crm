'use client'

// SCREENMODE.12 — the "Class screens" card on the automations hub. Toggle +
// config for the Hatch floor screens: which screens follow the class
// timetable, the class app's Android package, lead-in/out minutes, an optional
// class filter, and "Today's plan" — the merged windows the screens will show
// the class app, computed here from the synced timetable with the SAME planner
// the server uses. Clicking a class excludes its weekly slot (the class
// climate card's pattern). Unlike the climate cards it renders OUTSIDE the
// membership-source gate (un1t.online declares no schedule capability, yet is
// where the timetable comes from), so it gates itself on the data the page
// reads: screens exist, and a timetable is being synced.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Monitor, CalendarClock, X } from 'lucide-react'
import { Field } from '@/components/ui'
import { slotKey } from '@/lib/class-climate'
import { zoneCity } from '@/lib/record-time'
import { useViewerZone } from '@/lib/use-viewer-zone'
import {
  SCREEN_MODE_KEY,
  DEFAULT_SCREEN_CONFIG,
  PACKAGE_NAME_RE,
  resolveScreenConfig,
  planScreenWindows,
} from '@/lib/screen-mode'
import { AUTOMATIONS } from '@/lib/automations/registry'
import { fmtClassTime } from './ClassClimateCard'

const DESCRIPTION = AUTOMATIONS.find((a) => a.key === SCREEN_MODE_KEY)?.description || ''

export default function ScreenModeCard({ locationId, timezone, screens, hasTimetable, initialEnabled, initialConfig }) {
  const viewerZone = useViewerZone()
  const router = useRouter()
  const cfg0 = initialConfig || {}
  const [enabled, setEnabled] = useState(Boolean(initialEnabled))
  const [deviceNames, setDeviceNames] = useState(Array.isArray(cfg0.device_names) ? cfg0.device_names : [])
  const [pkg, setPkg] = useState(typeof cfg0.class_app_package === 'string' ? cfg0.class_app_package : '')
  const [leadIn, setLeadIn] = useState(cfg0.lead_in_min ?? DEFAULT_SCREEN_CONFIG.lead_in_min)
  const [leadOut, setLeadOut] = useState(cfg0.lead_out_min ?? DEFAULT_SCREEN_CONFIG.lead_out_min)
  const [filterText, setFilterText] = useState(Array.isArray(cfg0.class_filter) ? cfg0.class_filter.join(', ') : '')
  const [excludedSlots, setExcludedSlots] = useState(Array.isArray(cfg0.excluded_slots) ? cfg0.excluded_slots : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [classes, setClasses] = useState([])
  const [schedLoading, setSchedLoading] = useState(false)
  const [schedError, setSchedError] = useState(false)

  const loadSchedule = useCallback(async () => {
    if (!locationId || !hasTimetable) return
    setSchedLoading(true); setSchedError(false)
    try {
      const res = await fetch(`/api/automations/${SCREEN_MODE_KEY}/schedule?location_id=${encodeURIComponent(locationId)}`)
      const j = await res.json()
      if (res.ok && j.success !== false) setClasses(j.classes || [])
      else setSchedError(true)
    } catch { setSchedError(true) } finally { setSchedLoading(false) }
  }, [locationId, hasTimetable])

  useEffect(() => { loadSchedule() }, [loadSchedule])

  const trimmedPkg = pkg.trim()
  const pkgValid = PACKAGE_NAME_RE.test(trimmedPkg)
  const pkgError = trimmedPkg && !pkgValid ? 'Not a valid Android package name (for example com.example.classapp).' : null
  const canEnable = hasTimetable && pkgValid && deviceNames.length > 0
  const whyNot = !hasTimetable
    ? 'No class timetable is being synced for this studio'
    : !pkgValid
      ? 'Enter the class app package name to enable'
      : deviceNames.length === 0
        ? 'Pick at least one screen to enable'
        : ''

  function buildConfig() {
    return {
      device_names: deviceNames,
      class_app_package: trimmedPkg || null,
      lead_in_min: Math.max(0, Number(leadIn) || 0),
      lead_out_min: Math.max(0, Number(leadOut) || 0),
      class_filter: filterText.split(',').map((s) => s.trim()).filter(Boolean),
      excluded_slots: excludedSlots,
    }
  }

  // The preview runs the saved config shape through the same resolver the
  // server applies, so what is shown cannot drift from what is saved.
  const windows = hasTimetable
    ? planScreenWindows({ occurrences: classes, config: resolveScreenConfig(buildConfig()), zone: timezone })
    : []

  function toggleSlot(key) {
    if (!key) return
    setExcludedSlots((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]))
    setSaved(false)
  }

  function toggleScreen(name) {
    setDeviceNames((names) => (names.includes(name) ? names.filter((x) => x !== name) : [...names, name]))
    setSaved(false)
  }

  async function save(nextEnabled) {
    // A card that is on must stay enableable: refuse rather than persist
    // enabled:true with no package, no screen or no timetable behind it.
    if (nextEnabled && !canEnable) { setError(whyNot); setSaved(false); return }
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/automations/${SCREEN_MODE_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, enabled: nextEnabled, config: buildConfig() }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Save failed')
      setEnabled(nextEnabled); setSaved(true)
      router.refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-blue-500" />
            <h2 className="font-semibold text-un1t-text">Class screens</h2>
          </div>
          <p className="text-sm text-un1t-subtle mt-1">{DESCRIPTION}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-semibold ${enabled ? 'text-emerald-700' : 'text-un1t-subtle'}`}>
            {enabled ? 'On' : 'Off'}
          </span>
          <button
            type="button"
            onClick={() => save(!enabled)}
            disabled={busy || (!enabled && !canEnable)}
            aria-pressed={enabled}
            aria-label={enabled ? 'Turn automation off' : 'Turn automation on'}
            title={!enabled && !canEnable ? whyNot : (enabled ? 'Turn off' : 'Turn on')}
            className={`inline-flex h-6 w-11 items-center rounded-full border transition disabled:opacity-50 disabled:cursor-not-allowed ${enabled ? 'bg-emerald-500 border-emerald-600' : 'bg-un1t-muted border-un1t-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Config */}
      <div className="mt-4 border-t border-un1t-border/60 pt-3 space-y-3">
        <fieldset>
          <legend className="text-xs font-semibold text-un1t-text mb-1.5">Which screens follow the timetable</legend>
          <div className="flex flex-wrap gap-2">
            {screens.map((s) => {
              const on = deviceNames.includes(s.device_name)
              return (
                <label
                  key={s.device_name}
                  className={`inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full border cursor-pointer transition ${on ? 'bg-blue-500/10 border-blue-500/40 text-blue-700' : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'}`}
                >
                  <input type="checkbox" checked={on} onChange={() => toggleScreen(s.device_name)} />
                  {s.label || s.device_name}
                </label>
              )
            })}
          </div>
        </fieldset>

        <Field
          id="screen-mode-package"
          label="Class app package"
          hint="The Android package name of the class app on the screens, for example com.example.classapp."
          error={pkgError || undefined}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              value={pkg}
              onChange={(e) => { setPkg(e.target.value); setSaved(false) }}
              placeholder="com.example.classapp"
              className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
            />
          )}
        </Field>

        <div className="flex flex-wrap gap-4">
          <label className="text-xs text-un1t-subtle">
            Show class app (min before)
            <input type="number" min="0" value={leadIn} onChange={(e) => { setLeadIn(e.target.value); setSaved(false) }}
              className="ml-2 w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
          </label>
          <label className="text-xs text-un1t-subtle">
            Keep it (min after)
            <input type="number" min="0" value={leadOut} onChange={(e) => { setLeadOut(e.target.value); setSaved(false) }}
              className="ml-2 w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
          </label>
        </div>

        <label className="text-xs text-un1t-subtle block">
          Only these classes (optional, comma-separated — leave blank for all)
          <input type="text" value={filterText} onChange={(e) => { setFilterText(e.target.value); setSaved(false) }}
            placeholder="e.g. Strength, Conditioning"
            className="mt-1 w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
        </label>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => save(enabled)} disabled={busy}
            className="text-xs font-semibold px-3 py-1.5 rounded bg-un1t-text text-un1t-bg disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Save settings'}
          </button>
          {saved && <span className="text-[11px] text-emerald-700">Saved ✓</span>}
        </div>
      </div>

      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}

      {/* Today's plan — the merged windows the screens show the class app */}
      <div className="mt-4 border-t border-un1t-border/60 pt-3">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-un1t-text inline-flex items-center gap-1">
            <CalendarClock size={13} /> Today&apos;s plan
          </p>
          {hasTimetable && (
            <button type="button" onClick={loadSchedule} className="text-[11px] underline text-un1t-subtle">
              {schedLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>

        {!hasTimetable ? (
          <p className="text-[11px] text-un1t-subtle">No class timetable is being synced for this studio.</p>
        ) : (
          <>
            <p className="text-[10px] text-un1t-subtle mb-2">
              The class app shows on the screens in these windows, marketing content the rest of the time. Click a class to exclude its weekly time slot. Times in {zoneCity(timezone)}.
            </p>

            {excludedSlots.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {excludedSlots.map((s) => (
                  <button key={s} type="button" onClick={() => toggleSlot(s)}
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 text-amber-700">
                    {s} <X size={11} />
                  </button>
                ))}
              </div>
            )}

            {schedError && (
              <p className="text-[11px] text-amber-700">Couldn&apos;t load the schedule. Reload to try again.</p>
            )}
            {windows.length === 0 && !schedLoading && !schedError && (
              <p className="text-[11px] text-un1t-subtle">No class windows in the synced schedule.</p>
            )}
            {windows.length > 0 && (
              <ul className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {windows.map((w) => (
                  <li key={w.from} data-testid="plan-window" className="rounded bg-blue-500/5 px-2 py-1">
                    <p className="text-[11px] text-un1t-text tabular-nums">
                      {fmtClassTime(w.from, timezone, viewerZone)} → {fmtClassTime(w.until, timezone, viewerZone)}
                    </p>
                    <div className="flex flex-wrap gap-x-2">
                      {w.classes.map((c) => (
                        <button key={c.id} type="button" onClick={() => toggleSlot(slotKey(c.starts_at, timezone))}
                          title="Click to exclude this weekly time slot"
                          className="text-[11px] text-un1t-subtle hover:text-un1t-text underline-offset-2 hover:underline">
                          {c.name || 'Class'}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[10px] text-un1t-subtle">Changes apply on Save above.</p>
          </>
        )}
      </div>
    </div>
  )
}
