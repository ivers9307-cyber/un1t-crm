// @vitest-environment jsdom
//
// BOARDFILTER.1 — the board's search box and "Stuck 21+ days" toggle write the
// URL; the server does the filtering.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const replace = vi.fn()
let params = new URLSearchParams('pipeline=acquisition&contact=c1')
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
  usePathname: () => '/pipeline',
}))

import PipelineBoardFilter, { BOARD_SEARCH_DEBOUNCE_MS } from './PipelineBoardFilter'

beforeEach(() => { replace.mockClear(); params = new URLSearchParams('pipeline=acquisition&contact=c1') })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('PipelineBoardFilter', () => {
  it('typing navigates once after the pause, keeps the board, drops the open contact', async () => {
    vi.useFakeTimers()
    render(<PipelineBoardFilter />)
    const box = screen.getByRole('searchbox', { name: /search the board/i })
    fireEvent.change(box, { target: { value: 'Ao' } })
    fireEvent.change(box, { target: { value: 'Aoife' } })
    expect(replace).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_SEARCH_DEBOUNCE_MS) })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/pipeline?pipeline=acquisition&q=Aoife', { scroll: false })
  })
  it('Enter searches at once', () => {
    render(<PipelineBoardFilter />)
    const box = screen.getByRole('searchbox')
    fireEvent.change(box, { target: { value: 'Pat' } })
    fireEvent.submit(box.closest('form'))
    expect(replace).toHaveBeenCalledWith('/pipeline?pipeline=acquisition&q=Pat', { scroll: false })
  })
  it('the stuck toggle sets and clears ?stuck=1 and says whether it is on', () => {
    const { rerender } = render(<PipelineBoardFilter />)
    const btn = screen.getByRole('button', { name: /stuck 21\+ days/i })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.getAttribute('type')).toBe('button')
    fireEvent.click(btn)
    expect(replace).toHaveBeenLastCalledWith('/pipeline?pipeline=acquisition&stuck=1', { scroll: false })
    params = new URLSearchParams('pipeline=acquisition&stuck=1')
    rerender(<PipelineBoardFilter stuck />)
    expect(screen.getByRole('button', { name: /stuck/i }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /stuck/i }))
    expect(replace).toHaveBeenLastCalledWith('/pipeline?pipeline=acquisition', { scroll: false })
  })
  it('CONTACTLOG.1 — Not contacted sets and clears ?nocontact=1 and keeps stuck', () => {
    params = new URLSearchParams('pipeline=acquisition&stuck=1')
    const { rerender } = render(<PipelineBoardFilter stuck />)
    const btn = screen.getByRole('button', { name: /not contacted/i })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.getAttribute('type')).toBe('button')
    fireEvent.click(btn)
    expect(replace).toHaveBeenLastCalledWith('/pipeline?pipeline=acquisition&stuck=1&nocontact=1', { scroll: false })
    params = new URLSearchParams('pipeline=acquisition&stuck=1&nocontact=1')
    rerender(<PipelineBoardFilter stuck nocontact />)
    fireEvent.click(screen.getByRole('button', { name: /not contacted/i }))
    expect(replace).toHaveBeenLastCalledWith('/pipeline?pipeline=acquisition&stuck=1', { scroll: false })
  })
  it('no stuck toggle on the Off funnel view', () => {
    render(<PipelineBoardFilter showStuck={false} />)
    expect(screen.queryByRole('button', { name: /stuck/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /not contacted/i })).toBeNull()
    expect(screen.getByRole('searchbox')).toBeTruthy()
  })
  it('clear empties the box and the URL; an unchanged filter does not navigate', () => {
    params = new URLSearchParams('q=Pat')
    render(<PipelineBoardFilter q="Pat" />)
    fireEvent.submit(screen.getByRole('searchbox').closest('form'))
    expect(replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /clear search/i }))
    expect(replace).toHaveBeenCalledWith('/pipeline', { scroll: false })
    expect(screen.getByRole('searchbox').value).toBe('')
  })
})
