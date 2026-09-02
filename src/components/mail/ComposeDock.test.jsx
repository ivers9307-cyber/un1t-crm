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

describe('ComposeDock — one card, three shapes, the reader’s geometry', () => {
  it('dock: bottom-right absolute card at md, the reader card’s exact measure', () => {
    renderCard({ mode: 'dock' })
    const el = card()
    expect(el.getAttribute('data-compose-mode')).toBe('dock')
    expect(el.className).toContain('md:absolute')
    expect(el.className).toContain('md:bottom-0')
    expect(el.className).toContain('md:right-4')
    expect(el.className).toContain('md:h-[78vh]')
    expect(el.className).toContain('md:w-[min(560px,calc(100vw-2rem))]')
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

  it('steps left of the reader’s 360px bar', () => {
    renderCard({ mode: 'min', readerOccupancy: 'bar' })
    expect(card().className).toContain('md:right-[calc(1.5rem+min(360px,calc(100vw-2rem)))]')
  })

  it('steps left of the reader’s 560px docked card', () => {
    renderCard({ mode: 'min', readerOccupancy: 'card' })
    expect(card().className).toContain('md:right-[calc(1.5rem+min(560px,calc(100vw-2rem)))]')
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
