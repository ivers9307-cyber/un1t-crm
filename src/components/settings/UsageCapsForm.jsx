'use client'

// SAAS4-M3 — the org hard-cap editor on /settings/usage. Owner/master
// only (server-enforced on the PUT; `canEdit` just hides the form).
// Empty input = no cap. Values are entered in whole currency / sends
// and stored as cents / count.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function UsageCapsForm({ organizationId, canEdit, initialAiCapCents, initialEmailCapSends }) {
  const router = useRouter()
  const [aiCap, setAiCap] = useState(initialAiCapCents != null ? String(initialAiCapCents / 100) : '')
  const [emailCap, setEmailCap] = useState(initialEmailCapSends != null ? String(initialEmailCapSends) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  if (!canEdit) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle">
        Hard caps are set by an owner. Current: AI{' '}
        {initialAiCapCents != null ? `$${(initialAiCapCents / 100).toFixed(2)}/mo` : 'no cap'} · Email{' '}
        {initialEmailCapSends != null ? `${initialEmailCapSends.toLocaleString()} sends/mo` : 'no cap'}.
      </div>
    )
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)

    const aiNum = aiCap.trim() === '' ? null : Number(aiCap)
    const emailNum = emailCap.trim() === '' ? null : Number(emailCap)
    if (aiNum != null && (!Number.isFinite(aiNum) || aiNum <= 0)) {
      setError('AI cap must be a positive amount, or blank for no cap.')
      setSaving(false)
      return
    }
    if (emailNum != null && (!Number.isInteger(emailNum) || emailNum <= 0)) {
      setError('Email cap must be a positive whole number of sends, or blank for no cap.')
      setSaving(false)
      return
    }

    let json
    try {
      const res = await fetch('/api/settings/org-usage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: organizationId,
          ai_hard_cap_cents: aiNum == null ? null : Math.round(aiNum * 100),
          email_hard_cap_sends: emailNum,
        }),
      })
      json = await res.json()
    } catch {
      json = { success: false, error: 'Network error saving caps. Try again.' }
    }
    if (!json.success) {
      setError(json.error || 'Failed to save caps.')
      setSaving(false)
      return
    }
    setSaved(true)
    setSaving(false)
    router.refresh()
  }

  return (
    <form onSubmit={save} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="text-sm font-medium mb-1">Hard caps</div>
      <p className="text-xs text-un1t-subtle mb-4 max-w-xl">
        Optional monthly brakes. Blank = no cap. At the AI cap, Mia pauses with a human handoff (the
        staff assistant keeps working). At the email cap, new campaigns are refused (sequences and
        reminders keep working). Managers get one heads-up at 80%.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-3">
          {error}
        </div>
      )}
      {saved && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-sm rounded-lg p-3 mb-3">
          Caps saved.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4 max-w-xl">
        <label className="block text-sm">
          <span className="text-un1t-text">AI hard cap ($ per month, est.)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={aiCap}
            onChange={(e) => setAiCap(e.target.value)}
            placeholder="No cap"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-un1t-text">Email hard cap (sends per month)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={emailCap}
            onChange={(e) => setEmailCap(e.target.value)}
            placeholder="No cap"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="bg-un1t-text text-un1t-bg text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save caps'}
      </button>
    </form>
  )
}
