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
//
// PASSCODEREAD.1 — that refresh switches the card to its linked branch,
// which unmounts this button. The result (and the one-time password it may
// carry, stored nowhere: mig 651) therefore lives in
// CreateInGlofoxResultScope, which GlofoxProfileCard renders ABOVE its
// linked/unlinked switch, and stays on screen until the staff member presses
// Dismiss. Outside a scope the button keeps and shows the result itself.

import { createContext, useContext, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserPlus, CheckCircle2, AlertTriangle, X } from 'lucide-react'

const ResultContext = createContext(null)

export function CreateInGlofoxResultScope({ children }) {
  const [result, setResult] = useState(null)
  return (
    <ResultContext.Provider value={{ result, setResult }}>
      {children}
    </ResultContext.Provider>
  )
}

// Rendered by GlofoxProfileCard above the linked switch, so it survives the
// refresh that links the contact.
export function CreateInGlofoxResultSlot() {
  const scope = useContext(ResultContext)
  if (!scope) return null
  return <CreateInGlofoxResult result={scope.result} onDismiss={() => scope.setResult(null)} />
}

// PASSCODEREAD.1 — the only time this password is ever shown. It is not
// stored anywhere (mig 651) and no message carries it.
function passwordNote(passcode) {
  return passcode
    ? ` First-login password: ${passcode}. Give it to the member now: it is not saved and nothing emails it. They can also use Forgot password? in the Glofox app.`
    : ''
}

// GLOFOXWRITEJUDGE.1 — Glofox refused a new account because the email already
// has one, and the push could not link it: nothing was created, so this is not
// a "partial success". Staff-facing; the details are on the Review tab row.
// BOOKCHATCOPY.1 (C111) — the phone dup-check (glofox-push.js step 2.5) is the
// same shape: it blocks the mint and never links (a shared number may be a
// partner's), so nothing was created. It carries its code in `error`, not
// `reason`, and used to print "Partial success, operator review required.
// phone_match_no_link".
const EMAIL_IN_USE_TEXT = {
  email_in_use_not_linked: 'Not created: this email already has a Glofox account we could not match. Check the Review tab.',
  email_in_use_link_failed: 'Not created: this email already has a Glofox account, but saving the link to it failed. Check the Review tab.',
  phone_match_no_link: 'Not created: this mobile number is already on a Glofox account. Nothing was created or linked, because a shared number may belong to someone else. Review it on the Review tab.',
}

function CreateInGlofoxResult({ result, onDismiss }) {
  if (!result) return null
  const emailInUse = result.status === 'needs_review'
    ? EMAIL_IN_USE_TEXT[result.reason] || (result.error === 'phone_match_no_link' ? EMAIL_IN_USE_TEXT.phone_match_no_link : null)
    : null
  const meta = emailInUse ? { Icon: AlertTriangle, cls: 'text-amber-400', text: emailInUse } : {
    linked:        { Icon: CheckCircle2, cls: 'text-emerald-400', text: 'Linked to an existing Glofox account.' },
    created:       { Icon: CheckCircle2, cls: 'text-emerald-400', text: `Created in Glofox.${passwordNote(result.passcode)}` },
    needs_review:  { Icon: AlertTriangle, cls: 'text-amber-400', text: `Partial success, operator review required. ${result.error || ''}`.trim() + passwordNote(result.passcode) },
    skipped:       { Icon: AlertTriangle, cls: 'text-un1t-subtle', text: 'Skipped (no matching Glofox account and create-if-missing was off).' },
    failed:        { Icon: AlertTriangle, cls: 'text-red-400', text: `Failed: ${result.error || 'unknown error'}` },
  }[result.status]
  if (!meta) return null
  return (
    <div className={`text-[11px] leading-snug flex items-start gap-1.5 ${meta.cls}`}>
      <meta.Icon size={12} className="shrink-0 mt-0.5" />
      <span className="flex-1">{meta.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="shrink-0 text-un1t-muted hover:text-un1t-text"
      >
        <X size={12} />
      </button>
    </div>
  )
}

export default function CreateInGlofoxButton({ contact }) {
  const router = useRouter()
  const scope = useContext(ResultContext)
  const [ownResult, setOwnResult] = useState(null)
  const setResult = scope ? scope.setResult : setOwnResult
  const [busy, setBusy] = useState(false)
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
      // Refresh the page so the linked Glofox card renders. The result is
      // held above the card's linked switch, so it outlives this button.
      router.refresh()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

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

      {!scope && <CreateInGlofoxResult result={ownResult} onDismiss={() => setOwnResult(null)} />}
    </div>
  )
}
