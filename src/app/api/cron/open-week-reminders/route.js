// OPENWEEK.7 — Vercel cron, every 15 minutes: the open week WhatsApp class
// reminders (src/lib/open-week-reminder-send.js). A run with nothing due is
// healthy and stamps; a whole studio's read failing is a failed run.
import { defineCron } from '@/lib/define-cron'
import { runOpenWeekReminders } from '@/lib/open-week-reminder-send'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = defineCron({ heartbeat: 'open-week-reminders' }, async ({ db }) => {
  const out = await runOpenWeekReminders(db)
  return { ok: out.ok, body: out, outcome: out }
})
