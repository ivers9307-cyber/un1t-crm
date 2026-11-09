// @vitest-environment jsdom
// HOSTPORTAL.2 — the "Take this event off sale?" dialog.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { RE_REVIEW_REASON_LABEL } from '@/lib/host-events'

const { default: OffSaleConfirmDialog, joinLabels } = await import('./OffSaleConfirmDialog.jsx')

afterEach(() => cleanup())

function setup(props = {}) {
  const onConfirm = vi.fn()
  const onKeepEditing = vi.fn()
  const utils = render(
    <OffSaleConfirmDialog open reasons={['date']} brandName="UN1T" busy={false} onConfirm={onConfirm} onKeepEditing={onKeepEditing} {...props} />,
  )
  return { onConfirm, onKeepEditing, ...utils }
}

describe('OffSaleConfirmDialog', () => {
  it('renders nothing while closed', () => {
    setup({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a modal dialog labelled by its title, with the brand-named body', () => {
    setup({ reasons: ['date', 'price'] })
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const title = screen.getByText('Take this event off sale?')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.textContent).toContain(`You changed ${RE_REVIEW_REASON_LABEL.date} and ${RE_REVIEW_REASON_LABEL.price}.`)
    expect(dialog.textContent).toContain('Saving sends the event to UN1T for review.')
    expect(dialog.textContent).toContain('Until it is approved the public page is offline and nobody can book. Existing bookings are kept.')
  })

  it('moves focus to Keep editing when it opens', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }))
  })

  it('both buttons are type=button and fire their own callback', () => {
    const { onConfirm, onKeepEditing } = setup()
    const keep = screen.getByRole('button', { name: 'Keep editing' })
    const save = screen.getByRole('button', { name: 'Save and send for review' })
    expect(keep.getAttribute('type')).toBe('button')
    expect(save.getAttribute('type')).toBe('button')
    fireEvent.click(save)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onKeepEditing).not.toHaveBeenCalled()
    fireEvent.click(keep)
    expect(onKeepEditing).toHaveBeenCalledTimes(1)
  })

  it('Escape and a click on the overlay mean Keep editing; a click inside does not', () => {
    const { onKeepEditing, onConfirm } = setup()
    fireEvent.click(screen.getByText('Take this event off sale?'))
    expect(onKeepEditing).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onKeepEditing).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onKeepEditing).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('while busy the confirm button is disabled and Keep editing does nothing harmful', () => {
    const { onConfirm } = setup({ busy: true })
    const save = screen.getByRole('button', { name: /Saving|Save and send for review/ })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('joinLabels', () => {
  it('joins one, two and three or more labels', () => {
    expect(joinLabels(['A'], 'or')).toBe('A')
    expect(joinLabels(['A', 'B'], 'or')).toBe('A or B')
    expect(joinLabels(['A', 'B', 'C'], 'or')).toBe('A, B or C')
    expect(joinLabels(['A', 'B', 'C'], 'and')).toBe('A, B and C')
  })
})
