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
