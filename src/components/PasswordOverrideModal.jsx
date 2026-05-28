'use client'

// AUTH.1 — admin password-override modal.
//
// Two-stage flow:
//   1. Form — admin chooses to enter a password or generate one,
//      adds an optional reason, clicks Override.
//   2. Result — the new password is shown ONCE with a copy button
//      and a 'this won't be shown again' warning. Admin closes,
//      and the password is gone from the UI forever.
//
// Audit + session invalidation happen server-side
// (/api/admin/password-override) — this component only renders.
//
// Used from both staff edit (StaffForm) and contact detail
// (member). targetType + targetId discriminate.

import { useState, useEffect } from 'react'
import { X, Copy, Check, KeyRound, AlertTriangle, RefreshCw } from 'lucide-react'

export default function PasswordOverrideModal({
  open,
  onClose,
  targetType,        // 'staff' | 'member'
  targetId,          // profile.id (staff) or contact.id (member)
  targetLabel,       // human name shown in the modal header
}) {
  const [mode, setMode] = useState('random')   // 'random' | 'manual'
  const [manualPassword, setManualPassword] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [newPassword, setNewPassword] = useState(null)
  const [copied, setCopied] = useState(false)

  // Close on Esc, but only when we're not showing the result —
  // closing the result screen is a deliberate "I've captured the
  // password" action.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !newPassword) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, newPassword])

  // Reset transient state when closed.
  useEffect(() => {
    if (!open) {
      setMode('random')
      setManualPassword('')
      setReason('')
      setError(null)
      setNewPassword(null)
      setCopied(false)
      setBusy(false)
    }
  }, [open])

  if (!open) return null

  async function submit() {
    setError(null)
    if (mode === 'manual' && manualPassword.length < 12) {
      setError('Password must be at least 12 characters, or pick "Generate random".')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/password-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType,
          targetId,
          generateRandom: mode === 'random',
          newPassword: mode === 'manual' ? manualPassword : undefined,
          reason: reason.trim() || null,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) {
        setError(j.error === 'no_auth_account'
          ? 'This contact has no linked CRM login. Send them a sign-up link instead.'
          : (j.detail || j.error || `HTTP ${res.status}`))
        setBusy(false)
        return
      }
      setNewPassword(j.password)
    } catch (err) {
      setError(err?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  function copyPassword() {
    if (!newPassword) return
    navigator.clipboard?.writeText(newPassword)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={newPassword ? undefined : onClose}
    >
      <div
        className="bg-un1t-surface border border-un1t-border rounded-lg w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <KeyRound size={16} /> Override password
          </h3>
          {!newPassword && (
            <button
              type="button"
              onClick={onClose}
              className="text-un1t-subtle hover:text-un1t-text"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <p className="text-xs text-un1t-subtle mb-4">
          Setting a new password for <strong className="text-un1t-text">{targetLabel}</strong>.
          All their existing sessions will be signed out immediately.
        </p>

        {!newPassword ? (
          <>
            <div className="inline-flex border border-un1t-border rounded-md overflow-hidden mb-3">
              {[
                { key: 'random', label: 'Generate random', Icon: RefreshCw },
                { key: 'manual', label: 'Type a password', Icon: KeyRound },
              ].map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 ${
                    mode === key ? 'bg-un1t-border text-un1t-text' : 'text-un1t-subtle hover:bg-un1t-border/30'
                  }`}
                >
                  <Icon size={12} /> {label}
                </button>
              ))}
            </div>

            {mode === 'manual' && (
              <div className="mb-3">
                <label className="block text-xs text-un1t-subtle mb-1">New password</label>
                <input
                  type="text"
                  autoFocus
                  value={manualPassword}
                  onChange={(e) => setManualPassword(e.target.value)}
                  placeholder="Type or paste the new password"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                />
                <div className="flex items-center justify-between mt-1">
                  <p className="text-[10px] text-un1t-muted">
                    Text input (not password-masked) so you can verify what you&apos;re sending.
                  </p>
                  {/* Live character count — colour-coded so the operator
                      knows exactly why 'Override password' is greyed
                      out (silently-disabled buttons were confusing). */}
                  <p className={`text-[10px] font-mono ${
                    manualPassword.length >= 12 ? 'text-emerald-400' : 'text-amber-400'
                  }`}>
                    {manualPassword.length} / 12 chars
                    {manualPassword.length < 12 && manualPassword.length > 0 && (
                      <> · need {12 - manualPassword.length} more</>
                    )}
                  </p>
                </div>
              </div>
            )}

            <label className="block text-xs text-un1t-subtle mb-1">Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. forgot password, locked out, member at front desk"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted mb-3"
            />
            <p className="text-[10px] text-un1t-muted mb-3">
              Saved to the audit log alongside who you are and when. Helps explain later if anyone asks why this account&apos;s password changed.
            </p>

            {error && (
              <p className="text-xs text-red-400 mb-3 flex items-center gap-1">
                <AlertTriangle size={12} /> {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-un1t-subtle hover:text-un1t-text px-3 py-1.5 rounded-md"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || (mode === 'manual' && manualPassword.length < 12)}
                title={
                  busy
                    ? 'Sending…'
                    : (mode === 'manual' && manualPassword.length < 12)
                      ? `Password must be at least 12 characters (currently ${manualPassword.length}). Or switch to 'Generate random'.`
                      : undefined
                }
                className="text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? 'Overriding…' : 'Override password'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 mb-3">
              <p className="text-xs text-amber-200 flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  Copy this now. Once you close the modal, the password is gone — only you and the user should know it. We never store it.
                </span>
              </p>
            </div>

            <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 mb-4 flex items-center gap-2">
              <code className="text-base font-mono text-un1t-text flex-1 break-all select-all">
                {newPassword}
              </code>
              <button
                type="button"
                onClick={copyPassword}
                className="shrink-0 inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1 rounded border border-un1t-border"
              >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <p className="text-xs text-un1t-subtle mb-1">
              <strong className="text-un1t-text">{targetLabel}&apos;s</strong> existing sessions have been signed out.
              They&apos;ll need to log in with the new password.
            </p>
            <p className="text-[11px] text-un1t-muted mb-4">
              Tell them to change it themselves after their first login (Account → Change password).
            </p>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent"
              >
                I&apos;ve copied it — close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
