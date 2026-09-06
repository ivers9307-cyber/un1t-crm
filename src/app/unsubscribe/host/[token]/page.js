// GET /unsubscribe/host/[token] — per-host unsubscribe landing page
// (HOST-EMAIL.2). Linked from every host campaign email footer. Public:
// proxy.js allowlists the '/unsubscribe/' prefix (startsWith, so this
// subpath rides it) and AppShell PUBLIC_PATHS carries '/unsubscribe'.
//
// Server component — the token is the capability, the GET does the work:
// verify the HMAC → load the host name → revoke via revokeHostConsent
// (host_email_suppressions insert-once + a consent_log opt_out row;
// re-clicking the link is a no-op) → push a Postmark suppression on the
// host's own stream → confirmation copy. Suppression is PER-HOST: the
// contact's UN1T marketing preferences and other hosts' lists are
// deliberately untouched, and the copy says so. Anything invalid (bad
// signature, unknown host, deleted contact) gets one generic invalid-link
// page — no detail to probe.

import { verifyHostUnsubToken } from '@/lib/host-unsubscribe'
import { createServerClient } from '@/lib/supabase'
import { revokeHostConsent } from '@/lib/host-consent'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
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

export default async function HostUnsubscribePage(props) {
  const params = await props.params

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
    .select('id, name, postmark_stream_id')
    .eq('id', ids.hostId)
    .maybeSingle()
  if (!host) return <InvalidLink />

  // HOST-CONSENT.1 — the ONE writer of a host opt-out. Per-host by design:
  // UN1T marketing preferences and other hosts' lists are untouched.
  const result = await revokeHostConsent(db, {
    hostId: host.id, contactId: ids.contactId, source: 'host_unsubscribe_page',
  })
  if (!result.ok) {
    // FK failure (deleted contact) or transient DB error — either way the
    // suppression wasn't recorded, so don't claim it was.
    logError('host-unsubscribe', 'suppression write failed', { err: result.error })
    return <InvalidLink />
  }

  // Second refusal at Postmark on the host's own stream — best-effort.
  if (host.postmark_stream_id) {
    try {
      const { data: contact } = await db.from('contacts').select('email').eq('id', ids.contactId).maybeSingle()
      if (contact?.email) await suppressAtPostmark(contact.email, { stream: host.postmark_stream_id })
    } catch (e) {
      logError('host-unsubscribe', 'Postmark host-stream suppress threw', { err: e?.message || String(e) })
    }
  }

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
