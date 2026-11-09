// @vitest-environment jsdom
// HOSTPORTAL.1 — the nav strip sits on its own full-width row at every width
// and scrolls the active link into view.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

const nav = { pathname: '/host/earnings' }
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: React.forwardRef(function Link({ href, children, ...rest }, ref) { return <a ref={ref} href={href} {...rest}>{children}</a> }) }
})
const { default: HostNav } = await import('./HostNav.jsx')

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('HostNav — layout and scroll', () => {
  it('is a full-width last-order row with no breakpoint override', () => {
    render(<HostNav />)
    const cls = screen.getByRole('navigation', { name: 'Host portal' }).className
    expect(cls).toContain('order-last')
    expect(cls).toContain('w-full')
    expect(cls).toContain('overflow-x-auto')
    expect(cls).not.toMatch(/\bsm:/)
  })
  it('scrolls the active link into view on mount and when the path changes', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const { rerender } = render(<HostNav />)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.instances[0].textContent).toBe('Earnings')
    expect(spy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    nav.pathname = '/host/page'
    rerender(<HostNav />)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.instances[1].textContent).toBe('Your page')
  })
})
