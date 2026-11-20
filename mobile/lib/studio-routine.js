// STUDIOROUTINE.1 — "Open studio" and "Close studio" on the phone's controls
// screen: one press switches the studio's lights, music and air con.
//
// Richard's decision (19 Nov 2026): lights, music and AC only, NEVER doors.
// This module has no door call and must never gain one.
//
// It calls the routes each device screen already uses, one device family after
// another, so every safety rule those routes hold (Shelly's override and
// rollback, Sonos's token refresh, the AC allowlist and session rules) still
// applies. What it switches, at the studio the screen is on:
//   - lights: every Shelly GROUP (the light sets the studio set up), on until
//     the studio's midnight, or off. Ungrouped plugs are left alone: a plug can
//     be a fridge or a till.
//   - music:  every Sonos group in the household, play or pause.
//   - air con: every unit the person may control there (the list route is
//     allowlist-filtered), on or off. A unit already running is fine on Open.
// A family the person has no permission for is skipped, not failed, and one
// family failing never stops the next.
//
// Pure apart from the injected API calls, so it is tested without a phone.

export const ROUTINE_MODES = Object.freeze(['open', 'close'])

/**
 * @typedef {{ family: 'lights'|'music'|'ac', status: 'done'|'partial'|'failed'|'skipped'|'none', switched: number, total: number, note?: string }} FamilyResult
 */

const settle = async (items, run) => {
  let ok = 0
  for (const item of items) {
    try {
      if (await run(item)) ok += 1
    } catch {
      // a thrown call is a failed one; the next item still runs
    }
  }
  return ok
}

const outcome = (family, switched, total, note) => ({
  family,
  status: total === 0 ? 'none' : switched === total ? 'done' : switched === 0 ? 'failed' : 'partial',
  switched,
  total,
  ...(note ? { note } : {}),
})

const failedRead = (family, note) => ({ family, status: 'failed', switched: 0, total: 0, note })
const skipped = (family) => ({ family, status: 'skipped', switched: 0, total: 0 })

async function lights(mode, locationId, apiFns) {
  const res = await apiFns.listShellyGroups(locationId)
  if (!res?.success) return failedRead('lights', res?.code === 'not_connected' ? 'Shelly is not connected' : 'Could not read the light groups')
  const groups = res.groups || []
  const state = mode === 'open' ? 'on' : 'off'
  const switched = await settle(groups, async (g) => {
    const r = await apiFns.toggleShellyGroup(g.id, { state }, locationId)
    // 'partial' / 'none' mean some lights did not take the command yet
    return r?.success === true && (r.applied == null || r.applied === 'all')
  })
  return outcome('lights', switched, groups.length)
}

async function music(mode, locationId, apiFns) {
  const res = await apiFns.getSonosHousehold(locationId)
  if (!res?.success) return failedRead('music', 'Could not reach Sonos')
  if (res.connected === false) return failedRead('music', 'Sonos is not connected')
  if (res.reachable === false) return failedRead('music', 'Could not reach Sonos')
  const groups = res.groups || []
  const action = mode === 'open' ? 'play' : 'pause'
  const switched = await settle(groups, async (g) => {
    const r = await apiFns.sendSonosAction({ groupId: g.id }, action, undefined, locationId)
    return r?.success === true
  })
  return outcome('music', switched, groups.length)
}

async function ac(mode, locationId, apiFns) {
  const res = await apiFns.listAcDevices(locationId)
  if (!res?.success) return failedRead('ac', 'Could not read the air con units')
  const units = res.data || []
  const switched = await settle(units, async (u) => {
    const r = mode === 'open'
      ? await apiFns.turnOnAcDevice(u.id, locationId)
      : await apiFns.turnOffAcDevice(u.id, locationId)
    // Open on a unit that is already running is the state we want.
    return r?.success === true || (mode === 'open' && r?.code === 'already_running')
  })
  return outcome('ac', switched, units.length)
}

/**
 * Run Open or Close at one studio.
 * @param {'open'|'close'} mode
 * @param {{ locationId: string, can: { lights: boolean, music: boolean, ac: boolean }, api: object }} opts
 *   `api` holds listShellyGroups, toggleShellyGroup, getSonosHousehold,
 *   sendSonosAction, listAcDevices, turnOnAcDevice, turnOffAcDevice.
 * @returns {Promise<FamilyResult[]>} lights, music, ac, in that order
 */
export async function runStudioRoutine(mode, { locationId, can, api: apiFns }) {
  if (!ROUTINE_MODES.includes(mode)) throw new Error(`unknown routine ${mode}`)
  if (!locationId) throw new Error('no studio')
  const guard = async (family, enabled, fn) => {
    if (!enabled) return skipped(family)
    try {
      return await fn(mode, locationId, apiFns)
    } catch {
      return failedRead(family, 'Something went wrong')
    }
  }
  return [
    await guard('lights', can?.lights, lights),
    await guard('music', can?.music, music),
    await guard('ac', can?.ac, ac),
  ]
}

const LABEL = { lights: 'Lights', music: 'Music', ac: 'Air con' }

/** One line per family for the result card, e.g. "Lights: 3 of 4 groups". */
export function routineSummary(results) {
  return (results || []).filter((r) => r.status !== 'skipped').map((r) => {
    const name = LABEL[r.family]
    if (r.status === 'none') return `${name}: nothing set up here`
    if (r.total === 0) return `${name}: ${r.note || 'failed'}`
    const unit = r.family === 'ac' ? 'units' : 'groups'
    return `${name}: ${r.switched} of ${r.total} ${unit}${r.status === 'done' ? '' : ' (check the device screen)'}`
  })
}
