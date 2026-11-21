// withHostAuth — the host portal's route wrapper (HOSTCHECKIN.1), the host
// twin of withAuth (src/lib/with-auth.js), which is for staff sessions only.
//
//   export const POST = withHostAuth(async ({ session, host, db, request, params }) => { … })
//
// It signs the host in (getCurrentHost: Supabase session → host_users →
// event_hosts; null for staff), answers 401 without one, resolves `params`,
// and catches a throwing handler with a fixed 500, logged, so database text
// never reaches the browser. Scoping to the host's OWN rows stays in each
// route (an event of another host is 404).
import { NextResponse } from 'next/server'
import { getCurrentHost } from './host-auth'
import { createServerClient } from './supabase'
import { logError } from './log'

export function withHostAuth(handler) {
  if (typeof handler !== 'function') throw new TypeError('withHostAuth(handler): handler must be a function')
  return async function hostHandler(request, ctx) {
    try {
      const session = await getCurrentHost()
      if (!session?.host?.id) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      const params = ctx?.params ? await ctx.params : undefined
      return await handler({ session, host: session.host, db: createServerClient(), request, params })
    } catch (err) {
      let route = null
      try { route = new URL(request.url).pathname } catch { /* no url */ }
      logError('api', 'host route failed', { route, method: request?.method, err })
      return NextResponse.json({ success: false, error: 'Something went wrong. Try again.' }, { status: 500 })
    }
  }
}
