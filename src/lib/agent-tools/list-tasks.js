// MCP.1 — `list_tasks`: open tasks at the studio, the caller's own or
// everyone's, in a due window on the studio's calendar. Same gate as a web
// task write (canWriteActivitiesAt: web Tasks AND Contacts at the studio),
// the same rows as /activities (kind 'task') and the same shape as the task
// route's TASK_ROW (src/app/api/activities/tasks/route.js), with the columns
// named instead of `*` (so the task's free-text note stays out).

import { z } from 'zod'
import { defineTool } from './registry.js'
import { canWriteActivitiesAt } from '@/lib/activity-write-gate'
import { addDaysISO } from '@/lib/location-time'

const MAX_ROWS = 50
const TASK_COLUMNS = 'id, subject, type, due_date, due_time, priority, status, project, contact_id, assignee_id, '
  + 'contacts(id, name), profiles!activities_assignee_id_fkey(id, full_name)'

export default defineTool({
  name: 'list_tasks',
  title: 'Tasks',
  description: 'Open tasks at a studio. assignee: "me" (default) or "all". due: "overdue" (before today), '
    + '"today", or "week" (default: today and the next 6 days), on the studio\'s calendar. Tasks with no due date '
    + 'are not listed. Capped at 50 (capped is true when there are more). Needs the Tasks and Contacts permissions.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    assignee: z.enum(['me', 'all']).default('me').describe('"me" for tasks assigned to the caller, "all" for everyone\'s.'),
    due: z.enum(['overdue', 'today', 'week']).default('week').describe('The due window.'),
  }),
  gate: (user, studioId) => canWriteActivitiesAt(user, studioId),
  run: async (input, ctx) => {
    const { db, user, studio, today } = ctx
    // Filters first: supabase-js drops the filter methods once .order is in the chain.
    let query = db.from('activities')
      .select(TASK_COLUMNS)
      .eq('location_id', studio.id)
      .eq('kind', 'task')
      .eq('done', false)
    if (input.assignee === 'me') query = query.eq('assignee_id', user.id)
    if (input.due === 'overdue') query = query.lt('due_date', today)
    else if (input.due === 'today') query = query.eq('due_date', today)
    else query = query.gte('due_date', today).lte('due_date', addDaysISO(today, 6))

    const { data, error } = await query
      .order('due_date', { ascending: true })
      .order('id')
      .limit(MAX_ROWS + 1)
    if (error) throw new Error(`Failed to load tasks: ${error.message}`)
    const rows = data || []

    return {
      studio: { id: studio.id, name: studio.name },
      today,
      tasks: rows.slice(0, MAX_ROWS).map((t) => ({
        id: t.id,
        subject: t.subject,
        type: t.type,
        due_date: t.due_date,
        due_time: t.due_time,
        priority: t.priority,
        status: t.status,
        project: t.project,
        contact: t.contacts ? { id: t.contacts.id, name: t.contacts.name } : null,
        assignee: t.profiles ? { id: t.profiles.id, name: t.profiles.full_name } : null,
      })),
      capped: rows.length > MAX_ROWS,
    }
  },
})
