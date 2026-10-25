// @vitest-environment jsdom
//
// SETTINGSWIPE.1 — the Hyrox page discarded its locations read and passed
// resolveHyroxSettings(null): the DEFAULT charter, blank house style, no
// examples. Save then replaced the real house style and wiped the examples.
// The page now passes settingsUnreadable; the panel shows Could not load.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))
// HyroxBoard pulls next/font/local (not loadable under vitest); unrelated here.
vi.mock('@/components/HyroxBoard', () => ({ default: () => null }))

import HyroxPlanner from './HyroxPlanner.jsx'

const NOTE = 'Could not load the house style and examples just now, so nothing is shown and nothing can be changed here until it loads.'
const base = { initialBlock: null, initialSessions: [], locationId: 'loc1', canManage: true }
afterEach(() => cleanup())

describe('HyroxPlanner — house style panel', () => {
  it('settingsUnreadable: the note with a Try again link, no house-style form, no Save', () => {
    render(<HyroxPlanner {...base} initialSettings={null} settingsUnreadable />)
    expect(screen.getByText(NOTE)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe('/hyrox')
    expect(screen.queryByLabelText('House style')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('pin: a good read shows the form with Save', () => {
    render(<HyroxPlanner {...base} initialSettings={{ charter: 'C', houseStyle: 'H', styleExamples: [] }} />)
    expect(screen.getByLabelText('House style')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByText(NOTE)).toBeNull()
  })
})
