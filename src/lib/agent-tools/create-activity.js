// MCP.1 — `create_activity`: log a call or meeting, or set a task, on a
// contact. The in-app assistant's insert (src/app/api/assistant/chat/route.js),
// stamped with the studio. The contact must be readable (_contact-scope.js)
// AND at this studio: homed here or holding a contact_studios row here, the
// web task route's rule (taskLinksRefusal). Missing, unreadable or elsewhere
// is one not_found. The row is a task row as the web task route writes it
// (kind 'task', status 'todo', source 'crm'), assigned to the caller, so it
// shows on /activities and in the caller's list_tasks.
// Gate: a manager at the studio AND the web task-write rule there
// (canWriteActivitiesAt: Tasks AND Contacts).

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { contactReadableAt } from './_contact-scope.js'
import { isManagerAt } from '@/lib/mcp/context'
import { hasRelationshipAt } from '@/lib/contact-studios'
import { canWriteActivitiesAt } from '@/lib/activity-write-gate'
import { isRealCalendarDate } from '@/lib/schemas'

export default defineTool({
  name: 'create_activity',
  title: 'Create activity',
  description: 'Add a call, meeting or task to a contact at the studio (get the contact id from search_contacts), '
    + 'optionally with a due date and a note. This writes to the CRM: confirm with the user first and never retry '
    + 'on your own. For managers with the Tasks and Contacts permissions.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    contact_id: z.string().uuid().describe('The contact (search_contacts).'),
    type: z.enum(['call', 'meeting', 'task']).describe('call, meeting or task.'),
    subject: z.string().trim().min(1).max(500).describe('A short title.'),
    due_date: z.string().refine(isRealCalendarDate, 'due_date must be a real calendar date, YYYY-MM-DD').optional()
      .describe('Due date, YYYY-MM-DD, on the studio\'s calendar.'),
    note: z.string().max(5000).optional().describe('A longer note.'),
  }),
  gate: (user, studioId) => isManagerAt(user, studioId) && canWriteActivitiesAt(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const notHere = new ToolRefusal('not_found', 'Contact not found, or not at this studio.')
    const readableAt = await contactReadableAt(db, user, input.contact_id, ctx)
    if (!readableAt) throw notHere
    // contactReadableAt answers the home studio first, so any other answer
    // means the contact is homed elsewhere: it needs a row at this studio.
    if (readableAt !== studio.id) {
      const rel = await hasRelationshipAt(db, input.contact_id, [studio.id])
      if (!rel.ok) throw new Error(`Failed to load the contact's studios: ${rel.error}`)
      if (!rel.at.has(studio.id)) throw notHere
    }

    const record = {
      subject: input.subject,
      type: input.type,
      contact_id: input.contact_id,
      location_id: studio.id,
      due_date: input.due_date || null,
      note: input.note || null,
      done: false,
      assignee_id: user.id,
      kind: 'task',
      status: 'todo',
      source: 'crm',
    }
    const { data, error } = await db.from('activities').insert(record).select('id, subject, type, due_date').single()
    if (error || !data) throw new Error(`Failed to create the activity: ${error?.message || 'no row returned'}`)
    return { success: true, activity: { id: data.id, subject: data.subject, type: data.type, due_date: data.due_date } }
  },
})
