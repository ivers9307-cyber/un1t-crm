'use client'

// COMMS-WIDTH.1 — the /communications hub used to wrap everything in a
// centred `max-w-7xl` container. That boxed the full-height Inbox tool into
// the middle of wide monitors with big empty margins on either side.
//
// The whole hub is now LEFT-aligned (no `mx-auto`) so the header + tab bar
// sit at the same left position on every tab — otherwise the toolbar jumps
// horizontally between a centred content tab and the full-width Inbox. The
// Inbox route spans the full main-content width (everything right of the
// sidebar); the content tabs (Send, Sent, Templates, Segments) keep the
// readable `max-w-7xl` cap, just left-aligned. The tab bar caps itself
// (max-w-3xl) so it never stretches.

import { usePathname } from 'next/navigation'

export default function CommsShell({ children }) {
  const pathname = usePathname() || ''
  // EMAIL-TICKET.4 — the ticket inbox is the same shape of tool as the
  // unified inbox (three panes, full height), so it takes the full width for
  // the same reason: boxing it into max-w-7xl wastes the thread pane.
  // INBOX-SURFACE.C — /communications/mail is the same shape again (list +
  // reading pane, full height), so it takes the full width for the same
  // reason. Left out, it would be the one three-pane tool in this hub boxed
  // into max-w-7xl, and the toolbar would jump horizontally when an operator
  // moved between it and the ticket queue.
  const fullWidth = pathname.startsWith('/communications/inbox')
    || pathname.startsWith('/communications/tickets')
    || pathname.startsWith('/communications/mail')
  return (
    <div className={fullWidth ? 'p-6' : 'p-6 max-w-7xl'}>
      {children}
    </div>
  )
}
