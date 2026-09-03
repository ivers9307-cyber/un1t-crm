// @vitest-environment jsdom
//
// MAIL-DOCK.2 — the compose card itself. Thin like MailDock (state and the
// Esc ladder live in MailSurface, decisions in mail-display), so what is
// worth pinning here is the SHAPE per mode — structural class assertions,
// jsdom cannot measure pixels — the minimised bar's click-anywhere restore,
// the slot offsets around the reader, and the ONE behaviour this card owns
// that the reader's does not: a scoped Escape that never reaches the window
// listener the surface's reader ladder lives on.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ComposeDock from './ComposeDock.jsx'

afterEach(cleanup)

const card = () => document.querySelector('[data-compose-mode]')

function renderCard(props = {}) {
  return render(
    <ComposeDock subject="Re: your trial" footer={<button type="button">Send</button>} {...props}>
      <textarea aria-label="the form" defaultValue="half a draft" />
    </ComposeDock>
  )
}

describe('ComposeDock — one card, three shapes, its own viewport geometry', () => {
  it('dock with the corner free: bottom-right absolute card at md, filling the pane like the reader card', () => {
    renderCard({ mode: 'dock' })
    const el = card()
    expect(el.getAttribute('data-compose-mode')).toBe('dock')
    expect(el.className).toContain('md:absolute')
    expect(el.className).toContain('md:bottom-0')
    expect(el.className).toContain('md:right-4')
    expect(el.className).toContain('md:h-[78vh]')
    // MAILFIX-DOCK.1 — fragment-level, so the containing block is the
    // VIEWPORT; 288 = sidebar + hub padding + margin (derivation at
    // ComposeDock's DOCK_BY_READER) — never touches the sidebar.
    expect(el.className).toContain('md:w-[min(1120px,calc(100vw-288px))]')
  })

  it('dock beside a PARKED reader bar reserves the bar’s room — the only state minShifted is in play', () => {
    renderCard({ mode: 'dock', readerOccupancy: 'bar' })
    const el = card()
    // 672 = 288 + the 1.5rem step + the 360px bar; MailDock.minShifted
    // quotes this exact term (dock-geometry.test.js pins the equality).
    expect(el.className).toContain('md:w-[min(1120px,calc(100vw-672px))]')
    expect(el.className).toContain('md:right-4')
  })

  it('dock with an unknown occupancy falls back to the RESERVED width — the one that cannot overlap', () => {
    renderCard({ mode: 'dock', readerOccupancy: 'sideways' })
    expect(card().className).toContain('md:w-[min(1120px,calc(100vw-672px))]')
  })

  it('dock: the title bar is the house ink', () => {
    renderCard({ mode: 'dock' })
    const el = card()
    // The house ink title bar — MAIL-DOCK.1's vocabulary, verbatim.
    expect(el.firstElementChild.className).toContain('bg-un1t-text')
    expect(el.firstElementChild.className).toContain('text-un1t-bg')
  })

  it('full: the takeover at fixed inset-4, body centred at the reading measure', () => {
    renderCard({ mode: 'full' })
    const el = card()
    expect(el.className).toContain('md:inset-4')
    const body = el.lastElementChild
    expect(body.className).toContain('md:max-w-[680px]')
    expect(body.className).toContain('md:mx-auto')
  })

  it('min: the FORM stays MOUNTED but hidden — the typed draft is why min exists', () => {
    renderCard({ mode: 'min' })
    const field = screen.getByLabelText('the form')
    expect(field).toBeTruthy()
    expect(field.value).toBe('half a draft')
    expect(card().lastElementChild.className).toMatch(/(?:^|\s)hidden(?:\s|$)/)
  })

  it('an unknown mode renders as dock rather than an unstyled card', () => {
    renderCard({ mode: 'sideways' })
    expect(card().className).toContain('md:h-[78vh]')
  })

  it('the footer renders inside the card bottom while open, and hides with the form in min', () => {
    renderCard({ mode: 'dock' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    cleanup()
    renderCard({ mode: 'min' })
    // Mounted (state preserved) but inside the hidden body — not a visible control.
    expect(screen.getByText('Send').closest('.hidden')).toBeTruthy()
  })
})

describe('ComposeDock — the minimised bar stacks around the reader', () => {
  it('owns right-4 when the corner is free', () => {
    renderCard({ mode: 'min', readerOccupancy: 'none' })
    expect(card().className).toContain('md:right-4')
  })

  it('steps left of the reader’s 360px bar in the VIEWPORT frame — 4.5rem, clamped to the PANE’s left margin', () => {
    renderCard({ mode: 'min', readerOccupancy: 'bar' })
    // MAILFIX-DOCK.1 — the reader bar's right edge is 41px inside the
    // viewport's, this bar's 16; a 1.5rem viewport step overlapped the
    // reader bar's left 17px. 4.5rem = hub pad + right-4 + a 32px gap.
    // The clamp is the same 624 the step over the reader CARD uses: an
    // unclamped 4.5rem+360 is a constant 432 offset, putting this bar's
    // left edge at 100vw-792 — over the sidebar's Sign-out footer below
    // 1,016px and off the viewport below 792px.
    expect(card().className).toContain('md:right-[min(calc(4.5rem+360px),calc(100vw-624px))]')
  })

  it('steps left of the reader’s docked card, clamped to the PANE’s left margin', () => {
    renderCard({ mode: 'min', readerOccupancy: 'card' })
    // MAILFIX-DOCK.1 — the reader card fills the pane at laptop widths, so
    // the unclamped step pushed this bar (holding a parked draft) off the
    // viewport's left edge; the clamp floors it at the pane's left margin
    // (624 = sidebar + hub pad + margin + the bar), never over the sidebar.
    expect(card().className).toContain('md:right-[min(calc(4.5rem+1120px),calc(100vw-624px))]')
  })

  it('an unknown occupancy fails safe to the free corner', () => {
    renderCard({ mode: 'min', readerOccupancy: 'sideways' })
    expect(card().className).toContain('md:right-4')
  })
})

describe('ComposeDock — the title bar', () => {
  it('shows the typed subject, else New email — never an empty bar', () => {
    renderCard({ mode: 'dock' })
    expect(screen.getByText('Re: your trial')).toBeTruthy()
    cleanup()
    renderCard({ mode: 'dock', subject: '   ' })
    expect(screen.getByText('New email')).toBeTruthy()
  })

  it('every control is a real typed button with an aria-label', () => {
    renderCard({ mode: 'dock' })
    for (const name of ['Minimise the email', 'Expand to full screen', 'Close the email']) {
      const btn = screen.getByRole('button', { name })
      expect(btn.getAttribute('type')).toBe('button')
    }
  })

  it('full swaps ⤢ for ⤡ and keeps the rest', () => {
    renderCard({ mode: 'full' })
    expect(screen.getByRole('button', { name: 'Restore to docked size' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Expand to full screen' })).toBeNull()
  })

  it('minimised: clicking ANYWHERE on the bar restores — except ✕, which still closes', () => {
    const onRestore = vi.fn()
    const onClose = vi.fn()
    renderCard({ mode: 'min', onRestore, onClose })
    fireEvent.click(screen.getByText('Re: your trial'))
    expect(onRestore).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close the email' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // The close click must not ALSO bubble into a restore.
    expect(onRestore).toHaveBeenCalledTimes(1)
    // A bar offers restore or close, nothing else.
    expect(screen.queryByRole('button', { name: 'Expand to full screen' })).toBeNull()
  })

  it('wires ─/⤢/⤡ to their handlers', () => {
    const onMinimise = vi.fn()
    const onExpand = vi.fn()
    renderCard({ mode: 'dock', onMinimise, onExpand })
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the email' }))
    expect(onMinimise).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }))
    expect(onExpand).toHaveBeenCalledTimes(1)
    cleanup()
    const onContract = vi.fn()
    renderCard({ mode: 'full', onContract })
    fireEvent.click(screen.getByRole('button', { name: 'Restore to docked size' }))
    expect(onContract).toHaveBeenCalledTimes(1)
  })
})

describe('ComposeDock — 🔴 Escape is SCOPED to the card', () => {
  it('routes Esc from inside the form to onEscape and STOPS it reaching window', () => {
    const onEscape = vi.fn()
    const windowSaw = vi.fn()
    window.addEventListener('keydown', windowSaw)
    try {
      renderCard({ mode: 'dock', onEscape })
      fireEvent.keyDown(screen.getByLabelText('the form'), { key: 'Escape' })
      expect(onEscape).toHaveBeenCalledTimes(1)
      // The surface's window listener — where the READER's Esc ladder lives —
      // must never see a compose-scoped Escape, or a dirty draft's minimise
      // gesture would also close the conversation underneath it.
      expect(windowSaw).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowSaw)
    }
  })

  it('leaves every other key alone — typing propagates as typing', () => {
    const onEscape = vi.fn()
    const windowSaw = vi.fn()
    window.addEventListener('keydown', windowSaw)
    try {
      renderCard({ mode: 'dock', onEscape })
      fireEvent.keyDown(screen.getByLabelText('the form'), { key: 'e' })
      expect(onEscape).not.toHaveBeenCalled()
      expect(windowSaw).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowSaw)
    }
  })
})
