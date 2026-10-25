// OTA-VISIBLE.1 — the verdict behind the "OTA fleet" PR check.
//
// The check exists because on 2026-09-10 an OTA publish failed, main ran ahead
// of the phone fleet for hours, and nothing anyone looked at said so. The
// workflow's two existing fallbacks — a red run on main, an auto-opened issue
// — both fired correctly and both went unread. This puts the fact on the PR's
// checks list instead.
//
// So the verdict has to be right in both directions, and the failing-open
// direction matters as much as the failing-closed one: a check that reddens a
// PR on a network blip is a check people learn to route around.

import { describe, it, expect } from 'vitest'
import { fleetState, fleetMessage } from '../scripts/lib/ota-fleet-state.mjs'

const run = (over = {}) => ({
  status: 'completed',
  conclusion: 'success',
  databaseId: 1,
  ...over,
})

describe('fleetState', () => {
  it('is up to date when the last completed publish succeeded', () => {
    const state = fleetState([run()])
    expect(state.behind).toBe(false)
  })

  it('is BEHIND when the last completed publish failed', () => {
    const state = fleetState([run({ conclusion: 'failure', databaseId: 34476680007 })])
    expect(state.behind).toBe(true)
    expect(state.run.databaseId).toBe(34476680007)
  })

  it('is behind on a timeout too', () => {
    // A publish that never finished delivered nothing, which is the same fact
    // for the fleet as one that errored.
    expect(fleetState([run({ conclusion: 'timed_out' })]).behind).toBe(true)
  })

  it('ignores a run still in progress and judges the last COMPLETED one', () => {
    // The real sequence on 2026-09-10: a failure, then a fix merged, then a
    // new run in progress. Until that run completes the fleet IS still behind,
    // and saying "up to date" because something is running would be a lie the
    // reader acts on.
    const state = fleetState([
      { status: 'in_progress', conclusion: null, databaseId: 3 },
      run({ conclusion: 'failure', databaseId: 2 }),
    ])
    expect(state.behind).toBe(true)
    expect(state.run.databaseId).toBe(2)
  })

  it('clears once a later publish succeeds', () => {
    const state = fleetState([
      run({ conclusion: 'success', databaseId: 3 }),
      run({ conclusion: 'failure', databaseId: 2 }),
    ])
    expect(state.behind).toBe(false)
  })

  it('does not treat a cancelled or skipped run as a failure', () => {
    // Nothing was attempted, so the previous successful publish still stands.
    // Reading these as failures would redden PRs after every manual cancel.
    for (const conclusion of ['cancelled', 'skipped', 'neutral', 'action_required']) {
      const state = fleetState([run({ conclusion })])
      expect(state.behind, conclusion).toBe(false)
      expect(state.reason, conclusion).toContain('not a failure')
    }
  })

  it('says nothing when there is no history to judge', () => {
    expect(fleetState([]).behind).toBe(false)
    expect(fleetState([{ status: 'in_progress', conclusion: null }]).behind).toBe(false)
  })

  it('🔴 FAILS OPEN on an unreadable answer', () => {
    // An API blip is not evidence of a broken fleet. A check that goes red on
    // one is a check people learn to ignore, which costs the signal it exists
    // to create — so every non-array input reports nothing rather than alarm.
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const state = fleetState(bad)
      expect(state.behind, String(bad)).toBe(false)
      expect(state.reason).toContain('could not read')
    }
  })
})

describe('fleetMessage', () => {
  it('names the action, not just the fact', () => {
    // A message that only states a fact makes the reader work out whether it
    // matters. This one says what to do and what merging anyway costs.
    const state = fleetState([run({ conclusion: 'failure', databaseId: 99 })])
    const message = fleetMessage(state, 'https://github.com/o/r')
    expect(message).toContain('BEHIND')
    expect(message).toContain('https://github.com/o/r/actions/runs/99')
    expect(message).toContain('Run workflow')
    // Merging is explicitly NOT discouraged: the author cannot fix this from
    // their PR, and a check that seems to forbid unrelated work gets routed
    // around.
    expect(message).toContain('Merging this PR is fine')
  })

  it('is quiet and short when there is nothing wrong', () => {
    const message = fleetMessage(fleetState([run()]))
    expect(message).toContain('up to date')
    expect(message.split('\n')).toHaveLength(1)
  })

  it('degrades without a repo url rather than printing a broken link', () => {
    const state = fleetState([run({ conclusion: 'failure', databaseId: 99 })])
    expect(fleetMessage(state)).toContain('Actions → EAS Update')
  })
})
