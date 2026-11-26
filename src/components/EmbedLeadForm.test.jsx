// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import EmbedLeadForm from './EmbedLeadForm'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EmbedLeadForm (EMBEDFORM.1)', () => {
  it('starts with the marketing box ticked', () => {
    render(<EmbedLeadForm publicPath="stillorgan" studioName="UN1T Stillorgan" />)
    expect(screen.getByRole('checkbox').checked).toBe(true)
  })

  it('posts form: embed with the box as set, and thanks the person', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EmbedLeadForm publicPath="stillorgan" studioName="UN1T Stillorgan" />)
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anne' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anne@example.ie' } })
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0871234567' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }))
    await waitFor(() => expect(screen.getByText(/on the list/)).toBeTruthy())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ public_path: 'stillorgan', form: 'embed', consent: false, first_name: 'Anne' })
  })

  it('asks for the missing fields without posting', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<EmbedLeadForm publicPath="stillorgan" studioName="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }))
    expect(screen.getByRole('alert').textContent).toMatch(/name, email and phone/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
