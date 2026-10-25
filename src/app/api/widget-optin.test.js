// src/app/api/widget-optin.test.js
// WIDGET.1 — the opt-in list, as a test. Adding allowWidgetToken to a route
// widens what a lost phone reaches, so the set is pinned here: a seventh
// route cannot join quietly — someone has to come to this file and read this.

import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
import { GET as widgetDevices } from './widget/devices/route.js'

const OPTED_IN = [
  ['shelly toggle', shellyToggle],
  ['AC turn-on', acOn],
  ['AC turn-off', acOff],
  ['door unlock', unlock],
  ['sonos control', sonos],
  ['home-queue count', queueCount],
  ['widget devices', widgetDevices],
]

const EXPECTED_WIDGET_TOKEN_ROUTES = [
  'home-queue/count/route.js',
  'shelly/devices/[id]/toggle/route.js',
  'sonos/control/route.js',
  'studio-management/ac/devices/[id]/turn-off/route.js',
  'studio-management/ac/devices/[id]/turn-on/route.js',
  'studio-management/unlock/route.js',
  'widget/devices/route.js',
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

  it('is exactly seven routes — update this count deliberately', () => {
    expect(OPTED_IN).toHaveLength(7)
  })

  it('filesystem guard: all routes with allowWidgetToken are listed above', () => {
    const __filename = fileURLToPath(import.meta.url)
    const apiDir = path.dirname(__filename) // src/app/api
    const foundRoutes = []

    function walkDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(fullPath)
        } else if (entry.name === 'route.js') {
          const content = fs.readFileSync(fullPath, 'utf8')
          // Match allowWidgetToken as an object key (not in comments).
          // Pattern: allowWidgetToken followed by : and true, word-bounded.
          if (/allowWidgetToken\s*:\s*true\b/.test(content)) {
            const relative = path.relative(apiDir, fullPath)
            foundRoutes.push(relative)
          }
        }
      }
    }

    walkDir(apiDir)
    const found = foundRoutes.sort()
    const expected = EXPECTED_WIDGET_TOKEN_ROUTES.sort()

    expect(found).toEqual(
      expected,
      `Found routes with allowWidgetToken do not match the list above.
Found: ${found.join(', ')}
Expected: ${expected.join(', ')}`
    )
  })
})
