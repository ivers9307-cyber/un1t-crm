// @vitest-environment jsdom
//
// ACTIVEUSER.1 — a DEACTIVATED staff member on /login.
//
// Their Supabase session is still valid (deactivation bans the login, but a
// ban can fail, is skipped for a login that is also a member's or a host's,
// and an access token outlives it by up to an hour). getCurrentUser() answers
// null for them, so every gated page redirects here — and this page used to
// say nothing, and "Sign in" with a correct password just bounced them back.
// No server-side loop exists (/login is public and never bounces a signed-in
// visitor), but a silent bounce with a live session is the client-side one.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const push = vi.fn()
const refresh = vi.fn()
let search = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}))

const auth = {
  getSession: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(async () => ({ error: null })),
}
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({ auth }) }))

import LoginPage from './page.js'
import { DEACTIVATED_MESSAGE } from '@/lib/login-account-state'

let accountState = 'unknown'
let stateCalls = 0
beforeEach(() => {
  vi.clearAllMocks()
  search = ''
  accountState = 'unknown'
  stateCalls = 0
  auth.getSession.mockResolvedValue({ data: { session: null } })
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/auth/account-state')) {
      stateCalls += 1
      return { ok: true, json: async () => ({ success: true, data: { state: accountState } }) }
    }
    return { ok: true, json: async () => ({ success: false }) }
  })
})
afterEach(cleanup)

const usePassword = async () => {
  fireEvent.click(screen.getByText('Sign in with a password instead'))
  fireEvent.change(screen.getByPlaceholderText('you@un1t.ie'), { target: { value: 'coach@example.test' } })
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('/login — landing with a live session', () => {
  it('no session: the account-state route is never asked, nobody is signed out', async () => {
    render(<LoginPage />)
    await waitFor(() => expect(auth.getSession).toHaveBeenCalled())
    expect(stateCalls).toBe(0)
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(screen.queryByText(DEACTIVATED_MESSAGE)).toBeNull()
  })

  it('deactivated: says so calmly and clears the LOCAL session only', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    accountState = 'deactivated'
    render(<LoginPage />)
    expect(await screen.findByText(DEACTIVATED_MESSAGE)).toBeTruthy()
    // Repo rule: never the default (global) scope — that would sign the
    // person's member app out on every device too.
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it.each(['active', 'unknown', 'signed_out'])('%s: a live session is left alone, and nothing is shown', async (state) => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    accountState = state
    render(<LoginPage />)
    await waitFor(() => expect(stateCalls).toBe(1))
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(screen.queryByText(DEACTIVATED_MESSAGE)).toBeNull()
  })

  it('a failing account-state call changes nothing (the page must still let people sign in)', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    global.fetch = vi.fn(async () => { throw new Error('offline') })
    render(<LoginPage />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(screen.getByText('Email me a login link')).toBeTruthy()
  })

  it('the notice survives switching sign-in mode (switchMode clears ordinary errors)', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    accountState = 'deactivated'
    render(<LoginPage />)
    await screen.findByText(DEACTIVATED_MESSAGE)
    fireEvent.click(screen.getByText('Sign in with a password instead'))
    expect(screen.getByText(DEACTIVATED_MESSAGE)).toBeTruthy()
  })

  it('never signs out once a login link has been requested from this page — signOut() deletes the PKCE code verifier', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    accountState = 'deactivated'
    let release
    global.fetch = vi.fn((url) => {
      if (String(url).includes('/api/auth/account-state')) {
        return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ success: true, data: { state: 'deactivated' } }) }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: false }) })
    })
    render(<LoginPage />)
    await waitFor(() => expect(release).toBeTypeOf('function'))
    fireEvent.change(screen.getByPlaceholderText('you@un1t.ie'), { target: { value: 'coach@example.test' } })
    fireEvent.click(screen.getByText('Email me a login link'))
    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled())
    release()
    expect(await screen.findByText(DEACTIVATED_MESSAGE)).toBeTruthy()
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('?error=account_deactivated seeds the same notice', async () => {
    search = 'error=account_deactivated'
    render(<LoginPage />)
    expect(screen.getByText(DEACTIVATED_MESSAGE)).toBeTruthy()
  })
})

describe('/login — password sign-in by a deactivated person', () => {
  it('BANNED login: GoTrue\'s raw "User is banned" becomes the calm message', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: 'User is banned', code: 'user_banned', status: 400 } })
    render(<LoginPage />)
    await usePassword()
    expect(await screen.findByText(DEACTIVATED_MESSAGE)).toBeTruthy()
    expect(screen.queryByText('User is banned')).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })

  it('UNBANNED login (a member\'s, or the ban failed): sign-in succeeds, so ask before navigating — no silent bounce', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null })
    accountState = 'deactivated'
    render(<LoginPage />)
    await usePassword()
    expect(await screen.findByText(DEACTIVATED_MESSAGE)).toBeTruthy()
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(push).not.toHaveBeenCalled()
  })

  it('an active account signs in exactly as before', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null })
    accountState = 'active'
    search = 'redirect=/contacts'
    render(<LoginPage />)
    await usePassword()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/contacts'))
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('an account-state failure never blocks a good sign-in', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null })
    global.fetch = vi.fn(async () => { throw new Error('offline') })
    render(<LoginPage />)
    await usePassword()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'))
  })

  it('a wrong password still reads as a wrong password', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials', status: 400 } })
    render(<LoginPage />)
    await usePassword()
    expect(await screen.findByText('Invalid login credentials')).toBeTruthy()
  })
})

describe('copy', () => {
  it('is calm, tells them what to do, and carries no em-dash', () => {
    expect(DEACTIVATED_MESSAGE).toBe('This account has been deactivated. Ask an owner to reactivate it.')
    expect(DEACTIVATED_MESSAGE).not.toMatch(/[—–]/)
  })
})
