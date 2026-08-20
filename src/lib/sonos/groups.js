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
