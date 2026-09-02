// @vitest-environment jsdom
//
// MAIL-DOCK.1 — the card itself. Thin on purpose (state and keyboard live in
// MailSurface, decisions in mail-display), so what is worth pinning here is
// the SHAPE per mode — jsdom cannot measure pixels, so these are the same
// structural class assertions the rail-below-md test established — and the
// minimised bar's click-anywhere restore, which the surface tests reach only
// through the ─ button.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import MailDock from './MailDock.jsx'

afterEach(cleanup)

const dock = () => document.querySelector('[data-reader-mode]')

function renderDock(props = {}) {
  return render(
    <MailDock subject="Membership freeze" {...props}>
      <p>the thread</p>
    </MailDock>
  )
}

describe('MailDock — one card, three shapes', () => {
  it('dock: bottom-right absolute card at md, a plain full pane below (mobile untouched)', () => {
    renderDock({ mode: 'dock' })
    const el = dock()
    expect(el.getAttribute('data-reader-mode')).toBe('dock')
    // Mobile base: an ordinary flex pane…
    expect(el.className).toMatch(/(?:^|\s)flex(?:\s|$)/)
    expect(el.className).toMatch(/(?:^|\s)flex-1(?:\s|$)/)
    // …dock-shaped only at md.
    expect(el.className).toContain('md:absolute')
    expect(el.className).toContain('md:bottom-0')
    expect(el.className).toContain('md:right-4')
    expect(el.className).toContain('md:h-[78vh]')
    expect(el.className).toContain('md:w-[min(560px,calc(100vw-2rem))]')
  })

  it('full: the SAME card at fixed inset-4, body centred at reading measure', () => {
    renderDock({ mode: 'full' })
    const el = dock()
    expect(el.className).toContain('md:fixed')
    expect(el.className).toContain('md:inset-4')
    const body = el.lastElementChild
    expect(body.className).toContain('md:max-w-[680px]')
    expect(body.className).toContain('md:mx-auto')
  })

  it('min: children stay MOUNTED but hidden at md — polls keep running', () => {
    renderDock({ mode: 'min' })
    expect(screen.getByText('the thread')).toBeTruthy()
    expect(dock().lastElementChild.className).toMatch(/(?:^|\s)md:hidden(?:\s|$)/)
  })

  it('an unknown mode renders as dock rather than an unstyled card', () => {
    renderDock({ mode: 'sideways' })
    expect(dock().className).toContain('md:h-[78vh]')
  })
})

describe('MailDock — the title bar', () => {
  it('every control is a real typed button with an aria-label', () => {
    renderDock({ mode: 'dock' })
    for (const name of ['Minimise the conversation', 'Expand to full screen', 'Close the conversation']) {
      const btn = screen.getByRole('button', { name })
      expect(btn.getAttribute('type')).toBe('button')
    }
  })

  it('full swaps ⤢ for ⤡ and keeps the rest', () => {
    renderDock({ mode: 'full' })
    expect(screen.getByRole('button', { name: 'Restore to docked size' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Expand to full screen' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Minimise the conversation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close the conversation' })).toBeTruthy()
  })

  it('minimised: clicking ANYWHERE on the bar restores — except ✕, which still closes', () => {
    const onRestore = vi.fn()
    const onClose = vi.fn()
    renderDock({ mode: 'min', onRestore, onClose })
    fireEvent.click(screen.getByText('Membership freeze'))
    expect(onRestore).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close the conversation' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // The close click must not ALSO bubble into a restore.
    expect(onRestore).toHaveBeenCalledTimes(1)
    // And ⤢ is gone — a bar offers restore or close, nothing else.
    expect(screen.queryByRole('button', { name: 'Expand to full screen' })).toBeNull()
  })

  it('says (no subject) rather than an empty bar, and chips Needs reply only when told', () => {
    renderDock({ mode: 'dock', subject: '', needsReply: false })
    expect(screen.getByText('(no subject)')).toBeTruthy()
    expect(screen.queryByText('Needs reply')).toBeNull()
    cleanup()
    renderDock({ mode: 'dock', needsReply: true })
    expect(screen.getByText('Needs reply')).toBeTruthy()
  })
})
