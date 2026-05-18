'use client'

// POLICIES.1 — admin form for publishing a new version of a policy.
// Posts to /api/admin/policies/[slug]/versions. On success, refreshes
// the server-rendered detail page so the new version appears at the
// top of the history.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Send } from 'lucide-react'

function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default function PublishPolicyVersionForm({ slug, nextVersionNumber }) {
  const router = useRouter()
  const [bodyMarkdown, setBodyMarkdown] = useState('')
  const [changeSummary, setChangeSummary] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!bodyMarkdown.trim()) {
      setError('Body cannot be empty.')
      return
    }
    if (!effectiveDate) {
      setError('Effective date is required.')
      return
    }
    if (!confirm(`Publish v${nextVersionNumber}? Every active employee will need to re-acknowledge.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/policies/${encodeURIComponent(slug)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body_markdown: bodyMarkdown,
          change_summary: changeSummary.trim() || null,
          effective_date: effectiveDate,
        }),
      })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Publish failed.')
        setBusy(false)
        return
      }
      setBodyMarkdown('')
      setChangeSummary('')
      setEffectiveDate(todayISO())
      router.refresh()
    } catch (e) {
      setError(e.message || 'Network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border border-un1t-gray rounded-lg p-4">
      <div className="text-xs text-un1t-light">
        Publishing as <strong>v{nextVersionNumber}</strong>. Once published, the previous version
        becomes archived and every active employee will be prompted to read and
        re-acknowledge the new version.
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-un1t-light mb-1">Body</label>
        <textarea
          rows={16}
          value={bodyMarkdown}
          onChange={(e) => setBodyMarkdown(e.target.value)}
          placeholder="Paste the policy text here. Plain text with ALL-CAPS headings and numbered sections renders best."
          className="w-full bg-un1t-dark border border-un1t-gray rounded-md p-3 text-sm font-mono text-un1t-white"
        />
        <div className="text-[10px] text-un1t-mid mt-1">{bodyMarkdown.length.toLocaleString()} / 200,000 characters</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs uppercase tracking-wider text-un1t-light mb-1">Effective date</label>
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-un1t-light mb-1">
            Change summary <span className="text-un1t-mid normal-case tracking-normal">(optional, shown to staff)</span>
          </label>
          <input
            type="text"
            value={changeSummary}
            onChange={(e) => setChangeSummary(e.target.value)}
            placeholder="e.g. Updated sick-pay procedure to match Sick Leave Act 2022."
            maxLength={2000}
            className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-500 rounded-md px-3 py-2 text-xs">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black px-4 py-2 rounded-md text-sm font-medium hover:bg-un1t-accent disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {busy ? 'Publishing…' : `Publish v${nextVersionNumber}`}
        </button>
      </div>
    </form>
  )
}
