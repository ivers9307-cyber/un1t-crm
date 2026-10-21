// @vitest-environment jsdom
//
// VISREFRESH.1 — selection and the bulk toolbar on the contacts table keep
// their semantics through the restyle: select one, select all, the
// toolbar names its count, Merge needs exactly two and the owner flag,
// Delete needs the delete flag, and clearing empties the selection.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

vi.mock('next/dynamic', () => ({ default: () => () => null }))

import ContactsTable from './ContactsTable.jsx'

const ROWS = [
  { id: 'c1', name: 'Ava Byrne', email: 'ava@example.com', phone: '0851', pipeline_stage_slug: 'new_lead', trial_credits_remaining: 2 },
  { id: 'c2', name: 'Ben Cole', email: 'ben@example.com', phone: '0852', pipeline_stage_slug: 'member', trial_credits_remaining: null },
  { id: 'c3', name: 'Cara Doyle', email: 'cara@example.com', phone: '0853', pipeline_stage_slug: 'dormant', trial_credits_remaining: 0 },
]

afterEach(cleanup)

describe('ContactsTable selection and bulk toolbar', () => {
  it('no toolbar until a row is selected; then it names the count', () => {
    render(<ContactsTable contacts={ROWS} locationId="loc-1" />)
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull()
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Ava Byrne' })[0])
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' })
    expect(within(bar).getByText('1 selected')).toBeTruthy()
    expect(within(bar).getByRole('button', { name: /add to sequence/i })).toBeTruthy()
  })

  it('Merge shows only for a merger with exactly two selected; Delete only for a deleter', () => {
    render(<ContactsTable contacts={ROWS} locationId="loc-1" canMerge canDelete />)
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Ava Byrne' })[0])
    let bar = screen.getByRole('toolbar', { name: 'Bulk actions' })
    expect(within(bar).queryByRole('button', { name: /merge/i })).toBeNull()
    expect(within(bar).getByRole('button', { name: /delete/i })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Ben Cole' })[0])
    bar = screen.getByRole('toolbar', { name: 'Bulk actions' })
    expect(within(bar).getByRole('button', { name: /merge/i })).toBeTruthy()
    expect(within(bar).getByText('2 selected')).toBeTruthy()
  })

  it('without the flags, neither Merge nor Delete is offered', () => {
    render(<ContactsTable contacts={ROWS} locationId="loc-1" />)
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Ava Byrne' })[0])
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Ben Cole' })[0])
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' })
    expect(within(bar).queryByRole('button', { name: /merge/i })).toBeNull()
    expect(within(bar).queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('Select all selects every row; Clear selection removes the toolbar', () => {
    render(<ContactsTable contacts={ROWS} locationId="loc-1" />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull()
  })

  it('every row links to its contact by name and by the open control', () => {
    render(<ContactsTable contacts={ROWS} locationId="loc-1" />)
    expect(screen.getAllByRole('link', { name: 'Ava Byrne' })[0].getAttribute('href')).toBe('/contacts/c1')
    expect(screen.getByRole('link', { name: 'Open Ava Byrne' }).getAttribute('href')).toBe('/contacts/c1')
  })
})
