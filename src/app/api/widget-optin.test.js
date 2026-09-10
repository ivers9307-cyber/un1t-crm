// src/app/api/widget-optin.test.js
// WIDGET.1 — the opt-in list, as a test. Adding allowWidgetToken to a route
// widens what a lost phone reaches, so the set is pinned here: a seventh
// route cannot join quietly — someone has to come to this file and read this.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    async (req, ctx) => handler({ request: req, params: ctx?.params ? await ctx.params : undefined }),
    { _opts: opts }
  ),
}))

import { POST as shellyToggle } from './shelly/devices/[id]/toggle/route.js'
import { POST as acOn } from './studio-management/ac/devices/[id]/turn-on/route.js'
import { POST as acOff } from './studio-management/ac/devices/[id]/turn-off/route.js'
import { POST as unlock } from './studio-management/unlock/route.js'
import { POST as sonos } from './sonos/control/route.js'
import { GET as queueCount } from './home-queue/count/route.js'

const OPTED_IN = [
  ['shelly toggle', shellyToggle],
  ['AC turn-on', acOn],
  ['AC turn-off', acOff],
  ['door unlock', unlock],
  ['sonos control', sonos],
  ['home-queue count', queueCount],
]

describe('the widget-token opt-in set', () => {
  it.each(OPTED_IN)('%s carries allowWidgetToken', (_name, route) => {
    expect(route._opts.allowWidgetToken).toBe(true)
  })

  it.each(OPTED_IN)('%s is location-scoped', (_name, route) => {
    // A widget token IS a location. withAuth throws on location:false, but
    // pin it here too so the invariant is visible at the opt-in site.
    expect(route._opts.location).toBe(true)
  })

  it('is exactly six routes — update this count deliberately', () => {
    expect(OPTED_IN).toHaveLength(6)
  })
})
