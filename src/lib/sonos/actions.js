// SONOSLIVE.2 — the closed action list for live control, and the pure
// mapping from an action name to a client call.
//
// Closed on purpose: an open-ended pass-through to the Sonos API cannot be
// meaningfully permission-gated, so the list IS the security boundary. One
// permission check on the route covers everything in it.
//
// No I/O here — this returns which call to make and with what, so dispatch
// is testable without HTTP or a database.

const DEFAULT_VOLUME_STEP = 5

export const ACTIONS = [
  'volume_up', 'volume_down', 'set_volume',
  'play', 'pause', 'skip_next', 'skip_previous', 'load_favorite',
]

// Validate the TYPE before coercing. A bare `Number(v)` accepts null, true,
// [], and whitespace strings (all coerce to 0) — the route's Zod schema
// (z.union([z.number(), z.string()]).optional()) blocks null/true/[] before
// this runs, but a whitespace string is a valid string as far as Zod is
// concerned, so '  ' would otherwise silently become volume 0.
const isInt = (v) => {
  if (typeof v === 'number') return Number.isInteger(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) && Number.isInteger(n)
  }
  return false
}

// → null (unknown action or unusable value)
//   | { call, args, touchesVolume }
//
// `call` names an entry in the route's client map. `touchesVolume` lets the
// caller refuse volume changes on a group Sonos reports as fixed-level.
export function planLiveAction(action, value) {
  switch (action) {
    case 'volume_up':
    case 'volume_down': {
      // A caller sending a negative step means "a step of this size", not
      // "invert my direction" — direction lives in the action name.
      const raw = value === undefined || value === null ? DEFAULT_VOLUME_STEP : Number(value)
      if (!Number.isFinite(raw)) return null
      const size = Math.abs(Math.round(raw))
      if (size < 1 || size > 100) return null
      const delta = action === 'volume_up' ? size : -size
      return { call: 'setRelativeVolume', args: [delta], touchesVolume: true }
    }

    case 'set_volume': {
      if (!isInt(value)) return null
      const level = Number(value)
      // Out of range is a caller bug. The client clamps defensively, but
      // silently turning 140 into 100 hides the mistake from whoever sent it.
      if (level < 0 || level > 100) return null
      return { call: 'setVolume', args: [level], touchesVolume: true }
    }

    case 'play':          return { call: 'play', args: [], touchesVolume: false }
    case 'pause':         return { call: 'pause', args: [], touchesVolume: false }
    case 'skip_next':     return { call: 'skipNext', args: [], touchesVolume: false }
    case 'skip_previous': return { call: 'skipPrevious', args: [], touchesVolume: false }

    case 'load_favorite': {
      const id = typeof value === 'string' ? value.trim() : ''
      if (!id) return null
      return { call: 'loadFavorite', args: [id], touchesVolume: false }
    }

    default:
      return null
  }
}
