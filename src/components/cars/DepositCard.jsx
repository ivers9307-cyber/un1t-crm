'use client'

// Per-car deposit affordance. Shown in pending / completed status
// (next to the BuyerCard, before the XeroCard). One button to issue
// or resend the deposit link via email + WhatsApp; status badges
// update as the buyer accepts terms and pays.
//
// Dynamic-imported from CarDetail so its bundle only loads on
// pending/completed cars.

import { useState } from 'react'
import { Send, CheckCircle2, Clock, AlertCircle, ExternalLink, RefreshCw, Mail, MessageCircle, XCircle } from 'lucide-react'

const CANCELLABLE_STATUSES = new Set(['sent', 'terms_accepted', 'failed'])

const STATUS_META = {
  sent:            { label: 'Link sent',       cls: 'bg-blue-500/20 text-blue-400',     icon: Send },
  terms_accepted:  { label: 'Terms accepted',  cls: 'bg-amber-500/20 text-amber-400',   icon: CheckCircle2 },
  paid:            { label: 'Deposit paid',    cls: 'bg-green-500/20 text-green-400',   icon: CheckCircle2 },
  failed:          { label: 'Payment failed',  cls: 'bg-red-500/20 text-red-400',       icon: AlertCircle },
  cancelled:       { label: 'Cancelled',       cls: 'bg-un1t-border/40 text-un1t-subtle',  icon: Clock },
  refunded:        { label: 'Refunded',        cls: 'bg-purple-500/20 text-purple-400', icon: RefreshCw },
}

// Client-side mirror of getDepositBaseUrl(). Configured at deploy time —
// used to build absolute preview links so the operator opens the page
// on the same hostname the buyer would (pay.ccfautos.com), not the CRM
// host. Falls back to a relative path which still works on either domain.
const DEPOSIT_BASE_URL = process.env.NEXT_PUBLIC_DEPOSIT_BASE_URL || ''

export default function DepositCard({ car, setCar, setError, disabled, defaultAmount = 500 }) {
  const [busy, setBusy] = useState(false)
  const [override, setOverride] = useState(
    car.deposit_amount != null ? Number(car.deposit_amount) : defaultAmount
  )
  const [lastResult, setLastResult] = useState(null)
  // Two-step cancel confirm: first click flips cancelArmed=true,
  // second click within ~5s actually fires the API. Auto-disarms
  // if the operator looks at it for too long.
  const [cancelArmed, setCancelArmed] = useState(false)

  const status = car.deposit_status
  const meta = status && STATUS_META[status]
  const isPaid = status === 'paid'
  const hasLink = !!car.deposit_token
  const canCancel = CANCELLABLE_STATUSES.has(status)

  async function issueLink() {
    setBusy(true); setError(null); setLastResult(null)
    try {
      const res = await fetch(`/api/cars/${car.id}/issue-deposit-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: override }),
      })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Failed to issue deposit link')
        return
      }
      setLastResult(j)
      // Reflect the new state locally so the card updates without a page reload.
      setCar(c => ({
        ...c,
        // Token rotates on each issue (mig 047). Pick it from the
        // returned link rather than reusing the cached value.
        deposit_token: extractTokenFromLink(j.link) || c.deposit_token,
        deposit_token_expires_at: j.expires_at || c.deposit_token_expires_at,
        deposit_amount: j.amount,
        deposit_status: c.deposit_status === 'paid' ? 'paid' : 'sent',
        deposit_link_sent_at: new Date().toISOString(),
        deposit_link_sent_via: (j.sent_via || []).join(','),
      }))
    } finally {
      setBusy(false)
    }
  }

  async function cancelDeposit() {
    setBusy(true); setError(null); setLastResult(null)
    try {
      const res = await fetch(`/api/cars/${car.id}/cancel-deposit`, { method: 'POST' })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Failed to cancel deposit')
        return
      }
      // Reflect the cancelled state locally — no page reload needed.
      // Server returns the updated car so we stamp it directly.
      setCar(c => ({ ...c, ...j.data.car }))
      setCancelArmed(false)
    } finally {
      setBusy(false)
    }
  }

  function armCancel() {
    setCancelArmed(true)
    // Auto-disarm after 5s so the button doesn't sit primed forever.
    setTimeout(() => setCancelArmed(false), 5000)
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Buyer deposit</h3>
          <p className="text-xs text-un1t-subtle mt-1">
            One link by email + WhatsApp. Buyer accepts T&amp;Cs, pays via Revolut, you get notified here.
          </p>
        </div>
        {meta && (
          <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full shrink-0 ${meta.cls}`}>
            <meta.icon size={11} />
            {meta.label}
          </span>
        )}
      </div>

      {isPaid ? (
        <div className="text-sm text-un1t-text space-y-1">
          <p>
            <Check inline /> €{Number(car.deposit_paid_amount ?? car.deposit_amount ?? 0).toFixed(2)} received
            {car.deposit_paid_at && ` · ${new Date(car.deposit_paid_at).toLocaleString('en-IE')}`}
          </p>
          {car.deposit_terms_accepted_at && (
            <p className="text-xs text-un1t-subtle">
              T&amp;Cs accepted {new Date(car.deposit_terms_accepted_at).toLocaleString('en-IE')}
              {car.deposit_terms_accepted_ip && ` from ${car.deposit_terms_accepted_ip}`}
              {car.deposit_terms_accepted_version && ` · v${car.deposit_terms_accepted_version}`}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-end gap-3 mb-3">
            <label className="block text-xs text-un1t-subtle">
              Amount (EUR)
              <input
                type="number"
                min={1}
                step="0.01"
                value={override}
                onChange={(e) => setOverride(parseFloat(e.target.value) || 0)}
                disabled={busy || disabled}
                className="block mt-1 w-32 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
            </label>
            <button
              onClick={issueLink}
              disabled={busy || disabled || !override}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {hasLink
                ? <><RefreshCw size={14} /> {busy ? 'Resending…' : 'Resend deposit link'}</>
                : <><Send size={14} /> {busy ? 'Sending…' : 'Send deposit link'}</>}
            </button>
          </div>

          {car.deposit_link_sent_at && (
            <p className="text-xs text-un1t-subtle mb-3">
              Last sent {new Date(car.deposit_link_sent_at).toLocaleString('en-IE')}
              {car.deposit_link_sent_via && (
                <> · via {car.deposit_link_sent_via.split(',').map(c => (
                  <span key={c} className="inline-flex items-center gap-1 ml-1">
                    {c === 'email' ? <Mail size={10} /> : <MessageCircle size={10} />}
                    {c}
                  </span>
                ))}</>
              )}
              {car.deposit_token_expires_at && (
                <ExpiryHint expiresAt={car.deposit_token_expires_at} />
              )}
            </p>
          )}

          {hasLink && (
            <a
              href={`${DEPOSIT_BASE_URL}/deposit/${car.deposit_token}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink size={11} /> View public deposit page
            </a>
          )}

          {/* Cancel deposit request — only visible while the deposit
              is in a state that can still be cancelled. Two-step
              confirm: first click arms the button, second click
              within 5s actually fires. Auto-disarms on timeout. */}
          {canCancel && (
            <div className="mt-3 pt-3 border-t border-un1t-border/40">
              {!cancelArmed ? (
                <button
                  onClick={armCancel}
                  disabled={busy || disabled}
                  className="text-xs text-red-400 hover:text-red-300 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <XCircle size={11} /> Cancel deposit request
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-400">Are you sure? This kills the buyer's link.</span>
                  <button
                    onClick={cancelDeposit}
                    disabled={busy}
                    className="text-xs px-2 py-1 rounded bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {busy ? 'Cancelling…' : 'Yes, cancel'}
                  </button>
                  <button
                    onClick={() => setCancelArmed(false)}
                    disabled={busy}
                    className="text-xs px-2 py-1 rounded bg-un1t-border/40 text-un1t-subtle hover:bg-un1t-border/60"
                  >
                    Keep
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {lastResult?.errors?.length > 0 && (
        <div className="mt-3 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md p-2">
          <AlertCircle size={12} className="inline-block mr-1 mb-0.5" />
          Partial delivery: {lastResult.errors.join('; ')}
        </div>
      )}
    </div>
  )
}

function Check({ inline }) {
  return <CheckCircle2 size={inline ? 14 : 18} className="inline-block text-green-500 mr-1" />
}

// Renders ' · expires in 22h' or ' · expired' so the operator knows
// at a glance whether the buyer can still use the link. 24h validity
// stamped at issue time.
function ExpiryHint({ expiresAt }) {
  const expiresMs = new Date(expiresAt).getTime()
  const remainingMs = expiresMs - Date.now()
  if (remainingMs <= 0) {
    return <span className="ml-2 text-amber-400">· expired</span>
  }
  const hours = Math.floor(remainingMs / (60 * 60 * 1000))
  const mins = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000))
  const label = hours >= 1 ? `${hours}h ${mins}m` : `${mins}m`
  return <span className="ml-2 text-un1t-subtle">· expires in {label}</span>
}

function extractTokenFromLink(link) {
  if (!link) return null
  // Match either the new /deposit/<token> or the legacy /cars/deposit/<token>
  // form so this keeps working even if a server is mid-rollout.
  const m = link.match(/\/(?:cars\/)?deposit\/([^/?#]+)/)
  return m ? m[1] : null
}
