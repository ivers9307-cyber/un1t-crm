/** @type {import('next').NextConfig} */
const nextConfig = {
  // ─── Back-compat rewrites for relocated URL spaces ───────────────
  //
  // The /events URL space used to belong to Calendly's bookable
  // templates feature ("event types"). In E2 of the events expansion
  // it relocated to /bookings/event-types/* so the word "Events" and
  // the /events URL prefix could be claimed by the new multi-kind
  // events feature (race + workshop + seminar + open_day + masterclass).
  //
  // These rewrites keep operator bookmarks against the old paths
  // working forever — they're internal admin pages, not public
  // signup links, but breaking them is unnecessary friction.
  //
  // Notes on placement:
  //   - In afterFiles mode (the default for an array return), these
  //     rewrites only fire when no filesystem route matches. The
  //     /events filesystem under src/app/events/ is being deleted in
  //     this same commit, so /events/* will fall through to these
  //     rewrites cleanly.
  //   - When E3 lands the multi-kind events feature at /events/*,
  //     these rewrites stay because a NEW /events/* file route in
  //     afterFiles mode wins over them. The rewrites only catch the
  //     specific old paths that don't match any new file route
  //     (e.g. /events/[uuid]/edit when the new feature uses slugs).
  //
  // What's NOT aliased and why:
  //   /api/events/* — once the new multi-kind events API lives at
  //   /api/events/*, an alias from /api/events/* → /api/bookings/
  //   event-types/* would silently shadow legitimate new endpoints.
  //   If an external integration was hitting /api/events/[id], it
  //   needs to update to /api/bookings/event-types/[id] explicitly.
  //   Internal callers are all updated in this commit.
  async rewrites() {
    return [
      // Operator pages — old Calendly templates URLs forever-aliased
      { source: '/events',           destination: '/bookings/event-types' },
      { source: '/events/new',       destination: '/bookings/event-types/new' },
      { source: '/events/:id',       destination: '/bookings/event-types/:id' },
      { source: '/events/:id/edit',  destination: '/bookings/event-types/:id/edit' },
    ]
  },
}

module.exports = nextConfig
