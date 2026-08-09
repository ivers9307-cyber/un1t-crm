// @vitest-environment jsdom
//
// SEQEXIT.1 — the Audience field's MEANING changed underneath operators.
//
// It used to be an entry gate; it is now re-checked before every step and
// a contact who stops matching leaves the sequence. Nothing about the
// field itself looks different, so the change has to be said out loud
// next to it or nobody can infer it.
//
// SEQGAPS.1 Task A — the Goal select gains 'membership_state', so a dunning
// flow can record "they paid" as a WIN (goal_met) instead of a drop-out
// (left_audience). The value dropdown reuses the trigger's STATE_OPTS list
// minus its '' / "Any state" entry, which is meaningless for a goal: an
// unset value is exactly the unconfigured goal isGoalMet refuses to act on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import SequenceSettings, { AUDIENCE_CONTINUOUS_HINT } from './SequenceSettings.jsx'

describe('Audience conditions hint copy', () => {
  it('says the conditions are re-checked before every step', () => {
    expect(AUDIENCE_CONTINUOUS_HINT.toLowerCase()).toContain('before every step')
  })

  it('says a contact who stops matching leaves the sequence', () => {
    const copy = AUDIENCE_CONTINUOUS_HINT.toLowerCase()
    expect(copy).toContain('stops matching')
    expect(copy).toContain('leaves')
  })
})

describe('Goal editor — membership_state (SEQGAPS.1)', () => {
  beforeEach(() => {
    // Segment list + audience count fetches never resolve — irrelevant here.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const optionValues = (select) => Array.from(select.querySelectorAll('option')).map(o => o.value)

  function openSettings() {
    const { container, getByText } = render(
      <SequenceSettings sequence={{ id: 'seq-1', location_id: 'loc-1', name: 'Dunning', status: 'draft' }} />,
    )
    fireEvent.click(getByText('Settings & trigger'))
    return container
  }

  const goalSelectIn = (container) =>
    Array.from(container.querySelectorAll('select')).find(s => optionValues(s).includes('booking_made'))

  const stateValueSelectIn = (container) =>
    Array.from(container.querySelectorAll('select'))
      .find(s => optionValues(s).join(',') === 'active,paused,locked')

  it('offers "Reaches a membership state" as a goal type', () => {
    const container = openSettings()
    const goal = goalSelectIn(container)
    expect(goal).toBeTruthy()
    expect(optionValues(goal)).toContain('membership_state')
    const opt = Array.from(goal.querySelectorAll('option')).find(o => o.value === 'membership_state')
    expect(opt.textContent).toBe('Reaches a membership state')
  })

  it('seeds a default value of "active" the moment the type is chosen — never an unconfigured goal', () => {
    const container = openSettings()
    fireEvent.change(goalSelectIn(container), { target: { value: 'membership_state' } })
    const stateSelect = stateValueSelectIn(container)
    expect(stateSelect).toBeTruthy()
    expect(stateSelect.value).toBe('active')
  })

  it('drops the "" / Any state entry — an empty value is meaningless for a goal', () => {
    const container = openSettings()
    fireEvent.change(goalSelectIn(container), { target: { value: 'membership_state' } })
    const stateSelect = stateValueSelectIn(container)
    expect(optionValues(stateSelect)).toEqual(['active', 'paused', 'locked'])
    expect(optionValues(stateSelect)).not.toContain('')
  })

  it('lets the operator pick another state', () => {
    const container = openSettings()
    fireEvent.change(goalSelectIn(container), { target: { value: 'membership_state' } })
    const stateSelect = stateValueSelectIn(container)
    fireEvent.change(stateSelect, { target: { value: 'paused' } })
    expect(stateValueSelectIn(container).value).toBe('paused')
  })
})
