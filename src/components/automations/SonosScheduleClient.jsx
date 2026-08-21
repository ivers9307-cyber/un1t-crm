// SONOS.13 — the studio-music operator surface. Talks to the routes under
// src/app/api/sonos/** (read their doc comments before touching this file —
// the response shapes here are matched exactly, not guessed):
//   GET  /api/sonos/household            → connection + live players/favourites
//   GET  /api/sonos/schedules            → this location's schedules
//   POST /api/sonos/schedules            → create
//   PATCH/DELETE /api/sonos/schedules/[id]
//   POST /api/sonos/schedules/[id]/run-now
//
// Visual style mirrors ClassClimateCard/BathroomClimateCard (the closest
// "operator-facing automation config card" siblings) and the CRUD shape
// mirrors TapoDevicesClient (a list of independently-editable entities, not
// a single PUT-a-config-blob card) — sonos_schedules is a list resource
// (mig-backed, POST creates, PATCH/DELETE address one row by id), so a
// studio can run more than one named schedule (e.g. "Weekday classes" and
// "Weekend chill") each with its own speakers and windows.
//
// The OAuth connect/callback dance lives entirely in src/app/api/sonos/
// connect + callback — this file only ever LINKS to /api/sonos/connect
// (a real browser navigation: it 302s to Sonos, so it must be an <a>, never
// a fetch()) and reads the `?sonos=` status callback.js redirects back with.

'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, AlertCircle, Music2, ExternalLink, Play, Plus, X, Trash2 } from 'lucide-react'
import { dublinDateKey, dublinDayStartMs, dublinAddDays, dublinDayStr } from '@/lib/dublin-time'
import SonosLiveControl from './SonosLiveControl'
// Pure, no I/O — the exact function planAction (src/lib/sonos/groups.js) calls
// via resolveServeWindows to decide whether a window is open right now. Reused
// here (not re-implemented) so the health indicator below can never compute a
// different answer to "is a window active?" than the cron itself does.
import { resolveServeWindows } from '@/lib/schedule/desired-state'

const DAY_LABELS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 7, label: 'Sun' },
]

const MAX_WINDOWS = 16 // mirrors SchedulePayload's windows.max(16) in the API
const DEFAULT_VOLUME = 30

function fmtDublin(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

// True while a suppression override is in force. Pulled out so both the
// health indicator below and ScheduleOverride's own "live" check read the
// identical condition — duplicating it inline twice is how the two would
// eventually drift (one gets a grace period added, the other doesn't).
// Mirrors planAction's own check exactly (src/lib/sonos/groups.js).
function isOverrideLive(override, nowMs) {
  return Boolean(override?.state === 'off' && override.until && new Date(override.until).getTime() > nowMs)
}

// Health indicator — mirrors the Homey device page's staleness dots
// (recovered from the deleted TapoDevicesClient.jsx's stateDot()). Tapo's
// fixed 5min/30min-since-last-seen thresholds do NOT transfer here: a Tapo
// device is polled continuously, so silence itself is the fault. This cron
// applies a window's open action exactly ONCE when it opens and its close
// exactly ONCE when it closes (planAction, src/lib/sonos/groups.js) and
// deliberately does nothing in between — so on a perfectly healthy schedule
// `last_state.at` can sit hours old (a window that closed last night has
// nothing to report until its next open). A fixed age threshold would cry
// wolf every single morning, which is the opposite of what this is for.
//
// So this asks a narrower question than "is last_state.at recent?" — it
// asks "is NOW inside a window that should already have been opened?",
// reusing resolveServeWindows (the reconcile's own window resolver) fed the
// same device-shaped object planAction builds, so it can never disagree
// with the cron about which window is active.
//   - Inside an active window, `last_state.at` (NOT `last_applied.at` —
//     run-now clears last_applied but leaves last_state alone, so
//     last_applied alone reads "never applied" right after a legitimate
//     recovery click) should be at/after the window's start, allowing a
//     little grace for the per-minute cron's own tick lag. If it isn't,
//     the open is either about to land or stuck.
//   - Outside any window — including because the schedule is off, or an
//     override is suppressing it — going quiet is the NORMAL state. There
//     is no "should have acted" fact to check there, so the indicator only
//     ever reports what IS known (when it last acted), never a liveness
//     guarantee the data can't back up.
const HEALTH_GRACE_MS = 3 * 60_000
// ^ a couple of missed per-minute cron ticks (a redeploy, a slow tick) —
// not evidence of anything wrong yet.
const HEALTH_OVERDUE_MS = 10 * 60_000
// ^ past this, "the cron just hasn't ticked" stops being a plausible
// explanation and it's worth telling the operator to go look.

const HEALTH_TONE_CLASSES = {
  green: { chip: 'bg-emerald-500/10 text-emerald-700', dot: 'bg-emerald-500' },
  amber: { chip: 'bg-amber-500/10 text-amber-700', dot: 'bg-amber-500' },
  red: { chip: 'bg-red-500/10 text-red-700', dot: 'bg-red-500' },
  grey: { chip: 'bg-un1t-muted/10 text-un1t-subtle', dot: 'bg-un1t-muted' },
}

function scheduleHealth(schedule, nowMs) {
  const lastAtIso = schedule.last_state?.at || null
  const lastAtMs = lastAtIso ? Date.parse(lastAtIso) : NaN
  const hasLastAt = Number.isFinite(lastAtMs)
  const playbackSuffix = schedule.last_state?.playback_state
    ? ` (Sonos reports ${schedule.last_state.playback_state})` : ''

  const overridden = isOverrideLive(schedule.override, nowMs)
  const dateStr = dublinDayStr(nowMs)
  const windows = resolveServeWindows(
    { enabled: true, schedule_mode: 'fixed', fixed_windows: Array.isArray(schedule.windows) ? schedule.windows : [] },
    dateStr,
  )
  // Only look for an active window when the schedule could actually be
  // acting on one — disabled or overridden, the cron does nothing, so
  // there is nothing to be "overdue" about.
  const active = (schedule.enabled && !overridden)
    ? windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)
    : null

  if (active) {
    if (hasLastAt && lastAtMs >= active.on_at - HEALTH_GRACE_MS) {
      return { tone: 'green', label: 'Playing', detail: `Last acted ${fmtDublin(lastAtIso)}${playbackSuffix}.` }
    }
    if (nowMs - active.on_at > HEALTH_OVERDUE_MS) {
      return {
        tone: 'red',
        label: 'Should be playing — not applied',
        detail: `This window opened at ${fmtDublin(active.on_at)} and nothing has been recorded since. Check the sonos-reconcile cron and the Sonos connection.`,
      }
    }
    return {
      tone: 'amber',
      label: 'Window just opened',
      detail: `Opened at ${fmtDublin(active.on_at)} — waiting for the per-minute cron to apply it.`,
    }
  }

  if (overridden) {
    return {
      tone: 'grey',
      label: 'Overridden',
      detail: `Deliberately left alone until ${fmtDublin(schedule.override.until)} — see Override above.`,
    }
  }

  if (!hasLastAt) return { tone: 'grey', label: 'Not applied yet', detail: null }

  return {
    tone: 'grey',
    label: `Last acted ${fmtDublin(lastAtIso)}`,
    detail: `No window is open right now, so this only shows when the schedule last did something — it doesn't prove the cron is still running.${playbackSuffix}`,
  }
}

// "Leave the music alone until midnight [tonight]" — the design spec's own
// suggested preset. Always the NEXT Europe/Dublin local midnight, computed
// via the shared Dublin-time helpers — never hand-roll this with local
// Date math (see src/lib/dublin-time.js and the CLAUDE.md timezone
// invariant: never mix local-time Date parsing with toISOString()
// formatting). dublinDateKey(now) is always the calendar day containing
// `now`, so dublinDayStartMs(tomorrow) is always strictly after `now` —
// including when it's already past midnight, "tonight" means the coming one.
function untilMidnightTonightIso() {
  const todayKey = dublinDateKey(Date.now())
  const tomorrowKey = dublinAddDays(todayKey, 1)
  return new Date(dublinDayStartMs(tomorrowKey)).toISOString()
}

// The shorter presets are plain durations from now — no Dublin wall clock
// involved, so no DST handling needed.
function hoursFromNowIso(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString()
}

// Every value src/app/api/sonos/callback/route.js can redirect back with,
// verified against that file directly (not assumed): denied, bad_callback,
// not_configured (x2 — dormant/misconfigured and CRON_SECRET unset),
// bad_state, state_expired, exchange_failed, no_household, pick_household
// (handled separately below — it needs an interactive picker, not a
// banner), bad_household, household_taken (x2 — pre-check and the 23505
// race), save_failed (x2 — clash lookup and the final upsert), connected.
const CALLBACK_MESSAGES = {
  connected: {
    tone: 'success',
    text: 'Sonos connected. Set up a schedule below.',
  },
  denied: {
    tone: 'warning',
    text: 'The Sonos connection was cancelled on the Sonos side — nothing changed here.',
  },
  bad_callback: {
    tone: 'error',
    text: 'That connection link was incomplete. Try connecting again below.',
  },
  not_configured: {
    tone: 'info',
    text: "Sonos isn't configured on this deploy yet, so there was nothing to connect.",
  },
  bad_state: {
    tone: 'error',
    text: "That connection link wasn't valid (it may be stale). Try connecting again below.",
  },
  state_expired: {
    tone: 'warning',
    text: 'That connection attempt took too long and expired — links are only valid for 10 minutes. Try connecting again below.',
  },
  exchange_failed: {
    tone: 'error',
    text: "Sonos didn't accept that connection attempt. Try again below.",
  },
  no_household: {
    tone: 'error',
    text: 'That Sonos account has no households set up. Add speakers to it in the Sonos app, then try connecting again.',
  },
  bad_household: {
    tone: 'error',
    text: "The Sonos household you picked isn't available on that account any more. Try connecting again below.",
  },
  household_taken: {
    tone: 'error',
    text: "That Sonos household is already connected to another location on this account. There's no way to disconnect it from in here yet — an engineer will need to free it up in the database before this location can link it.",
  },
  save_failed: {
    tone: 'error',
    text: 'Saving the Sonos connection failed. Try again below, and let an engineer know if it keeps happening.',
  },
}

function toneClasses(tone) {
  if (tone === 'success') return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700'
  if (tone === 'warning') return 'bg-amber-500/10 border-amber-500/30 text-amber-700'
  if (tone === 'error') return 'bg-red-500/10 border-red-500/30 text-red-700'
  return 'bg-un1t-surface border-un1t-border text-un1t-subtle' // info
}

// useSearchParams wants dynamic rendering; the Suspense boundary lets
// Next.js skip prerender at build time (same pattern as src/app/login/page.js).
export default function SonosScheduleClient({ locationName }) {
  return (
    <Suspense fallback={<p className="text-sm text-un1t-subtle">Loading…</p>}>
      <SonosScheduleInner locationName={locationName} />
    </Suspense>
  )
}

function SonosScheduleInner({ locationName }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Captured once on mount (lazy initializer), then the URL is stripped so a
  // refresh or back-navigation doesn't replay a stale banner.
  const [callback] = useState(() => ({
    status: searchParams.get('sonos'),
    ids: (searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean),
  }))
  useEffect(() => {
    if (callback.status) router.replace('/automations/sonos', { scroll: false })
  }, [callback.status, router])

  const [household, setHousehold] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const loadHousehold = useCallback(async () => {
    try {
      const res = await fetch('/api/sonos/household')
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Failed to load Sonos status')
      setHousehold(j)
      setLoadError(null)
    } catch (e) {
      setLoadError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadHousehold() }, [loadHousehold])

  // `connected` gates the schedule LIST — it's our own DB, unaffected by
  // whether Sonos itself is answering right now. `canEditSchedules` additionally
  // requires `reachable` and gates EDITING — new windows, speaker picks and
  // favourites all need live Sonos data. An unreachable cloud must not hide the
  // existing schedules and their health state; it should only disable changing
  // them (see SchedulesSection's `canEdit` prop).
  const connected = Boolean(household?.connected)
  const canEditSchedules = Boolean(connected && household?.reachable)

  const [schedules, setSchedules] = useState([])
  const [schedLoading, setSchedLoading] = useState(false)
  const [schedError, setSchedError] = useState(null)

  const loadSchedules = useCallback(async () => {
    setSchedLoading(true)
    try {
      const res = await fetch('/api/sonos/schedules')
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Failed to load schedules')
      setSchedules(j.schedules || [])
      setSchedError(null)
    } catch (e) {
      setSchedError(e.message)
    } finally {
      setSchedLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) loadSchedules()
  }, [connected, loadSchedules])

  // Mirrors the per-minute reconcile cron so last_applied/last_state on
  // screen don't need a manual refresh to catch up. Keyed on `connected`,
  // not `canEditSchedules` — the health state is our own DB and stays worth
  // refreshing even while Sonos itself is unreachable.
  useEffect(() => {
    if (!connected) return undefined
    const t = setInterval(loadSchedules, 60_000)
    return () => clearInterval(t)
  }, [connected, loadSchedules])

  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)

  async function addSchedule() {
    setAdding(true); setAddError(null)
    try {
      const res = await fetch('/api/sonos/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New schedule', enabled: false, player_ids: [], windows: [] }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Could not create a schedule')
      await loadSchedules()
    } catch (e) {
      setAddError(e.message)
    } finally {
      setAdding(false)
    }
  }

  const msg = callback.status && callback.status !== 'pick_household' ? CALLBACK_MESSAGES[callback.status] : null
  // pick_household needs its own interactive panel (below), not a plain
  // banner — and showing the generic "Connect Sonos" retry underneath it
  // would invite restarting the whole OAuth round trip instead of using the
  // fresh-code re-pick link that panel already offers.
  const showGenericNotConnected = callback.status !== 'pick_household'

  return (
    <div className="space-y-4">
      {msg && (
        <div className={`rounded-lg border p-3 text-sm ${toneClasses(msg.tone)}`}>
          {msg.text}
        </div>
      )}

      {callback.status === 'pick_household' && callback.ids.length > 0 && (
        <HouseholdPicker ids={callback.ids} locationName={locationName} />
      )}

      {loading && (
        <p className="text-sm text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading Sonos status…
        </p>
      )}

      {!loading && loadError && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-sm text-red-700">{loadError}</p>
          <button type="button" onClick={loadHousehold}
            className="mt-2 text-xs font-semibold underline text-un1t-subtle">
            Try again
          </button>
        </div>
      )}

      {!loading && !loadError && household && !household.connected && showGenericNotConnected && (
        <NotConnectedPanel reason={household.reason} />
      )}

      {!loading && !loadError && household?.connected && !household.reachable && (
        <UnreachableNotice statusCode={household.statusCode} />
      )}

      {!loading && !loadError && connected && (
        <SchedulesSection
          canEdit={canEditSchedules}
          players={household.players || []}
          favorites={household.favorites || []}
          favoritesFailed={Boolean(household.favoritesFailed)}
          onRetryFavorites={loadHousehold}
          schedules={schedules}
          schedLoading={schedLoading}
          schedError={schedError}
          onReload={loadSchedules}
          onAdd={addSchedule}
          adding={adding}
          addError={addError}
        />
      )}
    </div>
  )
}

function NotConnectedPanel({ reason }) {
  if (reason === 'not_configured') {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <div className="flex items-center gap-2">
          <Music2 size={16} className="text-un1t-subtle" />
          <h2 className="font-semibold text-un1t-text">Studio music isn&apos;t set up yet</h2>
        </div>
        <p className="text-sm text-un1t-subtle mt-1">
          Sonos isn&apos;t configured on this deploy yet — ask an engineer to add the Sonos credentials before this can be connected.
        </p>
      </div>
    )
  }

  const detail = {
    refresh_failed: "Sonos revoked or expired this studio's connection. Reconnect to restore control.",
    db_error: "Couldn't check the Sonos connection just now. Try again — reconnect if this keeps happening.",
  }[reason] || "This studio hasn't connected a Sonos system yet."

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-center gap-2">
        <Music2 size={16} className="text-un1t-subtle" />
        <h2 className="font-semibold text-un1t-text">Studio music</h2>
      </div>
      <p className="text-sm text-un1t-subtle mt-1">{detail}</p>
      <a
        href="/api/sonos/connect"
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-un1t-text text-un1t-bg"
      >
        <ExternalLink size={12} /> Connect Sonos
      </a>
    </div>
  )
}

function UnreachableNotice({ statusCode }) {
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
      <p className="text-sm font-semibold text-amber-700 inline-flex items-center gap-1.5">
        <AlertCircle size={14} /> Sonos isn&apos;t answering right now
      </p>
      <p className="text-xs text-amber-700 mt-1">
        The connection itself is fine, but the Sonos cloud isn&apos;t responding
        {typeof statusCode === 'number' ? ` (HTTP ${statusCode})` : ''} right now. Scheduled playback
        keeps running on its own — this only affects the controls on this page. Try refreshing shortly.
      </p>
    </div>
  )
}

function HouseholdPicker({ ids, locationName }) {
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
      <p className="text-sm font-semibold text-amber-700">Pick a Sonos household</p>
      <p className="text-xs text-amber-700 mt-1">
        That Sonos account has more than one household, so we can&apos;t tell which one is{' '}
        {locationName || 'this studio'} automatically — guessing is exactly how the wrong studio got linked
        to the wrong system before, so choose below rather than picking blind. If you&apos;re not sure which
        is which, check the Sonos app installed at the studio. Choosing sends you back to Sonos to finish
        connecting.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {ids.map((id) => (
          <a
            key={id}
            href={`/api/sonos/connect?household_id=${encodeURIComponent(id)}`}
            className="text-xs font-semibold px-3 py-1.5 rounded border border-amber-500/40 text-amber-700 hover:bg-amber-500/10"
          >
            Use {id}
          </a>
        ))}
      </div>
    </div>
  )
}

// `canEdit` is false whenever the Sonos cloud isn't reachable — the schedule
// list itself is still shown (it's our own DB), but nothing that needs live
// players/favourites renders as editable. See the `connected`/`canEditSchedules`
// split in SonosScheduleInner above.
function SchedulesSection({ canEdit, players, favorites, favoritesFailed, onRetryFavorites, schedules, schedLoading, schedError, onReload, onAdd, adding, addError }) {
  const hasPlayers = players.length > 0
  const hasFavorites = favorites.length > 0

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-emerald-700">
              Sonos connected · {players.length} speaker{players.length === 1 ? '' : 's'} ✓
            </p>
            <button type="button" onClick={onReload} className="text-[11px] underline text-un1t-subtle shrink-0">
              {schedLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {!hasPlayers && (
            <p className="mt-2 text-xs text-amber-700 inline-flex items-center gap-1">
              <AlertCircle size={12} /> No speakers found on this Sonos system — add one in the Sonos app, then refresh.
            </p>
          )}
          {favoritesFailed ? (
            // A failed favourites fetch is NOT the same fact as a genuinely
            // favourite-less account (the groups call already proved the
            // household itself answered) — say so, and offer a retry rather
            // than a false "nothing saved" statement that also silently
            // blocks adding a window.
            <p className="mt-1 text-xs text-red-700 inline-flex items-center gap-1.5">
              <AlertCircle size={12} /> Couldn&apos;t load favourites from Sonos just now — that&apos;s a loading
              problem, not an empty account.
              <button type="button" onClick={onRetryFavorites} className="underline font-semibold shrink-0">
                Retry
              </button>
            </p>
          ) : !hasFavorites && (
            <p className="mt-1 text-xs text-amber-700 inline-flex items-center gap-1">
              <AlertCircle size={12} /> No favourites saved on this Sonos system — save one (a playlist or
              station) in the Sonos app so a window has something to play.
            </p>
          )}
          <p className="mt-2 text-[11px] text-un1t-subtle">
            Each window is applied once, right at the moment it opens — volume set, then the favourite starts
            playing — and paused once, when it closes. Nothing re-applies in between: if someone pauses the
            music or changes the volume mid-window, it stays that way until the next window opens.
          </p>
        </div>
      )}

      {!canEdit && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-un1t-subtle">
            Showing your saved schedules read-only below — speakers, favourites and editing come back once
            Sonos answers again.
          </p>
          <button type="button" onClick={onReload} className="text-[11px] underline text-un1t-subtle shrink-0">
            {schedLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}

      {schedError && <p className="text-[11px] text-red-700">{schedError}</p>}

      {schedules.length === 0 && !schedLoading && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-sm text-un1t-subtle">
            No schedules yet{canEdit ? ' — add one below to start playing music on a timer.' : '.'}
          </p>
        </div>
      )}

      {schedules.map((s) => (
        <ScheduleCard key={s.id} schedule={s} players={players} favorites={favorites} onReload={onReload} editable={canEdit} />
      ))}

      {canEdit && (
        <div>
          <button type="button" onClick={onAdd} disabled={adding}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
            {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add a schedule
          </button>
          {addError && <p className="mt-1 text-[11px] text-red-700">{addError}</p>}
        </div>
      )}
    </div>
  )
}

function ScheduleCard({ schedule, players, favorites, onReload, editable }) {
  const [name, setName] = useState(schedule.name || '')
  const [enabled, setEnabled] = useState(Boolean(schedule.enabled))
  const [playerIds, setPlayerIds] = useState(Array.isArray(schedule.player_ids) ? schedule.player_ids : [])
  const [windows, setWindows] = useState(Array.isArray(schedule.windows) ? schedule.windows : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [runState, setRunState] = useState(null) // null | 'running' | 'done' | { error }
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const hasPlayers = players.length > 0
  const hasFavorites = favorites.length > 0
  const canEnable = hasPlayers && playerIds.length > 0 && windows.length > 0
  // A speaker this schedule still names but Sonos no longer reports (removed
  // or renamed on the system) — surfaced so it isn't silently unpickable.
  const unknownPlayerIds = playerIds.filter((id) => !players.some((p) => p.id === id))

  function togglePlayer(id) {
    setPlayerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
    setSaved(false)
  }

  function addWindow() {
    if (windows.length >= MAX_WINDOWS || !hasFavorites) return
    setWindows((w) => [...w, { days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00', volume: DEFAULT_VOLUME, favorite_id: favorites[0]?.id || '' }])
    setSaved(false)
  }
  function removeWindow(i) {
    setWindows((w) => w.filter((_, idx) => idx !== i))
    setSaved(false)
  }
  function toggleDay(i, dayN) {
    setWindows((w) => w.map((win, idx) => {
      if (idx !== i) return win
      const days = win.days.includes(dayN) ? win.days.filter((d) => d !== dayN) : [...win.days, dayN].sort((a, b) => a - b)
      return { ...win, days }
    }))
    setSaved(false)
  }
  function setWindowField(i, field, value) {
    setWindows((w) => w.map((win, idx) => (idx === i ? { ...win, [field]: value } : win)))
    setSaved(false)
  }

  async function save(nextEnabled) {
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/sonos/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || 'Studio music',
          player_ids: playerIds,
          enabled: nextEnabled,
          windows: windows.map((w) => ({
            days: w.days,
            on: w.on,
            off: w.off,
            volume: Math.max(0, Math.min(100, Math.round(Number(w.volume)) || 0)),
            favorite_id: w.favorite_id,
          })),
        }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Save failed')
      setEnabled(nextEnabled)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function runNow() {
    setRunState('running')
    try {
      const res = await fetch(`/api/sonos/schedules/${schedule.id}/run-now`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Run failed')
      setRunState('done')
      setTimeout(() => setRunState((s) => (s === 'done' ? null : s)), 5000)
      onReload()
    } catch (e) {
      setRunState({ error: e.message })
    }
  }

  async function doDelete() {
    setDeleting(true); setDeleteError(null)
    try {
      const res = await fetch(`/api/sonos/schedules/${schedule.id}`, { method: 'DELETE' })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Delete failed')
      await onReload()
    } catch (e) {
      setDeleteError(e.message)
      setDeleting(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <label className="text-xs text-un1t-subtle flex-1 min-w-40">
          Name
          <input type="text" value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }}
            placeholder="e.g. Weekday classes" disabled={!editable}
            className="mt-1 w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm font-medium text-un1t-text disabled:opacity-70" />
        </label>
        <div className="flex items-center gap-2 shrink-0 pt-4">
          <span className={`text-xs font-semibold ${enabled ? 'text-emerald-700' : 'text-un1t-subtle'}`}>
            {enabled ? 'On' : 'Off'}
          </span>
          <button
            type="button"
            onClick={() => save(!enabled)}
            disabled={busy || !editable || (!enabled && !canEnable)}
            aria-pressed={enabled}
            aria-label={enabled ? 'Turn schedule off' : 'Turn schedule on'}
            title={!editable ? "Sonos isn't reachable — reconnect to edit" : (!enabled && !canEnable ? 'Pick at least one speaker and add a window to enable' : (enabled ? 'Turn off' : 'Turn on'))}
            className={`inline-flex h-6 w-11 items-center rounded-full border transition disabled:opacity-50 disabled:cursor-not-allowed ${enabled ? 'bg-emerald-500 border-emerald-600' : 'bg-un1t-muted border-un1t-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      <SonosLiveControl scheduleId={schedule.id} favorites={favorites} editable={editable} />

      <ScheduleOverride scheduleId={schedule.id} override={schedule.override} onReload={onReload} editable={editable} />

      {/* Speakers */}
      <div className="mt-3 border-t border-un1t-border/60 pt-3">
        <p className="text-xs font-semibold text-un1t-text mb-1.5">Speakers</p>
        {editable ? (
          <>
            {!hasPlayers && <p className="text-[11px] text-un1t-subtle">No speakers available yet.</p>}
            <div className="flex flex-wrap gap-2">
              {players.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePlayer(p.id)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${playerIds.includes(p.id) ? 'bg-blue-500/10 border-blue-500/40 text-blue-700' : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'}`}
                >
                  {p.name || p.id}
                </button>
              ))}
              {unknownPlayerIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => togglePlayer(id)}
                  title="Not reported by Sonos any more — click to remove it from this schedule"
                  className="text-xs px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-700 inline-flex items-center gap-1"
                >
                  {id} (unknown) <X size={11} />
                </button>
              ))}
            </div>
          </>
        ) : (
          // No live Sonos data to resolve ids to names or to tell a known
          // speaker from a removed one while unreachable — showing the
          // "(unknown)" label here would be a claim this data can't back up,
          // so just list what the schedule targets.
          <div className="flex flex-wrap gap-2">
            {playerIds.length === 0
              ? <p className="text-[11px] text-un1t-subtle">No speakers configured.</p>
              : playerIds.map((id) => (
                <span key={id} className="text-xs px-2.5 py-1 rounded-full border border-un1t-border text-un1t-subtle">
                  {id}
                </span>
              ))}
          </div>
        )}
      </div>

      {/* Windows */}
      <div className="mt-3 border-t border-un1t-border/60 pt-3 space-y-2">
        <p className="text-xs font-semibold text-un1t-text">Windows</p>
        {windows.length === 0 && (
          <p className="text-[11px] text-un1t-subtle">No windows yet{editable ? ' — add one below.' : '.'}</p>
        )}
        {editable ? windows.map((win, i) => (
          <div key={i} className="rounded border border-un1t-border/60 p-2 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((d) => {
                const on = win.days.includes(d.n)
                return (
                  <button key={d.n} type="button" onClick={() => toggleDay(i, d.n)}
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
              <label className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                Volume
                <input type="range" min="0" max="100" value={win.volume}
                  onChange={(e) => setWindowField(i, 'volume', Number(e.target.value))}
                  className="w-24 accent-un1t-text" />
                <span className="tabular-nums w-7 text-right">{win.volume}</span>
              </label>
              <label className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                Favourite
                <select value={win.favorite_id} onChange={(e) => setWindowField(i, 'favorite_id', e.target.value)}
                  className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text">
                  {favorites.length === 0 && <option value="">No favourites available</option>}
                  {win.favorite_id && !favorites.some((f) => f.id === win.favorite_id) && (
                    <option value={win.favorite_id}>{win.favorite_id} (not found)</option>
                  )}
                  {favorites.map((f) => (
                    <option key={f.id} value={f.id}>{f.name || f.id}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => removeWindow(i)}
                className="ml-auto text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1">
                <X size={12} /> Remove
              </button>
            </div>
          </div>
        )) : windows.map((win, i) => (
          // Read-only: no live favourites to resolve a name from, so show
          // the raw id rather than a "(not found)" label this data can't
          // support while unreachable.
          <div key={i} className="rounded border border-un1t-border/60 p-2 text-[11px] text-un1t-subtle">
            {DAY_LABELS.filter((d) => win.days.includes(d.n)).map((d) => d.label).join(', ') || 'No days'}
            {' · '}{win.on}–{win.off} · volume {win.volume} · favourite {win.favorite_id || '(none)'}
          </div>
        ))}
        {editable && windows.length < MAX_WINDOWS && (
          <button type="button" onClick={addWindow} disabled={!hasFavorites}
            title={!hasFavorites ? 'Save a favourite in the Sonos app first' : undefined}
            className="text-[11px] underline text-un1t-subtle inline-flex items-center gap-1 disabled:opacity-40 disabled:no-underline">
            <Plus size={12} /> Add window
          </button>
        )}
      </div>

      {editable && (
        <div className="mt-3 border-t border-un1t-border/60 pt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => save(enabled)} disabled={busy}
            className="text-xs font-semibold px-3 py-1.5 rounded bg-un1t-text text-un1t-bg disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Save'}
          </button>
          {saved && <span className="text-[11px] text-emerald-700">Saved ✓</span>}

          <button type="button" onClick={runNow} disabled={runState === 'running' || !enabled}
            title={!enabled ? 'Turn the schedule on first' : "Reapplies the currently-active window's volume + favourite"}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
            {runState === 'running' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
          </button>
        </div>
      )}
      {editable && error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}
      {editable && runState === 'done' && (
        <p className="mt-2 text-[11px] text-blue-700">Queued — the active window (if any) will be reapplied within a minute.</p>
      )}
      {editable && runState?.error && <p className="mt-2 text-[11px] text-red-700">{runState.error}</p>}

      {(() => {
        const health = scheduleHealth(schedule, Date.now())
        const cls = HEALTH_TONE_CLASSES[health.tone] || HEALTH_TONE_CLASSES.grey
        return (
          <div className="mt-2">
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls.chip}`}>
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${cls.dot}`} aria-hidden="true" />
              {health.label}
            </span>
            {health.detail && <p className="mt-1 text-[10px] text-un1t-subtle">{health.detail}</p>}
          </div>
        )
      })()}

      {editable && (
        <div className="mt-2 border-t border-un1t-border/60 pt-2">
          {!confirmDelete && (
            <button type="button" onClick={() => setConfirmDelete(true)}
              className="text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1">
              <Trash2 size={12} /> Delete schedule
            </button>
          )}
          {confirmDelete && (
            <span className="text-[11px] text-red-700 inline-flex items-center gap-2">
              Delete &quot;{schedule.name || 'this schedule'}&quot;?
              <button type="button" onClick={doDelete} disabled={deleting} className="underline font-semibold disabled:opacity-40">
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className="underline text-un1t-subtle disabled:opacity-40">
                Cancel
              </button>
            </span>
          )}
          {deleteError && <p className="mt-1 text-[11px] text-red-700">{deleteError}</p>}
        </div>
      )}
    </div>
  )
}

// Suppresses the schedule's boundary actions for a bounded period — for a
// private event or filming. Deliberately NOT a pause: it never touches
// playback, only whether the cron opens/closes a window (see planAction's
// own comments in src/lib/sonos/groups.js). `override` is read straight off
// the schedule prop rather than copied into local state — same as
// last_applied/last_state above, it's server-driven, refreshed via onReload
// (and the 60s poll in SonosScheduleInner). Liveness is recomputed inline on
// every render, never cached, so an expired override stops showing as live
// the moment it's rendered again, with no timer of its own required — and it
// mirrors planAction's own check exactly: state === 'off' && until && until
// (as ms) is still in the future.
function ScheduleOverride({ scheduleId, override, onReload, editable }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const live = isOverrideLive(override, Date.now())

  // Nothing to show and nothing editable can be done — Sonos being
  // unreachable disables setting/clearing an override same as every other
  // edit (see the `canEdit`/`editable` split above), and there is no live
  // override to display read-only either.
  if (!live && !editable) return null

  // Always PATCHes `override` alone — never name/player_ids/enabled/windows
  // — so this can never clobber a save in flight, and never the reverse.
  async function patchOverride(value) {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/sonos/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override: value }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Could not update the override')
      await onReload()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-un1t-border/60 pt-3">
      <p className="text-xs font-semibold text-un1t-text mb-1.5">Override</p>

      {live ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-700">
              <AlertCircle size={12} /> Leaving the music alone until {fmtDublin(override.until)}
            </span>
            {editable && (
              <button
                type="button"
                onClick={() => patchOverride(null)}
                disabled={busy}
                className="text-[11px] underline text-un1t-subtle hover:text-un1t-text disabled:opacity-40"
              >
                {busy ? 'Clearing…' : 'Clear override'}
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-un1t-subtle">
            Not pausing anything — if music is already playing, it keeps playing. This only stops the
            schedule opening or closing a window until then.
          </p>
        </>
      ) : (
        <>
          <p className="text-[11px] text-un1t-subtle mb-2">
            Stop this schedule opening or closing a window for a while — for a private event or filming.
            It doesn&apos;t touch playback: if music is already playing, it keeps playing; this only stops
            the CRM acting until the override ends.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-un1t-subtle">Leave the music alone</span>
            <button
              type="button"
              disabled={busy}
              title="Leave the music alone until midnight tonight"
              onClick={() => patchOverride({ state: 'off', until: untilMidnightTonightIso() })}
              className="text-xs px-2.5 py-1 rounded-full border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40"
            >
              until midnight
            </button>
            <button
              type="button"
              disabled={busy}
              title="Leave the music alone for 1 hour"
              onClick={() => patchOverride({ state: 'off', until: hoursFromNowIso(1) })}
              className="text-xs px-2.5 py-1 rounded-full border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40"
            >
              for 1 hour
            </button>
            <button
              type="button"
              disabled={busy}
              title="Leave the music alone for 3 hours"
              onClick={() => patchOverride({ state: 'off', until: hoursFromNowIso(3) })}
              className="text-xs px-2.5 py-1 rounded-full border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40"
            >
              for 3 hours
            </button>
          </div>
        </>
      )}

      {error && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
