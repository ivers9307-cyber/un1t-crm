// PAGES.1 — the slug rules for a landing page at /<slug>: what shape a slug
// may take and which names are reserved because an app route already owns
// them (a page at /settings would shadow the real /settings). Pure, no IO,
// importable from the client bundle: the editor pre-checks with it, and the
// API route is the authority. The design is
// docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md.
//
// RESERVED_PAGE_SLUGS is a static list so this file stays free of fs. The
// route segments in it are every top-level directory under src/app, route
// groups "(name)" walked, `[dynamic]` segments skipped.
// src/lib/page-slug.test.js walks the real src/app tree with
// tests/helpers/app-route-segments.js and fails when a new route segment is
// missing here: add the name to ROUTE_SEGMENTS, in the same PR as the route.

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/

// Names that are not app route directories but must never be a page: the
// Next.js internals and the public paths served by rewrites or files.
const FIXED_NAMES = [
  'api', '_next', 'welcome', 'login', 'settings', 'admin', 'offers', 'embed',
  'tv', 'present', 'host', 'h', 'book', 'event', 'race', 'deposit', 'legal',
  'privacy', 'terms',
]

const ROUTE_SEGMENTS = [
  'account', 'account-deletion', 'accounting', 'achievements',
  'activities', 'admin', 'api', 'api-docs', 'approvals', 'auth', 'automations',
  'bca', 'book', 'bookings', 'cancel', 'card-receipts', 'cars', 'challenges',
  'checklists', 'class-fees', 'class-pay', 'communications', 'contacts',
  'contracts', 'dashboard', 'deposit', 'embed', 'event', 'event-pay',
  'events', 'fee-appeal', 'givers', 'h', 'host', 'host-connect',
  'hyrox', 'invoices', 'issues', 'legal', 'live', 'login', 'maintenance',
  'marketing', 'members', 'money', 'oauth', 'offer-sales', 'offers', 'operations',
  'orders', 'pay-done', 'pay-link', 'pipeline', 'policies', 'portfolio',
  'preferences', 'present', 'presentations', 'privacy', 'pulse',
  'reset-password', 'sales', 'schedule', 'settings', 'studio-login',
  'studio-management', 'team', 'technical', 'terms', 'tv',
  'tv-displays', 'unsubscribe', 'use-the-app', 'view-email', 'welcome',
]

export const RESERVED_PAGE_SLUGS = new Set([...FIXED_NAMES, ...ROUTE_SEGMENTS])

// Lowercase, trimmed, or null when it is not a valid slug (2 to 40 characters,
// letters, digits and inner hyphens).
export function normaliseSlug(raw) {
  if (typeof raw !== 'string') return null
  const slug = raw.trim().toLowerCase()
  return SLUG_RE.test(slug) ? slug : null
}

// null when the slug is usable, else why not. 'invalid' is a shape problem,
// 'reserved' means an app route (or a fixed name) already owns it.
export function slugProblem(slug) {
  const normal = normaliseSlug(slug)
  if (!normal) return 'invalid'
  if (RESERVED_PAGE_SLUGS.has(normal)) return 'reserved'
  return null
}

/**
 * True when the path's FIRST segment is one of the page slugs. Exact on the
 * segment (`/stillorganx` is not `/stillorgan`); `/`, an empty segment and a
 * `_` segment are never pages, and neither is a reserved app segment: a row
 * slugged `settings` (hand-made, or written before the name was reserved)
 * must never open /settings to the public. Pure, so AppShell (a client
 * component) can share it with the proxy's isPublicPagePath.
 */
export function publicPageSegmentMatches(pathname, slugs) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || !Array.isArray(slugs) || !slugs.length) return false
  const segment = pathname.slice(1).split('/')[0]
  if (!segment || segment.startsWith('_')) return false
  if (RESERVED_PAGE_SLUGS.has(segment)) return false
  return slugs.includes(segment)
}

// A retired page's redirect target: a path on this host only. `//evil.com`
// (protocol-relative) and `/\evil.com` would send visitors off-site through
// redirect(). The publish route's schema (landing-page-schemas.js) and the
// editor's Retire form (PageHeaderCard) both judge with this one pattern.
export const REDIRECT_PATH_RE = /^\/(?![\/\\])[a-z0-9\-\/?=&._%]*$/i
