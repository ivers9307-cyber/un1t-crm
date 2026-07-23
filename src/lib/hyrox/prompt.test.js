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
  it('folds house style into both arc and expansion prompts', () => {
    const houseStyle = 'We run partner relays and cue loudly.'
    expect(buildArcPrompt({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed', houseStyle }).system).toContain('partner relays')
    const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'x', is_benchmark: false }
    expect(buildExpansionPrompt({ week, houseStyle }).system).toContain('partner relays')
  })
  it('injects capped few-shot example sessions into the expansion prompt', () => {
    const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'x', is_benchmark: false }
    const styleExamples = [
      { text: 'EXAMPLE-ONE run 500m' }, { text: 'EXAMPLE-TWO sled push' }, { text: 'EXAMPLE-THREE wall balls' }, { text: 'EXAMPLE-FOUR should be dropped' },
    ]
    const { system } = buildExpansionPrompt({ week, styleExamples })
    expect(system).toContain('EXAMPLE-ONE')
    expect(system).toContain('EXAMPLE-THREE')
    expect(system).not.toContain('EXAMPLE-FOUR')  // capped at MAX_STYLE_EXAMPLES=3
  })
  it('truncates an over-long example', () => {
    const week = { week_no: 1, phase: 'base', stimulus: 's', progression: 'p', is_benchmark: false }
    const long = 'x'.repeat(5000)
    const { system } = buildExpansionPrompt({ week, styleExamples: [{ text: long }] })
    expect(system).not.toContain('x'.repeat(3000))  // truncated below MAX_EXAMPLE_CHARS=2500
  })
})
