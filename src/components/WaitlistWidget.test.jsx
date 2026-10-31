// @vitest-environment jsdom
//
// PAGES.1 — WaitlistWidget: on a page it posts the page and its studio (the
// server takes the studio, tag and source from the page's studio row); off a
// page it posts public_path (+ campaign) exactly as before.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null }))

import WaitlistWidget from './WaitlistWidget'

let posts
let answer
beforeEach(() => {
  posts = []
  answer = { status: 200, body: { success: true, data: { already_on_list: false } } }
  global.fetch = vi.fn(async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body }
  })
})
afterEach(() => cleanup())

function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Ann' } })
  fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'ann@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
}

describe('WaitlistWidget', () => {
  it('off a page it posts public_path, as before, and never a campaign', async () => {
    render(<WaitlistWidget publicPath="stillorgan" campaign="stillorgan-free-class" />)
    fillAndSubmit()
    expect(await screen.findByText(/on the list/)).toBeTruthy()
    expect(posts[0].url).toBe('/api/public/leads')
    expect(posts[0].body).toMatchObject({ first_name: 'Ann', public_path: 'stillorgan' })
    expect(posts[0].body).not.toHaveProperty('campaign')
    expect(posts[0].body).not.toHaveProperty('page')
  })

  it('on a page it posts the page and its studio, never public_path or campaign', async () => {
    render(<WaitlistWidget publicPath="hatch-street" campaign="stillorgan-free-class" page="founders" />)
    fillAndSubmit()
    expect(await screen.findByText(/on the list/)).toBeTruthy()
    expect(posts[0].body).toMatchObject({ first_name: 'Ann', page: 'founders', studio: 'hatch-street' })
    expect(posts[0].body).not.toHaveProperty('public_path')
    expect(posts[0].body).not.toHaveProperty('campaign')
  })

  it('a not_found refusal shows the fallback, never the machine word', async () => {
    answer = { status: 404, body: { success: false, error: 'not_found' } }
    render(<WaitlistWidget publicPath="hatch-street" page="founders" />)
    fillAndSubmit()
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy()
    expect(screen.queryByText('not_found')).toBeNull()
  })
})
