// GET /unsubscribe/host/[token] — per-host unsubscribe landing page
// (HOST-EMAIL.2). Linked from every host campaign email footer. Public:
// proxy.js allowlists the '/unsubscribe/' prefix (startsWith, so this
// subpath rides it) and AppShell PUBLIC_PATHS carries '/unsubscribe'.
//
// HOST-EMAILS.2 — the GET writes NOTHING. On 7 Sep 2026 a university mail
// scanner followed every link in a host email within seconds of delivery and
// opted three people out. The button posts to the one-click route, which is
// the single writer. Server component — the token is the capability, the
// GET only verifies the HMAC and loads the host name to render either the
// confirm button or, after a successful POST, the confirmation copy.
// Suppression is PER-HOST: the contact's UN1T marketing preferences and
// other hosts' lists are deliberately untouched, and the copy says so.
// Anything invalid (bad signature, unknown host, deleted contact) gets one
// generic invalid-link page — no detail to probe.

import { verifyHostUnsubToken } from '@/lib/host-unsubscribe'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Unsubscribe — UN1T',
}

function Shell({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4 py-16 text-white">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  )
}

function InvalidLink() {
  return (
    <Shell>
      <h1 className="text-2xl font-bold">This link isn&apos;t valid</h1>
      <p className="mt-4 text-sm text-white/70">
        The unsubscribe link is invalid or has expired. Please use the
        unsubscribe link from a more recent email.
      </p>
    </Shell>
  )
}

// A Next.js searchParams value is a string for one occurrence of a key but
// an array for a repeated one (e.g. ?done=1&done=2) — normalise before
// comparing so a repeated/duped query param can't dodge the done/error checks.
const first = (v) => (Array.isArray(v) ? v[0] : v)

export default async function HostUnsubscribePage(props) {
  const params = await props.params
  const sp = await props.searchParams

  let ids = null
  try {
    ids = verifyHostUnsubToken(params.token)
  } catch (e) {
    // Misconfigured secret — log loudly, show the generic page.
    logError('host-unsubscribe', 'token verification threw', { err: e })
    ids = null
  }
  if (!ids) return <InvalidLink />

  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name')
    .eq('id', ids.hostId)
    .maybeSingle()
  if (!host) return <InvalidLink />

  if (first(sp?.done) === '1') {
    return (
      <Shell>
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Unsubscribed</p>
        <h1 className="mt-3 text-2xl font-bold">You&apos;re unsubscribed</h1>
        <p className="mt-4 text-sm text-white/70">
          You&apos;ll no longer receive emails from {host.name}. Your other email
          preferences are unchanged.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Unsubscribe</p>
      <h1 className="mt-3 text-2xl font-bold">Stop emails from {host.name}?</h1>
      <p className="mt-4 text-sm text-white/70">
        This only affects emails from {host.name}. Your other email preferences are unchanged.
      </p>
      {first(sp?.error) === '1' && (
        <p className="mt-4 text-sm text-red-300">That did not work. Please try again.</p>
      )}
      <form method="post" action={`/api/unsubscribe/host/${encodeURIComponent(params.token)}`} className="mt-6">
        <input type="hidden" name="redirect" value="1" />
        <button type="submit" className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/90">
          Unsubscribe
        </button>
      </form>
    </Shell>
  )
}
