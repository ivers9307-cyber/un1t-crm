// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('@/components/host/HostEventActions', () => ({ default: function HostEventActions(props) { return <div data-testid="actions">{props.eventId}|{props.status}|{String(props.hasRegistrations)}|{props.brandName}</div> } }))
const { default: HostEventMenu } = await import('./HostEventMenu.jsx')

afterEach(() => cleanup())
const mount = () => render(<div><span data-testid="outside">x</span><HostEventMenu eventId="e1" status="draft" hasRegistrations={false} brandName="Brand" /></div>)

describe('HostEventMenu', () => {
  it('starts closed', () => {
    mount()
    expect(screen.getByRole('button', { name: 'More actions' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('actions')).toBeNull()
  })
  it('opens on click, passing the props to HostEventActions', () => {
    mount()
    const btn = screen.getByRole('button', { name: 'More actions' })
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('actions').textContent).toBe('e1|draft|false|Brand')
  })
  it('closes on Escape', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('actions')).toBeNull()
  })
  it('closes on an outside click but not an inside one', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.mouseDown(screen.getByTestId('actions'))
    expect(screen.getByTestId('actions')).toBeTruthy()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByTestId('actions')).toBeNull()
    expect(screen.getByRole('button', { name: 'More actions' }).getAttribute('aria-expanded')).toBe('false')
  })
})
