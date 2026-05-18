'use client'

// Self-service password change on /account.
//
// Two-step flow per submit:
//   1. signInWithPassword({ email, password: currentPassword }) —
//      re-authenticates to confirm the user actually knows their
//      current password. Supabase's updateUser() ALONE wouldn't
//      require this (a live session is enough auth at the API
//      layer), but UX-wise we ask for the current password so an
//      unattended logged-in machine can't be hijacked into a
//      silent password reset.
//   2. updateUser({ password: newPassword }) — sets the new
//      password. Session stays live; the user remains signed in
//      on this device.
//
// All requirements mirror the same `passwordRequirements` list used
// by the /reset-password landing page and the staff invite flow, so
// the validation surface is consistent everywhere a user picks a
// password.

import { useState, useMemo } from 'react'
import { Check, X, Eye, EyeOff, Lock, KeyRound, Loader2 } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { passwordRequirements, validatePasswordComplexity } from '@/lib/schemas'

export default function PasswordChangeForm({ email }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState(null)

  // Live requirement state for the green/red ticks under the new
  // password field.
  const reqState = useMemo(
    () => passwordRequirements.map((r) => ({ ...r, ok: r.test(newPassword) })),
    [newPassword],
  )
  const newPasswordValid = useMemo(
    () => validatePasswordComplexity(newPassword) === null,
    [newPassword],
  )
  const confirmMatches = newPassword.length > 0 && newPassword === confirmPassword
  const canSubmit = !busy && currentPassword.length > 0 && newPasswordValid && confirmMatches

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setSuccess(false)
    setBusy(true)
    const supabase = createBrowserClient()
    try {
      // Step 1 — re-authenticate. Supabase silently returns the
      // existing session as the result, which is fine; what matters
      // here is whether it errors when the password is wrong.
      const { error: reauthErr } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      })
      if (reauthErr) {
        setError('Current password is incorrect.')
        setBusy(false)
        return
      }
      // Step 2 — set the new password.
      const { error: updateErr } = await supabase.auth.updateUser({
        password: newPassword,
      })
      if (updateErr) {
        setError(updateErr.message || 'Could not update password.')
        setBusy(false)
        return
      }
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err.message || 'Unexpected error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-un1t-light" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-light">
          Password
        </h2>
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-4 space-y-3">
        <FieldRow
          label="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          show={show}
          autoComplete="current-password"
        />

        <FieldRow
          label="New password"
          value={newPassword}
          onChange={setNewPassword}
          show={show}
          autoComplete="new-password"
        />

        {/* Live requirements list — green tick when the rule passes,
            grey X otherwise. Only shows after the user starts typing
            a new password to avoid a wall of red on initial render. */}
        {newPassword.length > 0 && (
          <ul className="space-y-1 pl-1">
            {reqState.map((r) => (
              <li key={r.id} className={`text-xs inline-flex items-center gap-1.5 mr-3 ${r.ok ? 'text-emerald-700' : 'text-un1t-mid'}`}>
                {r.ok ? <Check size={11} /> : <X size={11} />}
                {r.label}
              </li>
            ))}
          </ul>
        )}

        <FieldRow
          label="Confirm new password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          show={show}
          autoComplete="new-password"
        />
        {confirmPassword.length > 0 && !confirmMatches && (
          <p className="text-xs text-red-500">Passwords don&apos;t match.</p>
        )}

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
            title={show ? 'Hide passwords' : 'Show passwords'}
          >
            {show ? <EyeOff size={12} /> : <Eye size={12} />}
            {show ? 'Hide' : 'Show'}
          </button>

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black px-4 py-2 rounded-md text-sm font-medium hover:bg-un1t-accent disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
            {busy ? 'Updating…' : 'Change password'}
          </button>
        </div>

        {success && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 rounded-md px-3 py-2 text-xs inline-flex items-center gap-2">
            <Check size={12} /> Password updated. You stay signed in on this device.
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-500 rounded-md px-3 py-2 text-xs">
            {error}
          </div>
        )}

        <p className="text-[11px] text-un1t-mid pt-1">
          Forgot your current password? Sign out and use the &quot;Forgot password?&quot;
          link on the sign-in page to receive a reset email.
        </p>
      </div>
    </form>
  )
}

function FieldRow({ label, value, onChange, show, autoComplete }) {
  return (
    <div>
      <label className="block text-xs text-un1t-light mb-1">{label}</label>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
      />
    </div>
  )
}
