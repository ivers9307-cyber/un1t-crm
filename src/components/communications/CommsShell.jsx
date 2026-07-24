'use client'

// COMMS-WIDTH.1 — the /communications hub wraps everything in a centred
// `max-w-7xl` container. That suits the content tabs (Send, Sends,
// Templates, Segments — forms and tables read better narrow), but it boxes
// the full-height Inbox tool into the middle of wide monitors with big
// empty margins on either side.
//
// Make the Inbox route span the full main-content width (everything right
// of the sidebar), while every other tab keeps the readable cap. The tab
// bar caps itself (max-w-3xl) so it stays left-aligned either way.

import { usePathname } from 'next/navigation'

export default function CommsShell({ children }) {
  const pathname = usePathname() || ''
  const fullWidth = pathname.startsWith('/communications/inbox')
  return (
    <div className={fullWidth ? 'p-6' : 'p-6 max-w-7xl mx-auto'}>
      {children}
    </div>
  )
}
