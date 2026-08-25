const legacyRedirects = require('./legacy-redirects')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // heic-convert (libheif-js WASM) decodes iPhone HEIC receipts — sharp's
  // prebuilt libvips has NO HEVC decoder. Keep it + its WASM dep external so
  // they load from node_modules at runtime on Vercel instead of being bundled
  // (bundling drops the .wasm and the decode fails). sharp is auto-externalised
  // by Next already.
  serverExternalPackages: ['heic-convert', 'libheif-js'],

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
  // The operator-internal ones (/races/*) get the same treatment
  // for muscle memory. (The E2 /events aliases are gone — see the
  // history note inside rewrites(); E3's real /events pages had
  // made them permanently-dead afterFiles config.)
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
      { source: '/stillorgan',         destination: '/welcome/stillorgan' },
      { source: '/hatch-street',       destination: '/welcome/hatch-street' },
      { source: '/stillorgan/events',  destination: '/welcome/stillorgan/events' },
      { source: '/hatch-street/events', destination: '/welcome/hatch-street/events' },

      // Apex marketing domain: when someone lands on the bare
      // un1tdublin.com root, serve the split chooser (/welcome) rather
      // than the CRM app root (which redirects to /login). Host-scoped
      // so crm.un1tdublin.com/ keeps serving the app. The www variant
      // is covered too in case it's pointed at the project.
      { source: '/', has: [{ type: 'host', value: 'un1tdublin.com' }],     destination: '/welcome' },
      { source: '/', has: [{ type: 'host', value: 'www.un1tdublin.com' }], destination: '/welcome' },

      // E2 history note: the old Calendly-templates aliases
      // (/events → /bookings/event-types, /events/new → …/new) were
      // REMOVED in June 2026 — they'd been dead config since E3
      // recreated /events and /events/new as real filesystem pages.
      // Plain-array rewrites are afterFiles, so the filesystem pages
      // always won and the aliases never fired; they just read as if
      // the Events feature was being redirected away. Old Calendly
      // /events/:id operator bookmarks were already 404 by design
      // (deliberately not aliased to avoid shadowing the new
      // event-detail routes — operators re-bookmark via "Bookings").

      // E3 back-compat: race operator URLs forever-aliased
      { source: '/races',                 destination: '/events' },
      { source: '/races/new',             destination: '/events/new' },
      // AUDIT-13.C — was '/events/:id', which is a hard 404: no
      // events/[id]/page.js exists under ANY route group, only the
      // checkin / control / edit / teams sub-routes. The Calendly-era
      // detail page lived there 2026-04-28 → 05-09 and nothing replaced
      // it, so this rule mapped a 404 to a 404. '/teams' is the entrants
      // view and the first link the Events list offers per event — the
      // same target src/lib/command-palette.js entityResult() picked for
      // exactly this reason (its K5 note). Every sibling above and below
      // was re-checked and resolves to a real page.
      { source: '/races/:id',             destination: '/events/:id/teams' },
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

  // ─── Back-compat redirects for relocated pages ───────────────────
  //
  // SIDEBAR-IA.1 — the radars moved from standalone sidebar pages to
  // dashboard tabs. Redirects (not rewrites) on purpose: the browser
  // URL should update to the canonical /dashboard/* path so the tab
  // strip + sidebar active states light up. Old links live in the
  // Monday radar digest emails and operator bookmarks. Non-permanent
  // (307) so the alias stays cheap to re-point if the IA evolves.
  async redirects() {
    return [
      { source: '/churn-radar', destination: '/dashboard/churn-radar', permanent: false },
      { source: '/lead-radar',  destination: '/dashboard/lead-radar',  permanent: false },
      // Pride Training Club: the Aug 2 link is out in the wild (socials,
      // old posts) and should land people on the next date. 307 on purpose
      // — the Aug 2 event still exists and is still published, so this is
      // a re-pointable alias, NOT a permanent move a browser should cache
      // forever. QUICK FIX (Richard, 2026-07-31): hardcoded because it was
      // needed immediately. The durable version is a re-pointable alias on
      // the event row so an operator can do this without a deploy.
      { source: '/event/pride-training-club-aug2', destination: '/event/pride-training-club-sep20', permanent: false },
      // PRUNE.1 — aliases for the deleted legacy stub pages (1:1 map,
      // see legacy-redirects.js + its test).
      ...legacyRedirects,
    ]
  },

  // Don't advertise the framework in every response.
  poweredByHeader: false,

  // ─── Security headers (AUDIT-JUN10.2) ────────────────────────────
  //
  // Baseline hardening for an app that serves authenticated CRM pages
  // AND public payment pages (deposit, event-pay) on custom domains.
  // Deliberately conservative — no CSP yet (that needs a report-only
  // soak first; see docs/PLATFORM_AUDIT_2026-06.md), no COOP/COEP
  // (nothing needs cross-origin isolation — ffmpeg.wasm runs the
  // single-threaded core).
  //
  // Frame-blocking exclusions: /embed/* exists precisely to be
  // iframed by third-party sites (event signup widget), and /book/*
  // may be iframed by gym marketing sites — both stay frameable.
  // Everything else (login, payment pages, the whole CRM) refuses
  // cross-origin framing (clickjacking protection).
  //
  // Mechanism: X-Frame-Options ships globally, then the two
  // embeddable subtrees get `CSP: frame-ancestors *`, which
  // supersedes X-Frame-Options in every modern browser (the
  // spec-defined override). Path-to-regexp lookaheads with anchors
  // are NOT used — verified to mis-match (`/bookings` lost the
  // header when `/book` was excluded via lookahead).
  async headers() {
    // NOT a global policy — applied ONLY to the two `frameable` sources at
    // the bottom of the returned list. Read in isolation this line looks
    // like the whole app is frameable by anyone; it isn't. Twice now a
    // reviewer has flagged it as an app-wide clickjacking hole (most
    // recently the email-ticketing spec, 2026-08-05).
    const frameable = [
      { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
    ]
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      { source: '/embed/:path*', headers: frameable },
      { source: '/book/:path*', headers: frameable },
    ]
  },
}

module.exports = nextConfig
