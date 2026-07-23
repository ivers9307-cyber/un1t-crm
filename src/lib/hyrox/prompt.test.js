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
  it('arc prompt constrains the plan to a terse, exact-count skeleton (guards arc token-overrun)', () => {
    const { system, user } = buildArcPrompt(input)
    // The 2026-07-23 arc_generation_failed: a detailed charter made the model
    // write paragraph-long weeks until it truncated at the token cap. These
    // instructions keep the arc a short skeleton so it fits the budget.
    expect(system).toContain('EXACTLY 12 entries')
    expect(system.toLowerCase()).toContain('skeleton')
    expect(system).toMatch(/short phrase/i)
    expect(system.toLowerCase()).toContain('individual sessions') // charter scoped to sessions
    expect(user).toContain('terse')
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
  it('places the session in the full block plan: week position, benchmark ordinal, slot, and the plan list', () => {
    const arcPlan = [
      { week_no: 1, phase: 'base', stimulus: 'Engine base', progression: 'establish baseline', is_benchmark: false },
      { week_no: 2, phase: 'base', stimulus: 'Engine base', progression: 'add volume', is_benchmark: false },
      { week_no: 3, phase: 'base', stimulus: 'Benchmark test', progression: 'measure', is_benchmark: true },
      { week_no: 4, phase: 'build', stimulus: 'Strength engine', progression: 'add load', is_benchmark: false },
    ]
    const week = arcPlan[2] // week 3, the benchmark
    const { system, user } = buildExpansionPrompt({ week, slot: 1, sessionsPerWeek: 2, arcPlan })
    const combined = `${system}\n${user}`
    expect(combined).toContain('WEEK 3 of 4')
    expect(combined).toContain('benchmark 1 of')
    expect(combined).toContain('session 1 of 2')
    expect(combined).toContain('Full block plan in order')
    expect(combined).toContain('week 4 (build)')
  })
  it('carries last week\'s session summary forward when provided', () => {
    const arcPlan = [
      { week_no: 1, phase: 'base', stimulus: 'Engine base', progression: 'establish baseline', is_benchmark: false },
      { week_no: 2, phase: 'base', stimulus: 'Engine base', progression: 'add volume', is_benchmark: false },
    ]
    const week = arcPlan[1]
    const { user } = buildExpansionPrompt({ week, slot: 1, sessionsPerWeek: 2, arcPlan, prevWeekSummary: 'session 1: Engine' })
    expect(user).toContain('session 1: Engine')
  })
})
