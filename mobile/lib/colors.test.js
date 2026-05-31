import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { un1t, stage } from './colors.js'

// Drift guard: the JS `un1t` palette must equal the NativeWind un1t-*
// tokens in mobile/tailwind.config.js. We parse the config as TEXT
// rather than importing it — importing executes
// `require('nativewind/preset')`, which pulls RN-only modules that
// don't load under the Node test env.
const cfg = readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8')
const tw = {}
for (const m of cfg.matchAll(/'un1t-([a-z]+)':\s*'(#[0-9A-Fa-f]{6})'/g)) {
  tw[m[1]] = m[2].toUpperCase()
}

describe('colors.un1t mirrors mobile/tailwind.config.js', () => {
  it('parsed the un1t-* tokens from the config', () => {
    expect(Object.keys(tw).length).toBeGreaterThanOrEqual(7)
  })
  for (const [key, value] of Object.entries(un1t)) {
    it(`un1t.${key} === un1t-${key} in tailwind config`, () => {
      expect(tw[key]).toBe(value.toUpperCase())
    })
  }
})

describe('colors palette shape', () => {
  it('all values are 6-digit hex', () => {
    for (const v of [...Object.values(un1t), ...Object.values(stage)]) {
      expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})
