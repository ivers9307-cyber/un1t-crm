// RETIRE-TICKETS.1 — the ticket queue is gone; Mail is the email surface.
//
// The mig-575 A/B ended 2026-08-29 with every mailbox on the mail surface and
// the queue UI deleted. This stub survives because the URL was live for
// months: home-queue rows, notification emails, bookmarks and the command
// palette all pointed here. A redirect keeps every one of those landing on
// the mail that used to be behind this path; a 404 would read as "our email
// is gone".
//
// The `email_tickets` DATA MODEL keeps its name — table, API routes and
// thread components are shared with the Mail surface and unchanged.

import { redirect } from 'next/navigation'

export default function RetiredTicketQueue() {
  redirect('/communications/mail')
}
