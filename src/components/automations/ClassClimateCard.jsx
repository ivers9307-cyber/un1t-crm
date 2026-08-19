'use client'

// CLASS-CLIMATE.1 — the dedicated card for the class-climate automation.
// Toggle + config (devices, offsets, optional include-filter) + a view of
// the synced Glofox schedule (the spine), where clicking a class EXCLUDES
// its weekly time slot (recurring). Plus two test affordances: "Run
// schedule check now" (the real climate logic on demand) and "Test AC now"
// (turn the chosen units on immediately via the existing AC route). All
// config lives in location_automations.config.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Snowflake, AlertCircle, Play, Zap, CalendarClock, X, Activity } from 'lucide-react'
import { slotKey } from '@/lib/class-climate'

const KEY = 'class_climate'

function fmtDublin(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

export default function ClassClimateCard({ locationId, glofoxConnected, devices, initialEnabled, initialConfig }) {
  const router = useRouter()
  const cfg0 = initialConfig || {}
  const [enabled, setEnabled] = useState(Boolean(initialEnabled))
  const [deviceIds, setDeviceIds] = useState(Array.isArray(cfg0.device_ids) ? cfg0.device_ids : [])
  const [offsetOn, setOffsetOn] = useState(cfg0.offset_on_min ?? 15)
  const [offsetOff, setOffsetOff] = useState(cfg0.offset_off_min ?? 5)
  const [filterText, setFilterText] = useState(Array.isArray(cfg0.class_filter) ? cfg0.class_filter.join(', ') : '')
  const [excludedSlots, setExcludedSlots] = useState(Array.isArray(cfg0.excluded_slots) ? cfg0.excluded_slots : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [run, setRun] = useState(null)
  const [schedule, setSchedule] = useState([])
  const [schedLoading, setSchedLoading] = useState(false)

  const loadSchedule = useCallback(async () => {
    if (!locationId) return
    setSchedLoading(true)
    try {
      const res = await fetch(`/api/automations/${KEY}/schedule?location_id=${encodeURIComponent(locationId)}`)
      const j = await res.json()
      if (res.ok && j.success !== false) setSchedule(j.classes || [])
    } catch { /* leave as-is */ } finally { setSchedLoading(false) }
  }, [locationId])

  useEffect(() => { loadSchedule() }, [loadSchedule])

  const [history, setHistory] = useState([])
  const [histLoading, setHistLoading] = useState(false)
  const loadHistory = useCallback(async () => {
    if (!locationId) return
    setHistLoading(true)
    try {
      const res = await fetch(`/api/automations/${KEY}/history?location_id=${encodeURIComponent(locationId)}`)
      const j = await res.json()
      if (res.ok && j.success !== false) setHistory(j.items || [])
    } catch { /* leave as-is */ } finally { setHistLoading(false) }
  }, [locationId])
  useEffect(() => { loadHistory() }, [loadHistory])

  const enabledDevices = (devices || []).filter((d) => d.enabled)
  const hasDevices = enabledDevices.length > 0
  const canEnable = glofoxConnected && hasDevices && deviceIds.length > 0

  const filters = filterText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const classMatches = (name) => filters.length === 0 || filters.some((f) => String(name || '').toLowerCase().includes(f))
  const isExcluded = (iso) => excludedSlots.includes(slotKey(iso))

  function toggleSlot(key) {
    if (!key) return
    setExcludedSlots((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]))
    setSaved(false)
  }

  function buildConfig() {
    return {
      device_ids: deviceIds,
      offset_on_min: Math.max(0, Number(offsetOn) || 0),
      offset_off_min: Math.max(0, Number(offsetOff) || 0),
      class_filter: filterText.split(',').map((s) => s.trim()).filter(Boolean),
      excluded_slots: excludedSlots,
    }
  }

  async function save(nextEnabled) {
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/automations/${KEY}`, {
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

  function toggleDevice(id) {
    setDeviceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  }

  async function runNow(dryRun) {
    setRun({ phase: 'running' }); setError(null)
    try {
      const res = await fetch(`/api/automations/${KEY}/run-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, dry_run: dryRun }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Run failed')
      setRun({ phase: 'done', ...j })
      loadSchedule(); loadHistory()
    } catch (e) { setRun({ phase: 'error', message: e.message }) }
  }

  async function testDevices() {
    if (deviceIds.length === 0) { setRun({ phase: 'error', message: 'Pick at least one AC unit first.' }); return }
    setRun({ phase: 'running' }); setError(null)
    const tests = []
    for (const id of deviceIds) {
      const label = enabledDevices.find((d) => d.id === id)?.label || id
      try {
        const res = await fetch(`/api/studio-management/ac/devices/${id}/turn-on`, { method: 'POST' })
        const j = await res.json()
        tests.push({ label, ok: res.ok && j.success !== false, error: j.error || (j.code === 'already_running' ? 'already on' : null) })
      } catch (e) { tests.push({ label, ok: false, error: e.message }) }
    }
    setRun({ phase: 'tested', tests })
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Snowflake size={16} className="text-blue-500" />
            <h2 className="font-semibold text-un1t-text">Class climate control</h2>
          </div>
          <p className="text-sm text-un1t-subtle mt-1">
            Turn the studio AC on before each Glofox class and off after — automatically, on the class schedule.
          </p>
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
            title={!enabled && !canEnable ? 'Connect Glofox + pick at least one AC unit to enable' : (enabled ? 'Turn off' : 'Turn on')}
            className={`inline-flex h-6 w-11 items-center rounded-full border transition disabled:opacity-50 disabled:cursor-not-allowed ${enabled ? 'bg-emerald-500 border-emerald-600' : 'bg-un1t-muted border-un1t-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Status warnings */}
      <div className="mt-3 text-xs space-y-1">
        {!glofoxConnected && (
          <p className="text-amber-700">Glofox isn&apos;t connected at this location — connect it in Settings → Locations → Glofox Integration to get the class schedule.</p>
        )}
        {glofoxConnected && !hasDevices && (
          <p className="text-amber-700 inline-flex items-center gap-1">
            <AlertCircle size={12} /> No AC units found here — add one in{' '}
            <Link href="/studio-management" className="underline">Studio</Link>.
          </p>
        )}
        {glofoxConnected && hasDevices && (
          <p className="text-emerald-700">Glofox connected · {enabledDevices.length} AC unit{enabledDevices.length === 1 ? '' : 's'} available ✓</p>
        )}
      </div>

      {/* Synced schedule (the spine) — click a class to exclude its weekly slot */}
      {glofoxConnected && (
        <div className="mt-4 border-t border-un1t-border/60 pt-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-semibold text-un1t-text inline-flex items-center gap-1">
              <CalendarClock size={13} /> Upcoming classes (from Glofox)
            </p>
            <button type="button" onClick={loadSchedule} className="text-[11px] underline text-un1t-subtle">
              {schedLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <p className="text-[10px] text-un1t-subtle mb-2">Click a class to exclude its weekly time slot. Times in Dublin.</p>

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

          {schedule.length === 0 && !schedLoading && (
            <p className="text-[11px] text-un1t-subtle">No classes synced yet — the schedule refreshes every 15&nbsp;min, or hit “Run schedule check now” below.</p>
          )}
          {schedule.length > 0 && (
            <ul className="space-y-0.5 max-h-64 overflow-y-auto pr-1">
              {schedule.map((c) => {
                const excluded = isExcluded(c.starts_at)
                const willRun = !excluded && classMatches(c.name)
                const cls = excluded
                  ? 'line-through opacity-50'
                  : willRun ? 'bg-blue-500/5' : 'opacity-40'
                return (
                  <li key={c.glofox_event_id}>
                    <button type="button" onClick={() => toggleSlot(slotKey(c.starts_at))}
                      title={excluded ? 'Excluded — click to include again' : 'Click to exclude this weekly time slot'}
                      className={`flex w-full items-center gap-3 text-[11px] rounded px-2 py-1 text-left hover:bg-un1t-border/30 ${cls}`}>
                      <span className="text-un1t-subtle tabular-nums shrink-0 w-36">{fmtDublin(c.starts_at)}</span>
                      <span className="text-un1t-text truncate flex-1">{c.name || 'Class'}</span>
                      {excluded
                        ? <span className="text-amber-700 shrink-0">excluded</span>
                        : (typeof c.capacity === 'number' && <span className="text-un1t-subtle shrink-0">cap {c.capacity}</span>)}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="mt-1.5 text-[10px] text-un1t-subtle">
            {filters.length ? 'Highlighted = will run.' : 'Runs for every class'} {excludedSlots.length ? `· ${excludedSlots.length} slot${excludedSlots.length === 1 ? '' : 's'} excluded` : ''} · changes apply on Save below.
          </p>
        </div>
      )}

      {/* Config */}
      {hasDevices && (
        <div className="mt-4 border-t border-un1t-border/60 pt-3 space-y-3">
          <div>
            <p className="text-xs font-semibold text-un1t-text mb-1.5">Which AC unit(s) to control</p>
            <div className="flex flex-wrap gap-2">
              {enabledDevices.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDevice(d.id)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${deviceIds.includes(d.id) ? 'bg-blue-500/10 border-blue-500/40 text-blue-700' : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-un1t-subtle">
              On (min before)
              <input type="number" min="0" value={offsetOn} onChange={(e) => setOffsetOn(e.target.value)}
                className="ml-2 w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
            </label>
            <label className="text-xs text-un1t-subtle">
              Off (min after)
              <input type="number" min="0" value={offsetOff} onChange={(e) => setOffsetOff(e.target.value)}
                className="ml-2 w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
            </label>
          </div>

          <div>
            <label className="text-xs text-un1t-subtle block">
              Only these classes (optional, comma-separated — leave blank for all)
              <input type="text" value={filterText} onChange={(e) => setFilterText(e.target.value)}
                placeholder="e.g. DR1VE, TEMPO"
                className="mt-1 w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => save(enabled)} disabled={busy}
              className="text-xs font-semibold px-3 py-1.5 rounded bg-un1t-text text-un1t-bg disabled:opacity-40">
              {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Save settings'}
            </button>
            {saved && <span className="text-[11px] text-emerald-700">Saved ✓</span>}
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}

      {/* Test affordances */}
      {hasDevices && (
        <div className="mt-3 border-t border-un1t-border/60 pt-3">
          <p className="text-[11px] text-un1t-subtle mb-2">Try it without waiting for a class:</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => runNow(false)} disabled={run?.phase === 'running' || deviceIds.length === 0}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
              <Play size={12} /> Run schedule check now
            </button>
            <button type="button" onClick={testDevices} disabled={run?.phase === 'running' || deviceIds.length === 0}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
              <Zap size={12} /> Test AC now
            </button>
            <button type="button" onClick={() => runNow(true)} disabled={run?.phase === 'running' || deviceIds.length === 0}
              className="text-[11px] underline text-un1t-subtle">
              Preview only
            </button>
          </div>

          {run?.phase === 'running' && (
            <p className="mt-2 text-[11px] text-un1t-subtle inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Working…</p>
          )}
          {run?.phase === 'error' && <p className="mt-2 text-[11px] text-red-700">{run.message}</p>}
          {run?.phase === 'tested' && (
            <div className="mt-2 text-[11px] space-y-0.5">
              {run.tests.map((t, i) => (
                <p key={i} className={t.ok ? 'text-emerald-700' : 'text-amber-700'}>
                  {t.ok ? '✓' : '✗'} {t.label}{t.error ? ` — ${t.error}` : ' — on'}
                </p>
              ))}
            </div>
          )}
          {run?.phase === 'done' && (
            <div className="mt-2 text-[11px] space-y-0.5">
              {!run.glofox_configured && <p className="text-amber-700">Glofox isn&apos;t connected — no schedule to check.</p>}
              {run.glofox_configured && (run.planned?.length || 0) === 0 && (
                <p className="text-un1t-subtle">No class is within its lead window right now — nothing to turn on yet.</p>
              )}
              {(run.actions || []).map((a, i) => (
                <p key={i} className={a.status === 'fired' ? 'text-emerald-700' : a.status === 'failed' ? 'text-red-700' : 'text-un1t-subtle'}>
                  {a.status === 'fired' ? '✓ turned on' : a.status === 'skipped' ? '· already on' : a.status === 'would_fire' ? '→ would turn on' : `✗ ${a.status}`}
                  {' '}for {a.class_name || a.glofox_event_id}{a.error ? ` — ${a.error}` : ''}
                </p>
              ))}
              {(run.errors || []).map((e, i) => <p key={`e${i}`} className="text-amber-700">{e}</p>)}
            </div>
          )}
        </div>
      )}

      {/* Recent activity — what the cron actually did (autonomous + on-demand) */}
      <div className="mt-3 border-t border-un1t-border/60 pt-3">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-un1t-text inline-flex items-center gap-1">
            <Activity size={13} /> Recent activity
          </p>
          <button type="button" onClick={loadHistory} className="text-[11px] underline text-un1t-subtle">
            {histLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {history.length === 0 && (
          <p className="text-[11px] text-un1t-subtle">
            Nothing yet — the automation hasn&apos;t run for a class so far. Each time it turns the AC on (or skips / fails) for a class, it shows here.
          </p>
        )}
        {history.length > 0 && (
          <ul className="space-y-0.5 max-h-56 overflow-y-auto pr-1">
            {history.map((h, i) => (
              <li key={i} className="flex items-center gap-2 text-[11px]">
                <span className="text-un1t-subtle tabular-nums shrink-0 w-36">{fmtDublin(h.fired_at)}</span>
                <span className={`shrink-0 font-medium ${h.status === 'fired' ? 'text-emerald-700' : h.status === 'failed' ? 'text-red-700' : 'text-un1t-subtle'}`}>
                  {h.status === 'fired' ? '✓ on' : h.status === 'failed' ? '✗ failed' : '· skipped'}
                </span>
                <span className="text-un1t-text truncate flex-1">
                  {h.class_name || h.glofox_event_id}{h.device_label ? ` · ${h.device_label}` : ''}
                  {h.status === 'failed' && h.error ? ` — ${h.error}` : ''}
                  {h.status === 'skipped' && h.reason ? ` — ${String(h.reason).replace(/_/g, ' ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
