'use client'

// Per-car deposit affordance. Shown in pending / completed status
// (next to the BuyerCard, before the XeroCard). One button to issue
// or resend the deposit link via email + WhatsApp; status badges
// update as the buyer accepts terms and pays.
//
// Dynamic-imported from CarDetail so its bundle only loads on
// pending/completed cars.

import { useState } from 'react'
import { Send, CheckCircle2, Clock, AlertCircle, ExternalLink, RefreshCw, Mail, MessageCircle } from 'lucide-react'

const STATUS_META = {
  sent:            { label: 'Link sent',       cls: 'bg-blue-500/20 text-blue-400',     icon: Send },
  terms_accepted:  { label: 'Terms accepted',  cls: 'bg-amber-500/20 text-amber-400',   icon: CheckCircle2 },
  paid:            { label: 'Deposit paid',    cls: 'bg-green-500/20 text-green-400',   icon: CheckCircle2 },
  failed:          { label: 'Payment failed',  cls: 'bg-red-500/20 text-red-400',       icon: AlertCircle },
  cancelled:       { label: 'Cancelled',       cls: 'bg-un1t-gray/40 text-un1t-light',  icon: Clock },
  refunded:        { label: 'Refunded',        cls: 'bg-purple-500/20 text-purple-400', icon: RefreshCw },
}

export default function DepositCard({ car, setCar, setError, disabled, defaultAmount = 500 }) {
  const [busy, setBusy] = useState(false)
  const [override, setOverride] = useState(
    car.deposit_amount != null ? Number(car.deposit_amount) : defaultAmount
  )
  const [lastResult, setLastResult] = useState(null)

  const status = car.deposit_status
  const meta = status && STATUS_META[status]
  const isPaid = status === 'paid'
  const hasLink = !!car.deposit_token

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
        deposit_token: c.deposit_token || extractTokenFromLink(j.link),
        deposit_amount: j.amount,
        deposit_status: c.deposit_status === 'paid' ? 'paid' : 'sent',
        deposit_link_sent_at: new Date().toISOString(),
        deposit_link_sent_via: (j.sent_via || []).join(','),
      }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Buyer deposit</h3>
          <p className="text-xs text-un1t-light mt-1">
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
        <div className="text-sm text-un1t-white space-y-1">
          <p>
            <Check inline /> €{Number(car.deposit_paid_amount ?? car.deposit_amount ?? 0).toFixed(2)} received
            {car.deposit_paid_at && ` · ${new Date(car.deposit_paid_at).toLocaleString('en-IE')}`}
          </p>
          {car.deposit_terms_accepted_at && (
            <p className="text-xs text-un1t-light">
              T&amp;Cs accepted {new Date(car.deposit_terms_accepted_at).toLocaleString('en-IE')}
              {car.deposit_terms_accepted_ip && ` from ${car.deposit_terms_accepted_ip}`}
              {car.deposit_terms_accepted_version && ` · v${car.deposit_terms_accepted_version}`}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-end gap-3 mb-3">
            <label className="block text-xs text-un1t-light">
              Amount (EUR)
              <input
                type="number"
                min={1}
                step="0.01"
                value={override}
                onChange={(e) => setOverride(parseFloat(e.target.value) || 0)}
                disabled={busy || disabled}
                className="block mt-1 w-32 bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              />
            </label>
            <button
              onClick={issueLink}
              disabled={busy || disabled || !override}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {hasLink
                ? <><RefreshCw size={14} /> {busy ? 'Resending…' : 'Resend deposit link'}</>
                : <><Send size={14} /> {busy ? 'Sending…' : 'Send deposit link'}</>}
            </button>
          </div>

          {car.deposit_link_sent_at && (
            <p className="text-xs text-un1t-light mb-3">
              Last sent {new Date(car.deposit_link_sent_at).toLocaleString('en-IE')}
              {car.deposit_link_sent_via && (
                <> · via {car.deposit_link_sent_via.split(',').map(c => (
                  <span key={c} className="inline-flex items-center gap-1 ml-1">
                    {c === 'email' ? <Mail size={10} /> : <MessageCircle size={10} />}
                    {c}
                  </span>
                ))}</>
              )}
            </p>
          )}

          {hasLink && (
            <a
              href={`/cars/deposit/${car.deposit_token}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink size={11} /> View public deposit page
            </a>
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

function extractTokenFromLink(link) {
  if (!link) return null
  const m = link.match(/\/cars\/deposit\/([^/?#]+)/)
  return m ? m[1] : null
}
