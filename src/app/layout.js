import './globals.css'
import AppShellServer from '@/components/AppShellServer'
import StudioLockOverlay from '@/components/StudioLockOverlay'
import CookieConsent from '@/components/CookieConsent'
import { headers } from 'next/headers'
import { resolveDefaultFaviconUrl } from '@/lib/default-favicon'
import { resolveDefaultSiteName } from '@/lib/default-site-name'

// PERF.3 — Vercel SpeedInsights + Analytics are now mounted inside
// AppShell's authenticated branch (not at the root layout). Pre-auth
// pages (/login, /welcome, /book/*, /event/*, /deposit/*, etc.) no
// longer pay the cost of loading those two scripts. /login P75 FCP
// drops measurably because the analytics bundles aren't on the
// critical path before the user signs in.

// The favicon lives in Supabase Storage (uploaded via
// /settings → BrandingSettings) so non-developers can swap it.
// Wiring it through Next's root metadata gets a <link rel="icon">
// emitted on every page including the buyer-facing deposit and
// race signup pages on pay.ccfautos.com — those don't render the
// Sidebar component which used to be the only place the favicon
// got injected (imperatively, client-side, after auth). The
// timestamp cache-buster is intentionally omitted — Supabase
// Storage serves the same path forever and the browser's own
// cache handles invalidation cheaply enough.
//
// SAAS-7 / W1.L4 — the URL is no longer hardcoded to the Stillorgan UUID:
// resolveDefaultFaviconUrl reads the REQUEST HOST's organisation's favicon
// (org_settings → that org's company_settings) behind a per-host TTL cache
// (one DB read set per host per lambda per 5 min, not per request) and
// falls back to the platform mark on a CRM host, an unmapped host or a blip.

// Default site metadata. Customer-facing public surfaces (event
// signup, deposit pay, etc.) inherit these unless the page exports
// its own `generateMetadata`. Brand-neutral on purpose — operator-
// only context like "CRM" or "Lead management" must NOT leak into
// the link previews customers see in WhatsApp / iMessage / email,
// because the share is a member-facing booking link not an internal
// admin tool.
//
// CHROME.1 — the name is no longer a literal. It used to read
// "UN1T Dublin", which is (a) the wrong product name on the staff
// CRM now that the platform chrome is Repset — this string labels
// roughly 160 of the app's 188 pages, i.e. nearly every staff tab —
// and (b) a tenant hardcode in the one file every page renders
// through. resolveDefaultSiteName reads the operator's own
// company_settings.company_name (the field /settings →
// BrandingSettings already writes) behind the same TTL cache the
// favicon uses, and falls back to the PLATFORM name only when no
// operator has configured one. So the gym's own identity wins
// wherever a customer can see it, and an unconfigured deployment
// says Repset rather than another tenant's gym.
//
// The old marketing tagline is gone with it: it was UN1T copy that
// no operator could edit. company_settings has no tagline column —
// if one is wanted, that is where it belongs, not here.
//
// REVIEW FOLLOW-UP — this is the PLATFORM default: the customer-facing
// subtrees — /book, /event-pay, /host, /host-connect, /reset-password,
// /account — declare their own metadata via customerFacingMetadata()
// (src/lib/default-site-name.js). A new customer-facing route must do the
// same; src/lib/brand-chrome.test.js pins the ones that exist.
//
// W1.L4 — BOTH resolvers take the REQUEST HOST: a tenant host (an in-code
// brand with an organizationId, or a tenant_domains row) reads its
// organisation's brand, and the CRM hosts read the platform name. Before
// this the name was the first company_settings row in the ESTATE, on every
// host. headers() is a dynamic API, so every route renders dynamically;
// nearly every route already did (auth, force-dynamic), and the proxy runs
// on every request regardless.
//
// Per-page upgrades (richer previews showing the actual event name
// + description) live on individual page files via generateMetadata
// — see src/app/event/[slug]/page.js for the event signup example.
export async function generateMetadata() {
  const host = (await headers()).get('host')
  const [faviconUrl, siteName] = await Promise.all([
    resolveDefaultFaviconUrl({ host }),
    resolveDefaultSiteName({ host }),
  ])
  return {
    title: siteName,
    // No `description`. It used to be a hard-coded UN1T marketing tagline —
    // not operator-editable, and untrue for any other tenant. CHROME.1's
    // first cut replaced it with `siteName`, which previews a shared link
    // with a one-word description; that is worse than none. The editable
    // home for one is a company_settings column (see
    // customerFacingMetadata in src/lib/default-site-name.js), not this file.
    openGraph: {
      title: siteName,
      siteName,
      type: 'website',
    },
    icons: {
      icon: faviconUrl,
      shortcut: faviconUrl,
      apple: faviconUrl,
    },
  }
}

// Explicit viewport — Next.js ships a sensible default but pinning
// it lets us add `viewportFit: 'cover'` so iOS Safari respects the
// notch / Dynamic Island and our content uses the full screen
// instead of leaving the safe-area inset on the sides. Also locks
// the initial scale so the AppShell hamburger doesn't double-tap-
// zoom unexpectedly on phones.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AppShellServer>{children}</AppShellServer>
        {/* STUDIO-PIN.3 — idle-lock overlay. Self-disables when the
            device isn't a paired studio device (no
            studio_device_token in localStorage). Safe to mount at
            the root; regular browser users see nothing. */}
        <StudioLockOverlay />
        {/* GDPR cookie consent + advertising pixels. Self-scopes to the
            public marketing host (un1tdublin.com); renders nothing on the
            CRM, ccfautos, or preview hosts. Safe to mount at the root. */}
        <CookieConsent />
      </body>
    </html>
  )
}
