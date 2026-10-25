// src/components/schedule/MoreMenu.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — five toolbar actions moved into this menu, so "reachable from
// the keyboard" is now this component's job. Focus and roles are things jsdom
// answers honestly. Where the menu is DRAWN is not (memory
// `jsdom-cannot-see-layout`): the phone-width placement is a browser check.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import MoreMenu from '@/components/schedule/MoreMenu'

const ITEMS = [
  { key: 'time-off', label: 'Time off', href: '/schedule/time-off' },
  { key: 'select', label: 'Select multiple', checked: false, title: 'Select multiple shifts' },
  { key: 'copy-week', label: 'Copy last week', disabled: true },
  { key: 'copy-month', label: 'Copy last month' },
]

afterEach(() => cleanup())

function open(onSelect = vi.fn(), props = {}) {
  render(<MoreMenu items={ITEMS} onSelect={onSelect} {...props} />)
  const button = screen.getByRole('button', { name: 'More' })
  fireEvent.click(button)
  return { button, onSelect }
}

describe('MoreMenu', () => {
  it('is a real menu button, closed by default', () => {
    render(<MoreMenu items={ITEMS} onSelect={() => {}} />)
    const button = screen.getByRole('button', { name: 'More' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens, points aria-controls at the menu, and focuses the first item', () => {
    const { button } = open()
    const menu = screen.getByRole('menu')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(menu.id)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Time off' }))
  })

  it('links are links, toggles are menuitemcheckboxes, buttons are typed', () => {
    open()
    const link = screen.getByRole('menuitem', { name: 'Time off' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/schedule/time-off')
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Select multiple' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('title')).toBe('Select multiple shifts')
  })

  it('arrow keys move and wrap, skipping the disabled item; Home and End jump', () => {
    open()
    const menu = screen.getByRole('menu')
    const focused = () => document.activeElement.textContent.trim()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focused()).toBe('Select multiple')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focused()).toBe('Copy last month')       // Copy last week is disabled
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focused()).toBe('Time off')              // wrapped
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(focused()).toBe('Copy last month')       // wrapped the other way
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(focused()).toBe('Time off')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(focused()).toBe('Copy last month')
  })

  it('Escape closes and returns focus to the button', () => {
    const { button } = open()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('choosing an item closes, returns focus to the button, then reports the key', () => {
    const { button, onSelect } = open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy last month' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('copy-month')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('a disabled item does nothing', () => {
    const { onSelect } = open()
    const item = screen.getByRole('menuitem', { name: 'Copy last week' })
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a click outside closes it; Tab closes it without stealing focus back', () => {
    open()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Space activates a link item, as it does a button item', () => {
    open()
    const link = screen.getByRole('menuitem', { name: 'Time off' })
    const clicked = vi.fn((e) => e.preventDefault())
    link.addEventListener('click', clicked)
    fireEvent.keyDown(link, { key: ' ' })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('ArrowDown on the closed button opens it', () => {
    render(<MoreMenu items={ITEMS} onSelect={() => {}} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('takes a label and an active state from its caller', () => {
    render(<MoreMenu items={ITEMS} onSelect={() => {}} label="Copying…" active />)
    const button = screen.getByRole('button', { name: 'Copying…' })
    expect(button.getAttribute('data-active')).toBe('true')
  })
})
