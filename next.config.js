/** @type {import('next').NextConfig} */
const nextConfig = {
  // ─── /events/* URL aliases for the multi-kind events feature ─────
  //
  // Background: the race feature is being expanded into a generic
  // "events" feature (race, workshop, seminar, open_day, masterclass)
  // — see mig 122 for the schema discriminator. The architectural
  // decision is "URL + UI rename only, keep DB names internally", so
  // we ALIAS /events/* to the existing /races/* handlers rather than
  // moving files around.
  //
  // Two principles:
  //   1. Existing /races/*, /race/[slug] and /race-pay URLs MUST keep
  //      working forever — operators have shared signup links via
  //      email, calendars, social posts. Breaking them is unacceptable.
  //      We do NOT add redirects from /races → /events; both surfaces
  //      stay reachable.
  //   2. The canonical user-facing URL for new event links is /events
  //      (operator) and /event/[slug] (public signup). Sidebar +
  //      EventForm-generated links use the new paths starting in E3+.
  //
  // What's NOT aliased and why:
  //   - /api/webhooks/revolut/race-payments: Revolut's webhook URL is
  //     configured in their dashboard against this exact path. Aliasing
  //     would require asking Revolut to update the URL on their side,
  //     which is friction without benefit (the webhook isn't user-
  //     facing).
  //   - /api/cron/race-timing-events: Vercel cron config in vercel.json
  //     references this exact path. Race-specific by definition (other
  //     event kinds aren't timed) so renaming would only confuse.
  //   - /api/registrations/[id]/race-{start,finish,reset}: race-day
  //     control operations. Race-specific. Will 404 / no-op for non-
  //     race kinds in E7.
  async rewrites() {
    return [
      // Operator pages
      { source: '/events', destination: '/races' },
      { source: '/events/:path*', destination: '/races/:path*' },

      // Public signup + payment
      { source: '/event/:slug', destination: '/race/:slug' },
      { source: '/event-pay', destination: '/race-pay' },
      { source: '/event-pay/:path*', destination: '/race-pay/:path*' },

      // Operator APIs
      { source: '/api/events', destination: '/api/races' },
      { source: '/api/events/:path*', destination: '/api/races/:path*' },
      { source: '/api/event-registrations', destination: '/api/race-registrations' },
      { source: '/api/event-registrations/:path*', destination: '/api/race-registrations/:path*' },
      { source: '/api/contacts/:id/events', destination: '/api/contacts/:id/races' },

      // Public APIs (signup widget + payment flow)
      { source: '/api/public/events', destination: '/api/public/races' },
      { source: '/api/public/events/:path*', destination: '/api/public/races/:path*' },
      { source: '/api/public/event-registrations', destination: '/api/public/race-registrations' },
      { source: '/api/public/event-registrations/:path*', destination: '/api/public/race-registrations/:path*' },
      { source: '/api/public/event-payments', destination: '/api/public/race-payments' },
      { source: '/api/public/event-payments/:path*', destination: '/api/public/race-payments/:path*' },
    ]
  },
}

module.exports = nextConfig
