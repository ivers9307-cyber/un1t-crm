'use client'

// INTEG-D1 — auto-top-up config controls on /settings/billing (one per
// pinned location's wallet block). Writes the three DORMANT
// wallets.auto_topup_* columns via PATCH /api/settings/billing/auto-topup
// — config only, nothing reads it until the Stripe top-up leg ships,
// and the control says so. Owner/master server-enforced on the PATCH.
// Modeled on UsageCapsForm (SAAS4-M3).

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Mirror of the route's Zod bounds (EUR): amount €5–€500, threshold €0–€200.
const AMOUNT_MIN_EUR = 5
const AMOUNT_MAX_EUR = 500
const THRESHOLD_MIN_EUR = 0
const THRESHOLD_MAX_EUR = 200

export default function AutoTopupForm({ locationId, initialEnabled, initialAmountCents, initialThresholdCents }) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(Boolean(initialEnabled))
  const [amount, setAmount] = useState(initialAmountCents != null ? String(initialAmountCents / 100) : '')
  const [threshold, setThreshold] = useState(initialThresholdCents != null ? String(initialThresholdCents / 100) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)

    const amountNum = amount.trim() === '' ? null : Number(amount)
    const thresholdNum = threshold.trim() === '' ? null : Number(threshold)
    if (amountNum != null && (!Number.isFinite(amountNum) || amountNum < AMOUNT_MIN_EUR || amountNum > AMOUNT_MAX_EUR)) {
      setError(`Top-up amount must be between €${AMOUNT_MIN_EUR} and €${AMOUNT_MAX_EUR}, or blank.`)
      setSaving(false)
      return
    }
    if (thresholdNum != null && (!Number.isFinite(thresholdNum) || thresholdNum < THRESHOLD_MIN_EUR || thresholdNum > THRESHOLD_MAX_EUR)) {
      setError(`Threshold must be between €${THRESHOLD_MIN_EUR} and €${THRESHOLD_MAX_EUR}, or blank.`)
      setSaving(false)
      return
    }

    let json
    try {
      const res = await fetch('/api/settings/billing/auto-topup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          enabled,
          amount_cents: amountNum == null ? null : Math.round(amountNum * 100),
          threshold_cents: thresholdNum == null ? null : Math.round(thresholdNum * 100),
        }),
      })
      json = await res.json()
    } catch {
      json = { success: false, error: 'Network error saving auto-top-up settings. Try again.' }
    }
    if (!json.success) {
      setError(json.error || 'Failed to save auto-top-up settings.')
      setSaving(false)
      return
    }
    setSaved(true)
    setSaving(false)
    router.refresh()
  }

  return (
    <form onSubmit={save} className="border-t border-un1t-border pt-4 mt-4">
      <div className="text-sm font-medium mb-1">Auto top-up</div>
      <p className="text-xs text-un1t-subtle mb-3 max-w-xl">
        Automatically add credit when the wallet drops below a threshold. Takes effect when card
        top-ups go live — the settings are saved now and used from day one.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-3">
          {error}
        </div>
      )}
      {saved && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-sm rounded-lg p-3 mb-3">
          Auto top-up settings saved.
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm pb-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded border-un1t-border"
          />
          <span>Enable auto top-up</span>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-un1t-subtle">Top-up amount (€)</span>
          <input
            type="number"
            min={AMOUNT_MIN_EUR}
            max={AMOUNT_MAX_EUR}
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="—"
            className="mt-1 w-32 bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-un1t-subtle">When balance falls below (€)</span>
          <input
            type="number"
            min={THRESHOLD_MIN_EUR}
            max={THRESHOLD_MAX_EUR}
            step="1"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="—"
            className="mt-1 w-32 bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className="text-xs bg-un1t-text text-un1t-bg px-3 py-2 rounded-md hover:bg-un1t-accent transition-colors font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
