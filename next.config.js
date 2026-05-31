/** @type {import('next').NextConfig} */
const nextConfig = {
  // ─── Back-compat rewrites for relocated URL spaces ───────────────
  //
  // The events expansion moved two URL spaces:
  //
  //   E2 — Calendly's bookable templates ("event types") relocated
  //        from /events/* to /bookings/event-types/* so the word
  //        "Events" and the /events URL prefix could be claimed by
  //        the new multi-kind events feature.
  //
  //   E3 — The race events feature (originally at /races/* and the
  //        public /race/[slug], /race-pay) relocated to /events/*,
  //        /event/[slug], /event-pay so its URL space matches the
  //        new "Events" naming. Same race_events table on disk;
  //        files moved.
  //
  // The rewrites here keep old URLs working forever. Critical for
  // the public-facing ones (/race/[slug], /race-pay/[paymentId])
  // because operators have shared signup links via email, calendar,
  // social posts, and QR codes — breaking them is unacceptable.
  // The operator-internal ones (/races/*, /events/*) get the same
  // treatment for muscle memory.
  //
  // What's NOT aliased and why:
  //   /api/cron/race-timing-events — Vercel cron config in vercel.json
  //     references this exact path; race-specific by definition.
  //   /api/registrations/[id]/race-{start,finish,reset} — race-day
  //     control operations; race-specific. Will gate on kind='race'
  //     in E7.
  //   /api/webhooks/revolut/race-payments — Revolut's outbound webhook
  //     URL is configured against this exact path. Aliasing means
  //     asking Revolut to update on their side, friction without
  //     benefit (not user-facing).
  async rewrites() {
    return [
      // ─── Two-location marketing site (un1tdublin.com split) ───────
      // Clean public URLs for each studio's landing page. The split
      // chooser lives at /welcome; these map the pretty paths to the
      // per-studio pages (resolved by landing_page_settings.public_path).
      { source: '/stillorgan',    destination: '/welcome/stillorgan' },
      { source: '/hatch-street',  destination: '/welcome/hatch-street' },

      // Apex marketing domain: when someone lands on the bare
      // un1tdublin.com root, serve the split chooser (/welcome) rather
      // than the CRM app root (which redirects to /login). Host-scoped
      // so crm.un1tdublin.com/ keeps serving the app. The www variant
      // is covered too in case it's pointed at the project.
      { source: '/', has: [{ type: 'host', value: 'un1tdublin.com' }],     destination: '/welcome' },
      { source: '/', has: [{ type: 'host', value: 'www.un1tdublin.com' }], destination: '/welcome' },

      // E2 back-compat: old Calendly templates URLs forever-aliased
      { source: '/events',           destination: '/bookings/event-types' },
      { source: '/events/new',       destination: '/bookings/event-types/new' },
      // Note: /events/:id and /events/:id/edit would now collide with
      // the new multi-kind events feature filesystem. /bookings/event-
      // types/:id remains reachable directly; old operator-bookmark
      // paths /events/:id are intentionally NOT aliased to avoid
      // shadowing legitimate new event-detail routes. Old links go
      // 404 — operators re-bookmark via the sidebar's "Bookings"
      // entry. Acceptable because Calendly /events/[id] URLs are
      // operator-internal admin pages, not externally shared.

      // E3 back-compat: race operator URLs forever-aliased
      { source: '/races',                 destination: '/events' },
      { source: '/races/new',             destination: '/events/new' },
      { source: '/races/:id',             destination: '/events/:id' },
      { source: '/races/:id/edit',        destination: '/events/:id/edit' },
      { source: '/races/:id/control',     destination: '/events/:id/control' },
      { source: '/races/:id/teams',       destination: '/events/:id/teams' },

      // E3 back-compat: race public-facing URLs forever-aliased
      // (these are the critical ones — shared externally)
      { source: '/race/:slug',                  destination: '/event/:slug' },
      { source: '/race/:slug/confirmed',        destination: '/event/:slug/confirmed' },
      { source: '/race/:slug/display',          destination: '/event/:slug/display' },
      { source: '/race-pay/:paymentId',         destination: '/event-pay/:paymentId' },

      // E3 back-compat: race operator + public APIs forever-aliased
      { source: '/api/races',                                   destination: '/api/events' },
      { source: '/api/races/:id',                               destination: '/api/events/:id' },
      { source: '/api/races/:id/control-board',                 destination: '/api/events/:id/control-board' },
      { source: '/api/races/:id/teams',                         destination: '/api/events/:id/teams' },
      { source: '/api/races/:id/logo',                          destination: '/api/events/:id/logo' },
      { source: '/api/race-registrations/:id',                  destination: '/api/event-registrations/:id' },
      { source: '/api/contacts/:id/races',                      destination: '/api/contacts/:id/events' },
      { source: '/api/public/races/:slug',                      destination: '/api/public/events/:slug' },
      { source: '/api/public/races/:slug/register',             destination: '/api/public/events/:slug/register' },
      { source: '/api/public/races/:slug/check-member',         destination: '/api/public/events/:slug/check-member' },
      { source: '/api/public/races/:slug/display',              destination: '/api/public/events/:slug/display' },
      { source: '/api/public/race-registrations/:id',           destination: '/api/public/event-registrations/:id' },
      { source: '/api/public/race-payments/:id',                destination: '/api/public/event-payments/:id' },
    ]
  },
}

module.exports = nextConfig
