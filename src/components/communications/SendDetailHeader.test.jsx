// @vitest-environment jsdom
//
// COMMS-DETAIL-FIX.4 — the shared send-detail chrome has to actually be shared.
//
// Measured on the consolidated views before this change:
//   * email's title row was `items-center`, so with a two-line title (name +
//     preheader) the channel chip and the status pill centred on the whole
//     block and landed BETWEEN the two lines, reading as labels for the
//     subject rather than for the send;
//   * WhatsApp's title was a fixed `w-64` input, so the status pill sat at a
//     constant 256px offset with a dead gap after a short name and a long name
//     clipped inside the box — and the input was visually identical to SMS's
//     static <h2>, so nothing said it was editable;
//   * SMS passed no status slot at all.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import SendDetailHeader from './SendDetailHeader.jsx'
import SendStatusPill from './SendStatusPill.jsx'
import EditableSendTitle from './EditableSendTitle.jsx'

afterEach(() => cleanup())

describe('SendDetailHeader — pills sit on the FIRST line of a wrapping title', () => {
  it('top-aligns the title row instead of centring it on the block', () => {
    render(
      <SendDetailHeader
        channel="email"
        title={<div><h2>August lock-in offer</h2><p>Your August lock-in rate closes Monday</p></div>}
        status={<SendStatusPill status="sent" />}
      />
    )
    const row = screen.getByTestId('send-detail-title-row')
    expect(row.className).toMatch(/\bitems-start\b/)
    expect(row.className).not.toMatch(/\bitems-center\b/)
  })

  it('boxes the channel chip and the status pill to the title lead line', () => {
    render(<SendDetailHeader channel="email" title={<h2>x</h2>} status={<SendStatusPill status="sent" />} />)
    for (const testId of ['send-detail-channel-chip', 'send-detail-status']) {
      // h-7 is the text-lg line box (28px) the title's first line occupies, so
      // a shorter pill centres against that line and not against the block.
      expect(screen.getByTestId(testId).className, testId).toMatch(/\bh-7\b/)
    }
  })

  it('omits the status box entirely when a channel passes none', () => {
    render(<SendDetailHeader channel="sms" title={<h2>x</h2>} />)
    expect(screen.queryByTestId('send-detail-status')).toBeNull()
  })
})

describe('SendStatusPill — the one status treatment', () => {
  it('title-cases the stored value', () => {
    render(<SendStatusPill status="sending" />)
    expect(screen.getByTestId('send-status-pill').textContent).toBe('Sending')
  })

  it('uses the repo chip recipe', () => {
    render(<SendStatusPill status="sent" />)
    const cls = screen.getByTestId('send-status-pill').className
    expect(cls).toMatch(/bg-green-500\/10/)
    expect(cls).toMatch(/text-green-700/)
  })

  it('renders nothing without a status', () => {
    const { container } = render(<SendStatusPill status={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('passes a caller test id through so existing guards keep their handle', () => {
    render(<SendStatusPill status="failed" testId="campaign-status-chip" title="audience filter rejected" />)
    const chip = screen.getByTestId('campaign-status-chip')
    expect(chip.getAttribute('title')).toBe('audience filter rejected')
  })
})

describe('EditableSendTitle — looks editable, sizes to its content', () => {
  it('renders an input, not a static heading', () => {
    render(<EditableSendTitle value="August offer reminder" onChange={() => {}} />)
    expect(screen.getByTestId('editable-send-title').tagName).toBe('INPUT')
  })

  it('has no fixed width — the pill after it must not sit at a constant offset', () => {
    render(<EditableSendTitle value="Aug" onChange={() => {}} />)
    expect(screen.getByTestId('editable-send-title').className).not.toMatch(/\bw-64\b/)
  })

  it('mirrors its value into a sizing twin so the field grows with the name', () => {
    render(<EditableSendTitle value="A very long broadcast name indeed" onChange={() => {}} />)
    expect(screen.getByTestId('editable-send-title-sizer').textContent).toBe('A very long broadcast name indeed')
  })

  it('carries a visible edit affordance while it is editable', () => {
    render(<EditableSendTitle value="x" onChange={() => {}} />)
    expect(screen.getByTestId('editable-send-title-affordance')).toBeTruthy()
    // …and a hover/focus border, so it does not read as a static heading.
    expect(screen.getByTestId('editable-send-title').className).toMatch(/hover:border-/)
  })

  it('drops the affordance when the record is read-only', () => {
    render(<EditableSendTitle value="x" onChange={() => {}} disabled />)
    expect(screen.queryByTestId('editable-send-title-affordance')).toBeNull()
    expect(screen.getByTestId('editable-send-title').disabled).toBe(true)
  })
})
