// STAFF-WEB-LOCK — /use-the-app
//
// The wall page staff land on when STAFF_WEB_LOCK=1 and they open the CRM
// in a browser (src/lib/staff-web-lock.js has the decision + rationale).
// Registered in BOTH the proxy publicPaths and AppShell PUBLIC_PATHS
// (CLAUDE.md rule) so it renders bare and never redirect-loops: the proxy
// must not bounce an already-walled request back here, and the app chrome
// this page exists to replace must not wrap it.
//
// "Open the Repset app" uses the custom scheme (repset://) — universal
// links are not configured (no AASA / assetlinks), so there is no https://
// deep-link path today. On a device without the app the scheme link is a
// no-op, which is why the store badges sit directly beneath it.

import SignOutButton from './SignOutButton'

export const metadata = {
  title: 'Repset — Use the app',
}

const APP_STORE_URL = 'https://apps.apple.com/app/id6770890839'
const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.un1tdublin.crm'

export default function UseTheAppPage() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: '#131316', color: '#D6D2C9' }}
    >
      <p
        className="text-xs font-semibold tracking-[0.3em] uppercase"
        style={{ color: '#D6FF3D' }}
      >
        Repset
      </p>
      <h1 className="mt-4 text-3xl font-bold text-white max-w-md">
        Repset now lives in the app
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed" style={{ color: '#A7A49E' }}>
        Staff access has moved off the browser. Everything you do here —
        schedule, inbox, bookings, your own training — is in the Repset app.
      </p>

      <a
        href="repset://"
        className="mt-8 inline-block rounded-full px-8 py-3 text-sm font-semibold"
        style={{ backgroundColor: '#D6FF3D', color: '#131316' }}
      >
        Open the Repset app
      </a>

      <div className="mt-6 flex items-center gap-6 text-sm">
        <a
          href={APP_STORE_URL}
          className="underline underline-offset-4 hover:text-white transition-colors"
        >
          App Store
        </a>
        <a
          href={PLAY_STORE_URL}
          className="underline underline-offset-4 hover:text-white transition-colors"
        >
          Google Play
        </a>
      </div>

      <div className="mt-12">
        <SignOutButton />
      </div>
    </main>
  )
}
