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
//
// **SAAS-8 — this registry is the FIRST of two tiers.** When it
// misses, the proxy consults the tenant_domains table (mig 415) via
// src/lib/tenant-domains-edge.js, so a NEW tenant's domain needs no
// code deploy — a row is enough. The entries below stay in-code on
// purpose: they are the guaranteed fallback for the live hostnames
// (byte-identical behaviour even with the DB down) and must NOT be
// duplicated as tenant_domains rows (dual-source drift; the admin
// API refuses such rows).

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
      '/offers',        // OFFERS.7: weekend "lock in" sale pages (src/app/offers)
      '/privacy',       // GDPR privacy policy (waitlist consent link + App Store URL)
      '/terms',         // Terms of Service (Meta App Review + site footer)
      '/legal/',        // SAAS4-C4: /legal/subprocessors (public subprocessor register)
      '/technical',     // Tech-provider service page (Meta Access Verification URL)
      // PUBPATH.1 — /account-deletion is the Google Play "Account Deletion URL"
      // + Apple 5.1.1(v) page, and BOTH public privacy pages link to it with a
      // host-relative href (/privacy → src/app/privacy/page.js, /privacy/members
      // → .../members/page.js — both allowlisted above). Without this entry that
      // link, followed on un1tdublin.com, fallback-rewrote to /welcome: the
      // policy promised a deletion page and delivered the studio chooser.
      '/account-deletion',
      // PUBPATH.1 — the paste-anywhere event-signup iframe. Its own header
      // documents the snippet as <iframe src="https://un1tdublin.com/embed/
      // event/<slug>"> — i.e. THIS host — and it was allowlisted in proxy.js
      // but not here, so on the marketing host every third-party embed
      // rewrote to /welcome. Trailing slash: the brand matcher is a raw
      // startsWith, and only /embed/* is meant to resolve.
      '/embed/',
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

  // ─── CCF Autos — public marketing site (coming soon) ───────────
  // Apex + www. "/" rewrites to /ccf (the coming-soon landing page,
  // src/app/ccf) so the URL bar stays clean. Strays rewrite back to
  // the landing rather than 404 — public marketing host, the
  // un1t-marketing pattern, not the buyer-payment 'reject' pattern.
  // Only the landing + its enquiry API resolve on this hostname, so
  // nothing hints at the CRM. In-code (not a tenant_domains row)
  // because it's deployment-critical brand infrastructure like the
  // pay subdomain above. (CCF-WEB.1)
  {
    id: 'ccfautos-web',
    description: 'CCF Autos public marketing site (apex + www)',
    hostnames: (process.env.CCF_MARKETING_HOSTNAMES || 'ccfautos.com,www.ccfautos.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedPaths: [
      '/ccf',                    // coming-soon landing page (src/app/ccf)
      '/api/public/ccf-enquiry', // contact-form capture
    ],
    rootHandler: 'rewrite',
    rootRewriteTo: '/ccf',
    fallbackHandler: 'rewrite',
    fallbackRewriteTo: '/ccf',
  },

  // ─── Adding another brand ──────────────────────────────────────
  // Prefer a tenant_domains row (SAAS-8, /admin/tenant-domains) —
  // live without a deploy, and it carries the organization linkage.
  // Add an in-code entry here only when the hostname must keep
  // working with the DB down (deployment-critical, like the ones
  // above): one { id, hostnames, allowedPaths, rootHandler,
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

// '/.well-known/' rides the framework passthrough on EVERY brand host:
// Apple Pay domain verification (APPLEPAY.1) fetches
// /.well-known/apple-developer-merchantid-domain-association anonymously,
// and the brand fallback rewrite was swallowing it — so Apple Pay could
// never verify un1tdublin.com (or pay.ccfautos.com) and the button never
// appeared in Safari. The file itself lives in public/.well-known/.
const FRAMEWORK_ASSET_PATHS = ['/_next/', '/.well-known/']
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

// ─────────────────────────────────────────────────────────────────
// Legacy (in-code) hostnames — read-only display descriptors
//
// The CRM's OWN hostnames are deliberately NOT BRANDS entries
// (resolveBrand returns null for them → the CRM auth gate). They're
// named here only so the /admin/tenant-domains "managed in code" view
// can show the FULL domain picture. See getCrmHostnames() below for
// the full set; this constant is the canonical (first) host.
// ─────────────────────────────────────────────────────────────────

export const CRM_DEFAULT_HOSTNAME = 'crm.un1tdublin.com'

// ─────────────────────────────────────────────────────────────────
// REPSET-P6 — the CRM hostname concept is SET-valued.
//
// The platform gains crm.repset.ie; the un1tdublin hostnames keep
// serving forever (dual-domain). Everything that used to compare
// against ONE host derived from NEXT_PUBLIC_APP_URL must consult
// this set instead: the edge tenant-domains skip, the admin
// tenant-domains write guard, and the "managed in code" rows below.
//
// Env-overridable comma-list (same pattern as MARKETING_HOSTNAMES);
// ordering is canonical-first — index 0 is the canonical CRM host.
// A function, not a module const, so the env is read at call time
// (tests/previews can stub it without a module reload). The
// NEXT_PUBLIC_APP_URL hostname is always part of the set (appended
// when not already listed): preview deployments point it at their
// own URL and that host must keep behaving as the CRM host.
// ─────────────────────────────────────────────────────────────────

export function getCrmHostnames() {
  const hosts = (process.env.CRM_HOSTNAMES || `${CRM_DEFAULT_HOSTNAME},crm.repset.ie`)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  try {
    const appHost = new URL(process.env.NEXT_PUBLIC_APP_URL).hostname.toLowerCase()
    if (!hosts.includes(appHost)) hosts.push(appHost)
  } catch {
    // Env unset/malformed (dev/tests) — the static list stands.
  }
  return hosts
}

/**
 * Read-only descriptors of the in-code hostnames (the CRM default +
 * every BRANDS entry) for the admin "managed in code · read-only"
 * section. NOT routing data — the proxy still routes via BRANDS /
 * resolveBrand; these must never be written to tenant_domains (mig 415
 * forbids it; the admin API refuses them). One descriptor per brand:
 * the primary hostname, any extra hostnames (e.g. www.), a label and a
 * description.
 *
 * @returns {{ key:string, hostname:string, extraHostnames:string[], label:string, description:string }[]}
 */
export function getLegacyBrandRows() {
  // REPSET-P6: the CRM row carries the WHOLE host set — canonical
  // first, the rest (crm.repset.ie, any preview APP_URL host) as
  // extras — so an admin never mistakes a CRM host for an unclaimed
  // hostname and tries to add it as a tenant row.
  const [crmPrimary, ...crmExtras] = getCrmHostnames()

  const rows = [{
    key: 'crm-default',
    hostname: crmPrimary || CRM_DEFAULT_HOSTNAME,
    extraHostnames: crmExtras,
    label: 'CRM (default)',
    description: 'Staff CRM — the default hostnames (auth-gated)',
  }]

  for (const brand of BRANDS) {
    const [primary, ...extra] = brand.hostnames
    if (!primary) continue
    rows.push({
      key: brand.id,
      hostname: primary,
      extraHostnames: extra,
      label: brand.id,
      description: brand.description || '',
    })
  }
  return rows
}
