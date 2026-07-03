'use client'

// GLOFOX3.4 — manual "Create in Glofox" button. Rendered inside the
// GlofoxProfileCard empty state for unlinked contacts. Disabled
// with an explanatory tooltip when first_name / last_name / email
// are missing (Glofox /2.0/register insists on all three).
//
// Clicking fires POST /api/contacts/[id]/push-to-glofox; result
// is rendered inline so the operator sees what happened without
// hopping to the Review tab unless they need to.
//
// On success (linked / created), the component triggers a soft
// route refresh so the freshly-synced Glofox card re-renders
// alongside the rest of the contact data.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserPlus, CheckCircle2, AlertTriangle } from 'lucide-react'

export default function CreateInGlofoxButton({ contact }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const missing = []
  if (!contact.first_name) missing.push('first name')
  if (!contact.last_name) missing.push('last name')
  if (!contact.email) missing.push('email')
  const disabled = missing.length > 0 || busy

  const tooltip = missing.length > 0
    ? `Fill in ${missing.join(', ')} first — Glofox requires all three.`
    : 'Create this contact in Glofox now (search-and-link if they already exist).'

  async function handleClick() {
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contact.id}/push-to-glofox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.message || j.error || `Push failed (${r.status})`)
        return
      }
      setResult(j.result)
      // Refresh the page so the linked Glofox card renders.
      router.refresh()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  // After a successful link/create, the parent re-renders with the
  // linked variant of the card — but the result message is useful
  // for the brief window before the refresh lands, and for the
  // needs_review case where it'll persist.
  const resultMeta = result && {
    linked:        { Icon: CheckCircle2, cls: 'text-emerald-400', text: 'Linked to an existing Glofox account.' },
    created:       { Icon: CheckCircle2, cls: 'text-emerald-400', text: result.passcode
      ? `Created in Glofox. Passcode: ${result.passcode} (will be emailed via the welcome sequence).`
      : 'Created in Glofox.' },
    needs_review:  { Icon: AlertTriangle, cls: 'text-amber-400', text: `Partial success — operator review required. ${result.error || ''}`.trim() },
    skipped:       { Icon: AlertTriangle, cls: 'text-un1t-subtle', text: 'Skipped (no matching Glofox account and create-if-missing was off).' },
    failed:        { Icon: AlertTriangle, cls: 'text-red-400', text: `Failed: ${result.error || 'unknown error'}` },
  }[result.status]

  return (
    <div className="pt-2 space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={tooltip}
        className={`w-full inline-flex items-center justify-center gap-2 text-xs font-medium py-2 rounded-md transition-colors ${
          disabled
            ? 'bg-un1t-border/30 text-un1t-muted cursor-not-allowed border border-un1t-border/40'
            : 'bg-emerald-500/15 text-emerald-700 border border-emerald-500/40 hover:bg-emerald-500/25'
        }`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
        {busy ? 'Creating in Glofox…' : 'Create in Glofox'}
      </button>

      {missing.length > 0 && (
        <p className="text-[11px] text-amber-700 leading-snug">
          Missing {missing.join(', ')} — Glofox requires all three to register a member.
        </p>
      )}

      {error && (
        <p className="text-[11px] text-red-400 leading-snug">{error}</p>
      )}

      {resultMeta && (
        <p className={`text-[11px] leading-snug flex items-start gap-1.5 ${resultMeta.cls}`}>
          <resultMeta.Icon size={12} className="shrink-0 mt-0.5" />
          <span>{resultMeta.text}</span>
        </p>
      )}
    </div>
  )
}
