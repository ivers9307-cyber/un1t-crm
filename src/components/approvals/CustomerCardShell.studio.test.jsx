// @vitest-environment jsdom
// APPROVALSQ.6 — the studio chip on a card.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import CustomerCardShell from './CustomerCardShell'

afterEach(cleanup)

describe('CustomerCardShell studio chip', () => {
  it('shows nothing extra without a studio', () => {
    render(<CustomerCardShell name="Ann" meta="UN1T Stillorgan" />)
    expect(screen.getByText('UN1T Stillorgan')).toBeTruthy()
  })
  it('a card at the active studio gets the neutral chip', () => {
    render(<CustomerCardShell name="Ann" studio={{ id: 's1', name: 'Stillorgan', other: false }} />)
    const chip = screen.getByText('Stillorgan')
    expect(chip.className).toContain('bg-un1t-border/30')
    expect(chip.className).not.toContain('bg-blue-500/10')
  })
  it('a card at another studio gets the blue chip', () => {
    render(<CustomerCardShell name="Ann" studio={{ id: 's2', name: 'Hatch Street', other: true }} />)
    const chip = screen.getByText('Hatch Street')
    expect(chip.className).toContain('bg-blue-500/10')
    expect(chip.className).toContain('text-blue-700')
  })
  it('never shows the studio twice: a provider meta that is the studio name is replaced', () => {
    render(<CustomerCardShell name="Ann" meta="Hatch Street" studio={{ id: 's2', name: 'Hatch Street', other: true }} />)
    expect(screen.getAllByText('Hatch Street')).toHaveLength(1)
  })
  it('keeps a provider meta that says something else', () => {
    render(<CustomerCardShell name="Ann" meta="via the customer agent" studio={{ id: 's2', name: 'Hatch Street', other: true }} />)
    expect(screen.getByText('via the customer agent')).toBeTruthy()
    expect(screen.getByText('Hatch Street')).toBeTruthy()
  })
})
