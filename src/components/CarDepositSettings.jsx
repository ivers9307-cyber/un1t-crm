'use client'

// Per-location car-deposit settings. Lives at the bottom of
// /settings/locations/[id]. Two things to configure:
//   1. Default deposit amount (overridable per-car at issue time)
//   2. Terms & conditions text (the buyer must accept this verbatim)
//
// SMS credentials are global TWILIO_* env vars (one Twilio account
// for the whole org), but the alpha SENDER ID is per-location as of
// mig 059 — set in the SMS (Twilio) section higher up on this same
// settings page. The deposit-link route reads it via sendLocationSms.
//
// Saving the terms text bumps locations.car_deposit_terms_version
// server-side so any in-flight buyer's accept-and-pay POST will be
// rejected and the page will reload with the new copy.

import { useState } from 'react'
import { Banknote, FileText, MessageSquare, Save } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'

export default function CarDepositSettings({ location }) {
  const [defaultAmount, setDefaultAmount] = useState(
    location.car_deposit_default_amount != null ? Number(location.car_deposit_default_amount) : 500
  )
  const [terms, setTerms] = useState(location.car_deposit_terms || DEFAULT_TERMS)
  const [receiptSmsEnabled, setReceiptSmsEnabled] = useState(
    Boolean(location.car_deposit_receipt_sms_enabled)
  )

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave() {
    setSaving(true); setSaved(false); setError(null)

    const db = createBrowserClient()
    const trimmedTerms = (terms || '').trim()
    const termsChanged = trimmedTerms !== (location.car_deposit_terms || '').trim()

    const updates = {
      car_deposit_default_amount: defaultAmount || null,
      car_deposit_terms: trimmedTerms || null,
      car_deposit_receipt_sms_enabled: receiptSmsEnabled,
    }
    // Bump the version IFF the wording actually changed. That's the
    // signal the public page uses to reject stale buyers.
    if (termsChanged) {
      updates.car_deposit_terms_version = (location.car_deposit_terms_version || 1) + 1
    }

    const { error: err } = await db.from('locations').update(updates).eq('id', location.id)
    if (err) {
      setError(err.message)
      setSaving(false)
      return
    }
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-3">
        <Banknote size={16} className="text-un1t-subtle" />
        <h3 className="text-lg font-semibold">Car deposit</h3>
        <span className="text-xs text-un1t-muted ml-2">
          v{location.car_deposit_terms_version || 1}
        </span>
      </div>
      <p className="text-xs text-un1t-subtle mb-4">
        Powers the &lsquo;Send deposit link&rsquo; button on each car. Buyers receive a tokenised
        URL via SMS (Twilio) with these terms; on accept, payment is taken via Revolut Merchant.
      </p>

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-5">
        <div>
          <label className="block text-sm mb-1.5 flex items-center gap-1.5">
            <Banknote size={12} /> Default deposit amount (EUR)
          </label>
          <input
            type="number"
            min={1}
            step="0.01"
            value={defaultAmount}
            onChange={(e) => setDefaultAmount(parseFloat(e.target.value) || 0)}
            className="w-40 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
          />
          <p className="text-[11px] text-un1t-muted mt-1">Operator can override per car at issue time.</p>
        </div>

        <div>
          <label className="block text-sm mb-1.5 flex items-center gap-1.5">
            <FileText size={12} /> Terms &amp; conditions
          </label>
          <textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            rows={10}
            placeholder="The deposit is non-refundable and secures the car for the buyer..."
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted font-mono leading-relaxed"
          />
          <p className="text-[11px] text-un1t-muted mt-1">
            Plain text or markdown. Saving any change bumps the terms version &mdash; in-flight buyers
            on the public page will be asked to refresh and re-read before paying.
          </p>
        </div>

        <div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={receiptSmsEnabled}
              onChange={(e) => setReceiptSmsEnabled(e.target.checked)}
              className="mt-0.5"
            />
            <span className="flex-1">
              <span className="block text-sm flex items-center gap-1.5">
                <MessageSquare size={12} /> Send buyer a receipt SMS when their deposit is paid
              </span>
              <span className="block text-[11px] text-un1t-muted mt-0.5">
                Fired by the Revolut webhook on ORDER_COMPLETED. Confirms the captured amount and
                the car. Skipped if the buyer has no phone number on file. Each send is logged as a
                system note on the car so you can verify delivery (or fetch the Twilio SID).
              </span>
            </span>
          </label>
        </div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-semibold px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            <Save size={14} /> {saving ? 'Saving…' : 'Save deposit settings'}
          </button>
          {saved && <span className="text-xs text-green-400">Saved.</span>}
        </div>
      </div>
    </section>
  )
}

const DEFAULT_TERMS = `By paying this deposit you agree to the following:

1. The deposit is non-refundable.
2. Payment of this deposit secures the vehicle for you and locks in the
   agreed sale price.
3. The vehicle will be held for you for a period of 14 days from the
   date of payment, after which the deposit may be forfeit unless an
   extension has been agreed in writing.
4. The deposit is applied as part-payment toward the final sale price
   on completion of the purchase.
5. If you choose not to proceed with the purchase, the deposit will not
   be returned.

Contact us if you have any questions before paying.`
