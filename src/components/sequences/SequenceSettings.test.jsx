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

// GAPS-P3.2 — the anniversary "Anniversary of" dropdown and the cron's
// allowed from_field list are one contract, not two lists kept in sync by
// hand. An option offered here that the cron rejects produces a sequence
// that logs an error and skips on every tick, forever; a field the cron
// supports but the dropdown hides is simply unreachable.
describe('Anniversary from_field dropdown mirrors the cron whitelist (GAPS-P3.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const optionValues = (select) => Array.from(select.querySelectorAll('option')).map(o => o.value)

  function openAnniversarySettings() {
    const { container, getByText } = render(
      <SequenceSettings sequence={{ id: 'seq-1', location_id: 'loc-1', name: 'Anniversary', status: 'draft', trigger_type: 'anniversary' }} />,
    )
    fireEvent.click(getByText('Settings & trigger'))
    return container
  }

  it('renders the from_field select with exactly the cron-allowed fields, in order', async () => {
    const { ANNIVERSARY_FROM_FIELDS } = await import('@/lib/sequences/anniversary-fields')
    const container = openAnniversarySettings()
    const select = Array.from(container.querySelectorAll('select'))
      .find(s => optionValues(s).includes('dob'))
    expect(select, 'no anniversary from_field select rendered').toBeTruthy()
    expect(optionValues(select)).toEqual([...ANNIVERSARY_FROM_FIELDS])
  })

  it('every option carries a human label (no raw column names in the UI)', () => {
    const container = openAnniversarySettings()
    const select = Array.from(container.querySelectorAll('select'))
      .find(s => optionValues(s).includes('dob'))
    for (const opt of select.querySelectorAll('option')) {
      expect(opt.textContent.trim().length, `option ${opt.value} has no label`).toBeGreaterThan(0)
      expect(opt.textContent, `option ${opt.value} shows its raw column name`).not.toBe(opt.value)
    }
  })
})
