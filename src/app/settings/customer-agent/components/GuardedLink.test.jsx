// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import GuardedLink from './GuardedLink'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function click(dirty, answer) {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(answer)
  render(<GuardedLink href="/x" dirty={dirty}>Go</GuardedLink>)
  const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'Go' }))
  return { confirm, notPrevented }
}

describe('GuardedLink', () => {
  it('does not ask when nothing is unsaved', () => {
    const { confirm, notPrevented } = click(false, false)
    expect(confirm).not.toHaveBeenCalled()
    expect(notPrevented).toBe(true)
  })
  it('asks when dirty and stops the navigation on cancel', () => {
    const { confirm, notPrevented } = click(true, false)
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?')
    expect(notPrevented).toBe(false)
  })
  it('lets the navigation go on when the person agrees', () => {
    const { notPrevented } = click(true, true)
    expect(notPrevented).toBe(true)
  })
})
