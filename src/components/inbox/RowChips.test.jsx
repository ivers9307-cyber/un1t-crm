// @vitest-environment jsdom
// INBOXFOLLOW.1 — the wait chip, window chip and state line on a queue row.
// The clock is a prop (nowMs), so no fake timers are needed.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { WaitChip, WindowChip, StateLine, durationLabel } from './RowChips.jsx'

afterEach(cleanup)

const H = 3600_000
const NOW = Date.parse('2026-11-25T12:00:00Z') // a Wednesday
const ago = (ms) => new Date(NOW - ms).toISOString()
const ahead = (ms) => new Date(NOW + ms).toISOString()
const CFG = { quietHours: 48, nudgeEnabled: false }
const wa = { _ch: 'wa', last_message_at: ago(H) }

describe('durationLabel', () => {
  it.each([
    [30_000, '<1m'], [45 * 60_000, '45m'], [2 * H + 10 * 60_000, '2h 10m'], [3 * H, '3h'],
    [24 * H, '1 day'], [50 * H, '2 days'],
  ])('%i ms reads %s', (ms, label) => expect(durationLabel(ms)).toBe(label))
})

describe('WaitChip', () => {
  it('says "waiting 2h 10m" when the customer is waiting on us', () => {
    const conv = { ...wa, last_message_direction: 'inbound', customer_waiting_since: ago(2 * H + 10 * 60_000) }
    render(<WaitChip conv={conv} nowMs={NOW} cfg={CFG} />)
    expect(screen.getByTestId('wait-chip').textContent).toBe('waiting 2h 10m')
  })

  it('says "quiet 2 days" when we are waiting on the customer', () => {
    const conv = { ...wa, last_message_direction: 'outbound', staff_owned_since: ago(60 * H), staff_waiting_since: ago(2 * 24 * H + H) }
    render(<WaitChip conv={conv} nowMs={NOW} cfg={{ quietHours: 96, nudgeEnabled: false }} />)
    expect(screen.getByTestId('wait-chip').textContent).toBe('quiet 2 days')
  })

  it('counts a returned thread from the moment it came back', () => {
    const conv = { ...wa, last_message_direction: 'outbound', staff_waiting_since: ago(50 * H) }
    render(<WaitChip conv={conv} nowMs={NOW} cfg={CFG} />)
    expect(screen.getByTestId('wait-chip').textContent).toBe('waiting 2h')
  })

  it('renders nothing for an answered thread, a resolved thread, or no thread', () => {
    const { container, rerender } = render(<WaitChip conv={{ ...wa, last_message_direction: 'outbound' }} nowMs={NOW} cfg={CFG} />)
    expect(container.innerHTML).toBe('')
    rerender(<WaitChip conv={{ ...wa, last_message_direction: 'inbound', customer_waiting_since: ago(H), resolved_at: ago(H / 2) }} nowMs={NOW} cfg={CFG} />)
    expect(container.innerHTML).toBe('')
    rerender(<WaitChip conv={null} nowMs={NOW} cfg={CFG} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('WindowChip', () => {
  it('says "closes in 3h" in amber when it closes within four hours', () => {
    render(<WindowChip conv={{ ...wa, window_expires_at: ahead(3 * H + 20 * 60_000) }} nowMs={NOW} />)
    const chip = screen.getByTestId('window-chip')
    expect(chip.textContent).toBe('closes in 3h')
    expect(chip.className).toContain('text-amber-700') // under four hours: soon
  })

  it('is not amber while there is plenty of time', () => {
    render(<WindowChip conv={{ ...wa, window_expires_at: ahead(10 * H) }} nowMs={NOW} />)
    const chip = screen.getByTestId('window-chip')
    expect(chip.textContent).toBe('closes in 10h')
    expect(chip.className).not.toContain('amber')
  })

  it('says "template only" in grey once the window has closed', () => {
    render(<WindowChip conv={{ ...wa, window_expires_at: ago(H) }} nowMs={NOW} />)
    const chip = screen.getByTestId('window-chip')
    expect(chip.textContent).toBe('template only')
    expect(chip.className).toContain('text-gray-700')
  })

  it('shows minutes inside the last hour', () => {
    render(<WindowChip conv={{ ...wa, window_expires_at: ahead(40 * 60_000) }} nowMs={NOW} />)
    expect(screen.getByTestId('window-chip').textContent).toBe('closes in 40m')
  })

  it('renders nothing for Instagram', () => {
    const { container } = render(<WindowChip conv={{ _ch: 'ig', window_expires_at: ago(H) }} nowMs={NOW} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('StateLine', () => {
  const stateText = () => screen.getByTestId('state-line').textContent

  it('says "Snoozed until Fri 09:00 · <note>" in the studio\'s zone', () => {
    const conv = { ...wa, snoozed_until: '2026-11-27T09:00:00Z', snooze_note: 'Away until Friday' }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(stateText()).toBe('Snoozed until Fri 09:00 · Away until Friday')
  })

  it('reads the same instant on another studio\'s clock, and leaves the note off when there is none', () => {
    const conv = { ...wa, snoozed_until: '2026-11-27T09:00:00Z', snooze_note: null }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="America/New_York" />)
    expect(stateText()).toBe('Snoozed until Fri 04:00')
  })

  it('says "Mia nudged Tue 10:02" while a nudged thread waits on the customer', () => {
    const conv = { ...wa, staff_waiting_since: ago(30 * H), staff_nudged_at: '2026-11-24T10:02:00Z', staff_nudge_outcome: 'sent' }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(stateText()).toBe('Mia nudged Tue 10:02')
  })

  it('says "No reply after nudge" once the nudged thread comes back', () => {
    const conv = { ...wa, staff_waiting_since: ago(80 * H), staff_nudged_at: ago(50 * H), staff_nudge_outcome: 'sent' }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(stateText()).toBe('No reply after nudge')
  })

  it('says "Snooze ended · <note>" once a snooze ends on a thread nobody is waiting on', () => {
    const conv = { ...wa, last_message_direction: 'outbound', snoozed_until: ago(2 * H), snooze_note: 'check paid Friday' }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(stateText()).toBe('Snooze ended · check paid Friday')
  })

  it('says just "Snooze ended" when there is no note', () => {
    const conv = { ...wa, last_message_direction: 'outbound', snoozed_until: ago(2 * H), snooze_note: '  ' }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(stateText()).toBe('Snooze ended')
  })

  it('says "Gone quiet" when an un-nudged thread comes back', () => {
    const conv = { ...wa, staff_waiting_since: ago(50 * H) }
    render(<StateLine conv={conv} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(stateText()).toBe('Gone quiet')
  })

  it('renders nothing when the preview should stay, and with no zone uses the platform default', () => {
    const { container, rerender } = render(<StateLine conv={{ ...wa, last_message_direction: 'inbound' }} nowMs={NOW} cfg={CFG} zone="Europe/Dublin" />)
    expect(container.innerHTML).toBe('')
    rerender(<StateLine conv={{ ...wa, snoozed_until: '2026-11-27T09:00:00Z' }} nowMs={NOW} cfg={CFG} />)
    expect(stateText()).toBe('Snoozed until Fri 09:00')
  })
})
