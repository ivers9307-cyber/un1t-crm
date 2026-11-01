'use client'

// MCP.1 — the browser half of /oauth/consent. Supabase's OAuth server owns the
// authorization request; this talks to it with the signed-in person's session
// (supabase.auth.oauth.*), then sends the browser back to the MCP client with
// the redirect_url Supabase returns.

import { useEffect, useState } from 'react'
import { Button, Card } from '@/components/ui'
import { createBrowserClient } from '@/lib/supabase'

// Fixed by the MCP.1 brief; shown verbatim next to a disabled Approve.
const REFUSALS = {
  mcp_disabled: 'MCP access is not switched on for your organisation. Ask an organisation admin.',
  assistant_permission: 'Ask an admin to switch on AI Assistant for you.',
}

const CAPABILITIES = [
  'Read your studios’ roster, members and classes.',
  'Create shifts, contacts and activities, only where your role allows.',
  'Act as you: it sees and does no more than you can, and you can disconnect it any time from your Account page.',
]

/**
 * @param {object} props
 * @param {string} props.authorizationId
 * @param {{ ok: boolean, reason: null | 'mcp_disabled' | 'assistant_permission' }} props.eligibility
 * @param {string} [props.personName]
 */
export default function OAuthConsentForm({ authorizationId, eligibility, personName }) {
  // 'loading' | 'ready' | 'redirecting' | 'error'
  const [phase, setPhase] = useState('loading')
  const [details, setDetails] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null) // null | 'approve' | 'deny'

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createBrowserClient()
        const { data, error: err } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
        if (cancelled) return
        if (err || !data) {
          setError(err?.message || 'This connection request could not be read. Start again from the app.')
          setPhase('error')
          return
        }
        // No authorization_id in the reply: this client is already approved,
        // and the reply is the way back to it.
        if (!data.authorization_id) {
          if (!data.redirect_url) {
            setError('This connection request could not be read. Start again from the app.')
            setPhase('error')
            return
          }
          setPhase('redirecting')
          window.location.assign(data.redirect_url)
          return
        }
        setDetails(data)
        setPhase('ready')
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'This connection request could not be read. Start again from the app.')
        setPhase('error')
      }
    })()
    return () => { cancelled = true }
  }, [authorizationId])

  async function decide(kind) {
    setBusy(kind)
    setError(null)
    try {
      const supabase = createBrowserClient()
      const oauth = supabase.auth.oauth
      const call = kind === 'approve' ? oauth.approveAuthorization : oauth.denyAuthorization
      // skipBrowserRedirect: navigate ourselves, so a missing redirect_url is
      // an error on screen rather than a silent stall.
      const { data, error: err } = await call.call(oauth, authorizationId, { skipBrowserRedirect: true })
      if (err || !data?.redirect_url) {
        setError(err?.message || 'Something went wrong. Try again.')
        setBusy(null)
        return
      }
      setPhase('redirecting')
      window.location.assign(data.redirect_url)
    } catch (e) {
      setError(e?.message || 'Something went wrong. Try again.')
      setBusy(null)
    }
  }

  if (phase === 'loading' || phase === 'redirecting') {
    return (
      <p className="text-sm text-un1t-muted" role="status">
        {phase === 'loading' ? 'Loading connection request…' : 'Taking you back to the app…'}
      </p>
    )
  }

  if (phase === 'error') {
    return (
      <Card className="w-full max-w-md">
        <p className="text-sm text-red-700" role="alert">{error}</p>
      </Card>
    )
  }

  const refusal = eligibility?.ok ? null : REFUSALS[eligibility?.reason] || REFUSALS.mcp_disabled

  return (
    <Card className="w-full max-w-md" title="Connect an app">
      <p className="text-sm text-un1t-text">
        <span className="font-semibold">{details.client?.name || 'An app'}</span>
        {' '}wants to connect to your account{personName ? <> as {personName}</> : null}.
      </p>
      <p className="mt-3 text-sm text-un1t-muted">If you approve, it can:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-un1t-text">
        {CAPABILITIES.map((line) => <li key={line}>{line}</li>)}
      </ul>

      {refusal && (
        <p className="mt-4 text-sm text-amber-700" role="note">{refusal}</p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>
      )}

      <div className="mt-5 flex gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={!eligibility?.ok || busy !== null}
          loading={busy === 'approve'}
          onClick={() => decide('approve')}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy !== null}
          loading={busy === 'deny'}
          onClick={() => decide('deny')}
        >
          Deny
        </Button>
      </div>
    </Card>
  )
}
