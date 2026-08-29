'use client'

// MAIL-DRAFTSCOPE.2 — who is signed in, from the browser's own session.
//
// The reply-draft store keys on the USER (see mail-display.js's
// replyDraftKey), and the composer is rendered several layers below anything
// that holds the server-resolved user, so threading the id down as a prop
// would touch TicketThread, MailSurface AND TicketInbox for one string.
// Instead the composer asks the browser supabase client, which reads the
// session from its own storage — cheap, local, and already the identity the
// whole app runs on.
//
// CACHED MODULE-WIDE, as a promise: every composer mount shares one
// resolution per page load, and callers awaiting mid-flight share the same
// in-flight promise rather than stampeding getSession.
//
// 🔴 RESOLVES null ON ANY FAILURE, NEVER THROWS — and null means the draft
// store FAILS CLOSED (no persistence), not that it falls back to an unscoped
// key some other signed-in user could hydrate. Losing persistence in a
// broken-session edge case is the cheaper failure by far.

import { createBrowserClient } from '@/lib/supabase'

let cached

export function resolveViewerId() {
  if (!cached) {
    cached = (async () => {
      try {
        const { data } = await createBrowserClient().auth.getSession()
        return data?.session?.user?.id || null
      } catch {
        return null
      }
    })()
  }
  return cached
}

/** Test seam only — a fresh module-level cache per test. */
export function __resetViewerIdForTests() {
  cached = undefined
}
