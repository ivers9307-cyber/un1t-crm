// MULTIBRAND.1 — brand registry for the multi-domain middleware.
//
// The CRM runs on multiple hostnames sharing one Vercel deployment:
//
//   • crm.un1tdublin.com       — the staff CRM (default; auth-gated)
//   • un1tdublin.com / www.    — UN1T public marketing site
//   • pay.ccfautos.com         — CCF Autos buyer-facing payment pages
//
// Adding a third tenant brand (another gym, another car business,
// a partner studio's storefront, etc.) historically meant editing
// src/proxy.js to hand-code a third hostname branch. This
// registry moves that decision into data — adding a brand is one
// entry below; the proxy iterates and matches.
//
// Two response modes per brand:
//
//   • 'reject'  — fallback paths return 404 and root "/" is 404'd
//                 too. Use for buyer-facing payment subdomains that
//                 must not leak the CRM's existence (matches the
//                 historical pay.ccfautos.com behaviour).
//
//   • 'rewrite' — fallback paths rewrite to a marketing landing
//                 (default /welcome). Use for public marketing
//                 hostnames where strays should land somewhere
//                 useful rather than 404 (matches the historical
//                 un1tdublin.com behaviour).
//
// Both modes share an explicit allowedPaths allowlist — adding a
// public path is a deliberate decision, the same way it's always
// been.
//
// **CRM hostname is NOT in this registry.** When `resolveBrand`
// returns null, the middleware falls through to the existing CRM
// auth-gate path. That's the default and doesn't need a brand row.

// ─────────────────────────────────────────────────────────────────
// Registry
//
// Add a new tenant by appending an entry. Each one is independent.
// Env-overridable hostnames let previews / staging route to the
// same brand without redeploy — useful when a preview URL needs
// to act as the buyer-facing subdomain.
// ─────────────────────────────────────────────────────────────────

export const BRANDS = [
  // ─── CCF Autos — buyer-facing payment subdomain ────────────────
  // Customers reaching this hostname can ONLY hit deposit pages and
  // their backing public API. Everything else 404s — no CRM, no
  // marketing, nothing that hints another business shares the
  // deployment.
  {
    id: 'ccfautos-pay',
    description: 'CCF Autos buyer-facing payment subdomain',
    hostnames: (process.env.PAY_HOSTNAME || 'pay.ccfautos.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedPaths: ['/deposit/', '/api/public/deposit/'],
    rootHandler: 'reject',
    fallbackHandler: 'reject',
  },

  // ─── UN1T — public marketing site ──────────────────────────────
  // Apex + www. "/" rewrites to /welcome (the operator-editable
  // landing page from mig 126+). CRM-flavoured paths also rewrite
  // home rather than 404 — stray hits are typically typos / stale
  // links and the marketing page is the right landing place.
  {
    id: 'un1t-marketing',
    description: 'UN1T public marketing site (apex + www)',
    hostnames: (process.env.MARKETING_HOSTNAMES || 'un1tdublin.com,www.un1tdublin.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedPaths: [
      '/welcome',
      '/stillorgan',    // pretty path → next.config rewrites to /welcome/stillorgan
      '/hatch-street',  // pretty path → next.config rewrites to /welcome/hatch-street
      '/free-class',    // Stillorgan paid-traffic campaign landing page (src/app/free-class)
      '/start',         // Meta-ad booking wizard (src/app/start)
      '/privacy',       // GDPR privacy policy (waitlist consent link + App Store URL)
      '/terms',         // Terms of Service (Meta App Review + site footer)
      '/technical',     // Tech-provider service page (Meta Access Verification URL)
      '/book/',         // public Calendly-style booking pages
      '/event/',        // public race / workshop / etc. signup pages
      '/race/',         // race kiosk + signup
      '/api/public/',   // backing API for all of the above
      '/api/webhooks/', // future-proof if a payment redirect lands here
    ],
    rootHandler: 'rewrite',
    rootRewriteTo: '/welcome',
    fallbackHandler: 'rewrite',
    fallbackRewriteTo: '/welcome',
  },

  // ─── UN1T Hosts — third-party event host portal ────────────────
  // Hosts reaching this subdomain get ONLY their own scoped portal (/host/*)
  // + the ability to preview their public event/checkout pages. Everything
  // else 404s — no staff CRM, no marketing, nothing that hints at the shared
  // deployment. Auth is enforced INSIDE /host (host session via
  // getCurrentHost); the router just isolates the surface. (HOST-PORTAL.1)
  {
    id: 'un1t-hosts',
    description: 'UN1T third-party event host portal',
    hostnames: (process.env.HOST_PORTAL_HOSTNAME || 'host.un1tdublin.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedPaths: [
      '/host',        // the portal — login + gated dashboard pages
      '/api/host/',   // host-scoped API (getCurrentHost)
      '/event/',      // preview their own public event pages
      '/event-pay/',  // + the checkout
      '/h/',          // public mailing-list signup pages (HOST-EMAIL.2)
      '/api/public/', // backing API for the above (incl. /api/public/host-list/)
    ],
    // NOTE: login/sign-out talk to Supabase directly (client-side auth), so no
    // /api/auth route is allowlisted — least privilege on the host surface.
    rootHandler: 'rewrite',
    rootRewriteTo: '/host',
    fallbackHandler: 'reject',
  },

  // ─── Add another brand here ────────────────────────────────────
  // Copy any entry above: one { id, hostnames, allowedPaths, rootHandler,
  // fallbackHandler } object — no edit to proxy.js needed.
]

// ─────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────

/**
 * Match an incoming request hostname to a brand registry entry.
 * Returns null when the hostname is the default CRM hostname (or
 * anything else not in the registry) — middleware then falls
 * through to its CRM auth path.
 *
 * Port suffixes (`:3000`, `:8080`) are stripped before matching so
 * local dev + preview URLs work the same as production.
 *
 * @param {string} hostname  Raw value of the `Host` request header.
 * @returns {object | null}  Brand entry from BRANDS, or null.
 */
export function resolveBrand(hostname) {
  if (!hostname || typeof hostname !== 'string') return null
  const hostKey = hostname.split(':')[0]
  for (const brand of BRANDS) {
    if (brand.hostnames.some((h) => h.split(':')[0] === hostKey)) {
      return brand
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────
// Framework-asset detection
//
// Every brand allows Next.js's framework asset paths through — the
// app can't render CSS / JS / images without them. Centralised here
// so adding a new asset prefix is one edit, not three.
// ─────────────────────────────────────────────────────────────────

const FRAMEWORK_ASSET_PATHS = ['/_next/']
const FRAMEWORK_ASSET_FILES = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
])

export function isFrameworkAsset(path) {
  if (typeof path !== 'string') return false
  if (FRAMEWORK_ASSET_FILES.has(path)) return true
  return FRAMEWORK_ASSET_PATHS.some((p) => path.startsWith(p))
}
