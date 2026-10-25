// C146 TASKSNEEDCONTACTS.1 — the web Tasks page offers no write where the
// person cannot read Contacts at the studio (mig 700: the insert-and-read-back
// is refused and an update by id matches nothing). `canWrite` comes from the
// page's canWriteActivitiesAt; a missing flag is read-only (fails closed).
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

const { default: TasksPage } = await import('./TasksPage.jsx')

const TASK = { id: 't-1', subject: 'Call back', status: 'todo', kind: 'task' }
const render = (props) => renderToStaticMarkup(
  <TasksPage initialTasks={[TASK]} locationId="l-1" profiles={[]} projectsSeed={[]} {...props} />,
)

describe('TasksPage — writes follow canWrite', () => {
  it('offers New task when canWrite is true', () => {
    const html = render({ canWrite: true })
    expect(html).toContain('New task')
    expect(html).not.toContain('Read-only here')
  })

  it('offers no New task and says why when canWrite is false', () => {
    const html = render({ canWrite: false })
    expect(html).not.toContain('New task</button>')
    expect(html).toContain('Read-only here: tasks need Contacts access at this studio.')
    expect(html).toContain('Call back')
  })

  it('is read-only when canWrite is not passed', () => {
    expect(render({})).toContain('Read-only here')
  })
})

// TZ.11a — "overdue" is judged on the STUDIO's today (the page passes
// user.activeLocation.timezone), not Dublin's and not the browser's.
describe('TasksPage — overdue follows the studio zone (TZ.11a)', () => {
  const DUE = { id: 't-2', subject: 'Chase invoice', status: 'todo', kind: 'task', due_date: '2026-10-31' }
  const card = (props) => renderToStaticMarkup(
    <TasksPage initialTasks={[DUE]} locationId="l-1" profiles={[]} projectsSeed={[]} {...props} />,
  )
  it('1 Nov 03:30Z: overdue in Dublin (1 Nov), not yet in New York (31 Oct, 23:30 EDT)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-01T03:30:00Z'))
      expect(card({ timezone: 'Europe/Dublin' })).toContain('border-red-500/30')
      expect(card({})).toContain('border-red-500/30') // no zone: the Dublin floor, as before
      expect(card({ timezone: 'America/New_York' })).not.toContain('border-red-500/30')
    } finally {
      vi.useRealTimers()
    }
  })
})
