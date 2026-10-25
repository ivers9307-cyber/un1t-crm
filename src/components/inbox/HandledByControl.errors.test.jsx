// @vitest-environment jsdom
//
// C126 INBOXCONTROLS.1 — HandledByControl swallowed every failure: a non-OK
// answer (a 403 from the web-only /agent route, say) or a network error left
// the buttons as they were and said nothing, so the operator thought Mia had
// been paused. It now shows the route's error, and a later success clears it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import HandledByControl from './HandledByControl'

const conv = { id: 'c1', agent_paused_at: null }
let answer
beforeEach(() => {
  answer = { ok: true, status: 200, body: { success: true } }
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return { ok: answer.ok, status: answer.status, json: async () => answer.body }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const pressYou = () => fireEvent.click(screen.getByRole('button', { name: /you/i }))

describe('HandledByControl surfaces a failed hand-over (C126)', () => {
  it('a 403 shows the route\'s error and onChanged is not called', async () => {
    answer = { ok: false, status: 403, body: { success: false, error: 'Forbidden — inbox permission required' } }
    const onChanged = vi.fn()
    render(<HandledByControl channel="wa" conversation={conv} onChanged={onChanged} />)
    pressYou()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Forbidden — inbox permission required'))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a 200 with success:false is a failure too', async () => {
    answer = { ok: true, status: 200, body: { success: false, error: 'Conversation not found' } }
    render(<HandledByControl channel="wa" conversation={conv} />)
    pressYou()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Conversation not found'))
  })

  it('a network error says so', async () => {
    answer = new Error('Failed to fetch')
    render(<HandledByControl channel="wa" conversation={conv} />)
    pressYou()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not change who handles this thread/i))
  })

  it('an unreadable error body still says something', async () => {
    answer = { ok: false, status: 500, body: undefined }
    render(<HandledByControl channel="wa" conversation={conv} />)
    pressYou()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not change who handles this thread/i))
  })

  it('a success calls onChanged and shows no error; it clears an earlier one', async () => {
    answer = { ok: false, status: 500, body: { success: false, error: 'boom' } }
    const onChanged = vi.fn()
    render(<HandledByControl channel="wa" conversation={conv} onChanged={onChanged} />)
    pressYou()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    answer = { ok: true, status: 200, body: { success: true } }
    pressYou()
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
