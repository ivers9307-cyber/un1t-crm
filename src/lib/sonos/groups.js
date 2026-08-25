// SONOS.7 — pure Sonos mappers + the window planner. No I/O: everything
// here takes plain data and returns plain data, so the reconcile can be
// tested with injected fakes.

import { resolveServeWindows } from '@/lib/schedule/desired-state'

const arr = (v) => (Array.isArray(v) ? v : [])

// GET /households/{id}/groups returns groups AND players AND each group's
// playbackState in one response — the whole read side of a tick.
export function mapGroups(raw) {
  return {
    groups: arr(raw?.groups)
      .filter((g) => g && typeof g.id === 'string' && g.id)
      .map((g) => ({
        id: g.id,
        name: g.name || '',
        coordinatorId: g.coordinatorId || null,
        playbackState: g.playbackState || null,
        playerIds: arr(g.playerIds).filter((p) => typeof p === 'string'),
      })),
    players: arr(raw?.players)
      .filter((p) => p && typeof p.id === 'string' && p.id)
      .map((p) => ({ id: p.id, name: p.name || '' })),
  }
}

// Player ids are permanent; group ids are ephemeral. A schedule stores the
// former and resolves the latter every tick.
//
// Dedupe matters: four speakers in one group must produce ONE group id, or
// the open action fires loadFavorite four times at the same group and the
// playlist restarts three times. Order follows player_ids, so the first
// player names the primary group.
export function resolveGroupIds(groups, playerIds) {
  const out = []
  for (const pid of arr(playerIds)) {
    const g = arr(groups).find((gr) => arr(gr.playerIds).includes(pid))
    if (g && !out.includes(g.id)) out.push(g.id)
  }
  return out
}

const DEFAULT_VOLUME = 30

// last_applied.window_on_at comes back from jsonb and SHOULD be the raw
// epoch-ms number planAction emitted. Normalise anyway: if it ever arrives
// as a string — a timestamptz column, a .toISOString() "to make it
// readable", any serialisation that stringifies — a strict === against
// active.on_at silently never matches, every tick re-opens the window, and
// loadFavorite restarts the playlist every sixty seconds. Silent, and
// exactly the failure exactly-once exists to prevent.
const toMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n          // "1756011600000"
    const d = new Date(v).getTime()           // "2026-08-24T05:00:00.000Z"
    return Number.isFinite(d) ? d : null
  }
  return null
}

// → null | { action:'open', windowOnAt, volume, favoriteId }
//        | { action:'close', windowOnAt }
//
// Exactly-once per window, NOT desired-vs-actual. The Homey reconcile could
// run continuously because re-flipping an on plug is a no-op; loadFavorite
// is not — re-issuing it restarts the playlist from the top. So the question
// each tick is "have I already applied this window?", never "does actual
// match desired?".
//
// Three consequences, all wanted:
//   - a missed boundary tick self-heals (the next tick still sees it unapplied)
//   - a human who pauses or turns the volume down mid-window is left alone
//   - a redeploy mid-window re-reads last_applied and does nothing
export function planAction(schedule, nowMs, dateStr) {
  if (!schedule?.enabled) return null

  // Suppression override: "leave the music alone until X". Deliberately
  // no {state:'on'} — that would have to invent a volume and a favourite,
  // and the honest source for both is a window.
  const ov = schedule.override
  if (ov?.state === 'off' && ov.until && new Date(ov.until).getTime() > nowMs) return null

  // The engine is fed a device-shaped object. `enabled` is already checked
  // above, and `override` is deliberately NOT passed: override here is
  // suppression, whereas the engine would read it as a forced on/off state.
  const windows = resolveServeWindows(
    { enabled: true, schedule_mode: 'fixed', fixed_windows: arr(schedule.windows) },
    dateStr,
  )

  const last = schedule.last_applied
  // windows is sorted ascending by on_at, so when two windows overlap on
  // the same day .find() keeps the earliest-starting one — a deliberate
  // tie-break, not an accident. Nothing at validation stops that overlap.
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  if (active) {
    // Inside a window whose on_at we have already actioned — whether we
    // opened it or have since closed it — there is nothing left to do.
    if (last && toMs(last.window_on_at) === active.on_at) return null
    const src = active.source || {}
    return {
      action: 'open',
      windowOnAt: active.on_at,
      volume: Number.isFinite(Number(src.volume)) ? Number(src.volume) : DEFAULT_VOLUME,
      // No favorite_id: pass null through rather than refuse to open. A
      // refusal would leave the room silent with zero signal, which is
      // worse for whoever is debugging this at 7am than a repeating log
      // line. The cost: Sonos rejects the null, the open sequence fails,
      // last_applied is deliberately not stamped (see above), so the
      // WHOLE open sequence — including setVolume — retries every tick.
      // A schedule missing its favourite therefore silently re-stomps any
      // volume a human set, every sixty seconds, until the data is fixed.
      favoriteId: src.favorite_id || null,
    }
  }

  // Outside every window. Close only what we opened: if there is no record
  // of opening, a pause here would silence music somebody started by hand
  // (the case where the CRM was down for a whole window and came back after).
  if (last?.action === 'open') {
    const wo = toMs(last.window_on_at)
    // wo === null means window_on_at was unparseable — a corrupt or
    // unexpected record that still claims action:'open'. Falling through to
    // the final `return null` (no close fires) is deliberate, not an
    // oversight: we cannot identify which window we opened, and inventing a
    // close/pause could silence music someone started by hand, the same
    // hazard the "no record at all" branch above already exists to avoid.
    if (wo !== null) return { action: 'close', windowOnAt: wo }
  }

  return null
}
