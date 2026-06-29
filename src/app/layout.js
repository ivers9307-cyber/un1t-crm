import './globals.css'
import AppShellServer from '@/components/AppShellServer'
import StudioLockOverlay from '@/components/StudioLockOverlay'
import CookieConsent from '@/components/CookieConsent'

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
const FAVICON_URL =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/a0000000-0000-0000-0000-000000000001/favicon.png'

// Default site metadata. Customer-facing public surfaces (event
// signup, deposit pay, etc.) inherit these unless the page exports
// its own `generateMetadata`. Brand-neutral on purpose — operator-
// only context like "CRM" or "Lead management" must NOT leak into
// the link previews customers see in WhatsApp / iMessage / email,
// because the share is a member-facing booking link not an internal
// admin tool.
//
// Per-page upgrades (richer previews showing the actual event name
// + description) live on individual page files via generateMetadata
// — see src/app/event/[slug]/page.js for the event signup example.
export const metadata = {
  title: 'UN1T Dublin',
  description: 'UN1T Dublin — strength, conditioning, racing.',
  openGraph: {
    title: 'UN1T Dublin',
    description: 'UN1T Dublin — strength, conditioning, racing.',
    siteName: 'UN1T Dublin',
    type: 'website',
  },
  icons: {
    icon: FAVICON_URL,
    shortcut: FAVICON_URL,
    apple: FAVICON_URL,
  },
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
