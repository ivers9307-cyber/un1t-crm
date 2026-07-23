import { describe, it, expect } from 'vitest'
import { buildArcPrompt, buildExpansionPrompt } from './prompt'
import { DEFAULT_CHARTER } from './constants'

const input = { weeks: 12, sessionsPerWeek: 2, dial: 'mixed', locationLabel: 'UN1T STILLORGAN', charter: DEFAULT_CHARTER }

describe('prompt builders', () => {
  it('arc prompt embeds the charter, dial, and a JSON-only instruction', () => {
    const { system, user } = buildArcPrompt(input)
    expect(system).toContain('tough, challenging, but doable, and always fun')
    expect(user).toContain('mixed')
    expect(system.toLowerCase()).toContain('json')
    expect(system).not.toContain('—') // no em-dashes leak into member-facing strings
  })
  it('expansion prompt carries the week stimulus and the two tiers only', () => {
    const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'add a round', is_benchmark: false }
    const { system, user } = buildExpansionPrompt({ ...input, week, slot: 1, autoTuneSignal: null })
    expect(user).toContain('Engine')
    expect(system.toLowerCase()).toContain('performance')
    expect(system.toLowerCase()).toContain('elite')
    expect(system.toLowerCase()).not.toContain('foundation')
  })
})
