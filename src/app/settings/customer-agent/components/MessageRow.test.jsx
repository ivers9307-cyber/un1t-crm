// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useState } from 'react'
import MessageRow from './MessageRow'
import MessagesSection from '../sections/MessagesSection'
import { fieldsFor } from '../fields'

afterEach(cleanup)

const CTX = { membershipSourceKey: 'un1t_online', bookings: true, brand: { companyName: 'Acme', shortName: 'Acme' }, agentName: 'Zoe' }
const field = fieldsFor('studio', 'messages', CTX)[0]
const label = typeof field.label === 'function' ? field.label(CTX) : field.label

function Host({ value, disabled }) {
  const [open, setOpen] = useState(false)
  return <MessageRow field={field} ctx={CTX} value={value} tag={<span>TAG</span>} open={open}
    onToggle={() => setOpen((o) => !o)} onChange={vi.fn()} disabled={disabled} />
}

describe('MessageRow', () => {
  it('folded: shows the value as the preview, with the tag', () => {
    render(<Host value="Hello there" />)
    expect(screen.getByTestId('message-preview').textContent).toBe('Hello there')
    expect(screen.getByText('TAG')).toBeTruthy()
    expect(screen.queryByLabelText(label)).toBeNull()
  })
  it('folded and blank: shows the default (placeholder) muted', () => {
    render(<Host value="" />)
    const p = screen.getByTestId('message-preview')
    expect(p.textContent.length).toBeGreaterThan(0)
    expect(p.className).toContain('text-un1t-muted')
  })
  it('click opens the field', () => {
    render(<Host value="x" />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }))
    expect(screen.getByLabelText(label)).toBeTruthy()
  })
})

function agentFor(ctx, extra = {}) {
  return {
    settings: {}, overridden: [], ctx, setField: vi.fn(), sourceTag: () => null, ...extra,
  }
}

describe('MessagesSection', () => {
  it('hides the Hatch group at a Glofox studio', () => {
    const ctx = { ...CTX, membershipSourceKey: 'glofox' }
    render(<MessagesSection agent={agentFor(ctx)} canEdit />)
    expect(screen.queryByTestId('hatch-copy-group')).toBeNull()
    cleanup()
    render(<MessagesSection agent={agentFor(CTX)} canEdit />)
    expect(screen.getByTestId('hatch-copy-group')).toBeTruthy()
  })
  it('editing calls setField for the opened row', () => {
    const agent = agentFor(CTX)
    render(<MessagesSection agent={agent} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }))
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'New' } })
    expect(agent.setField).toHaveBeenCalledWith(field.paths[0], 'New')
  })
  it('Review Focus 1: search, fold and row toggles work when canEdit is false; open field is disabled', () => {
    render(<MessagesSection agent={agentFor(CTX)} canEdit={false} />)
    const search = screen.getByLabelText('Search messages')
    expect(search.disabled).toBe(false)
    fireEvent.change(search, { target: { value: 'zzzznomatch' } })
    expect(screen.getByText('No messages match.')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    const groupBtn = screen.getAllByRole('button', { expanded: true })[0]
    fireEvent.click(groupBtn)
    expect(groupBtn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(groupBtn)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }))
    expect(screen.getByLabelText(label).matches(':disabled')).toBe(true)
  })
})
