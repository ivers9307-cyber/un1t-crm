// @vitest-environment jsdom
//
// C148 ACTWRITEGATEWEB.1 — the web task writes post to the service-role
// routes (judged on the WEB rule) instead of writing `activities` through the
// browser client (judged by RLS on the PHONE keys). A refusal is shown, never
// a silent success: the Tasks board puts the old status back, the forms stay
// open with the route's message.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
// None of these components may touch the browser client any more.
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => { throw new Error('browser client used') } }))
vi.mock('./SequencePicker', () => ({ default: () => null }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))

import TasksPage from './TasksPage'
import ContactActions from './ContactActions'
import PersonActionBar from './PersonActionBar'

const LOC = 'b0000000-0000-4000-8000-00000000000b'
const C1 = 'c1000000-0000-4000-8000-000000000001'
const REFUSED = { ok: false, status: 403, body: { success: false, error: 'No Tasks permission at this location' } }

let calls
let answer
beforeEach(() => {
  calls = []
  refresh.mockClear()
  answer = { ok: true, status: 200, body: { success: true, data: { id: 't-new', subject: 'New one', status: 'todo', kind: 'task' } } }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null })
    if (answer instanceof Error) throw answer
    return { ok: answer.ok, status: answer.status, json: async () => answer.body }
  }))
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('TasksPage (C148)', () => {
  const TASK = { id: 't-1', subject: 'Call back', status: 'todo', kind: 'task' }
  const open = () => {
    render(<TasksPage initialTasks={[TASK]} locationId={LOC} profiles={[]} projectsSeed={[]} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: /list/i }))
  }

  it('a status toggle posts to the task\'s status route', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle done' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ url: '/api/activities/tasks/t-1/status', method: 'POST', body: { status: 'done' } })
    expect(alert).not.toHaveBeenCalled()
  })

  it('a refused status change goes back and says why', async () => {
    answer = REFUSED
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle done' }))
    await waitFor(() => expect(alert).toHaveBeenCalledWith('No Tasks permission at this location'))
    expect(screen.getByText('Call back').className).not.toMatch(/line-through/)
  })

  it('New task posts the form with the page\'s studio and shows the saved row', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /new task/i }))
    fireEvent.change(screen.getByPlaceholderText(/follow up with/i), { target: { value: 'New one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(screen.getByText('New one')).toBeTruthy())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/activities/tasks')
    expect(calls[0].body).toMatchObject({ location_id: LOC, subject: 'New one', type: 'task' })
    expect(calls[0].body).not.toHaveProperty('kind')
  })

  it('a refused New task keeps the form open with the route\'s message', async () => {
    answer = REFUSED
    open()
    fireEvent.click(screen.getByRole('button', { name: /new task/i }))
    fireEvent.change(screen.getByPlaceholderText(/follow up with/i), { target: { value: 'New one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(screen.getByText(/No Tasks permission at this location/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Create task' })).toBeTruthy()
  })
})

describe('ContactActions Activity form (C148)', () => {
  const submit = () => {
    render(<ContactActions contactId={C1} locationId={LOC} canTask />)
    fireEvent.click(screen.getByRole('button', { name: /activity/i }))
    fireEvent.change(screen.getByPlaceholderText('Follow up with lead'), { target: { value: 'Ring about renewal' } })
    fireEvent.submit(screen.getByPlaceholderText('Follow up with lead').closest('form'))
  }

  it('posts the contact\'s task to the route and refreshes', async () => {
    submit()
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/activities/tasks')
    expect(calls[0].body).toMatchObject({ contact_id: C1, location_id: LOC, subject: 'Ring about renewal', type: 'call' })
  })

  it('a refusal stays open and shows the route\'s error', async () => {
    answer = REFUSED
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No Tasks permission at this location'))
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Follow up with lead')).toBeTruthy()
  })
})

describe('PersonActionBar Task item (C148)', () => {
  const submit = () => {
    render(<PersonActionBar contactId={C1} locationId={LOC} actions={['task']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /task/i }))
    fireEvent.change(screen.getByPlaceholderText('Follow up with lead'), { target: { value: 'Check in' } })
    fireEvent.submit(screen.getByPlaceholderText('Follow up with lead').closest('form'))
  }

  it('posts the task to the route and refreshes', async () => {
    submit()
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/activities/tasks')
    expect(calls[0].body).toMatchObject({ contact_id: C1, location_id: LOC, subject: 'Check in', type: 'call' })
  })

  it('a refusal stays open and shows the route\'s error', async () => {
    answer = REFUSED
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No Tasks permission at this location'))
    expect(refresh).not.toHaveBeenCalled()
  })
})
