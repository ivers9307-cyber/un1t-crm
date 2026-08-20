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
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  if (active) {
    // Inside a window whose on_at we have already actioned — whether we
    // opened it or have since closed it — there is nothing left to do.
    if (last && last.window_on_at === active.on_at) return null
    const src = active.source || {}
    return {
      action: 'open',
      windowOnAt: active.on_at,
      volume: Number.isFinite(Number(src.volume)) ? Number(src.volume) : DEFAULT_VOLUME,
      favoriteId: src.favorite_id || null,
    }
  }

  // Outside every window. Close only what we opened: if there is no record
  // of opening, a pause here would silence music somebody started by hand
  // (the case where the CRM was down for a whole window and came back after).
  if (last?.action === 'open') return { action: 'close', windowOnAt: last.window_on_at }

  return null
}
