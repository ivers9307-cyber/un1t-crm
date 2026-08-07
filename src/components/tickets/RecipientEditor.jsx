'use client'

// EMAIL-CC.1 — the recipient editor, shared by every ticket send surface.
//
// WHY IT IS ITS OWN COMPONENT AND NOT INLINE IN THE COMPOSER
// Three surfaces need it — New email, Reply, and the Forward that lands next —
// and the interesting behaviour is not the chips. It is the two rules that
// must read identically wherever recipients are edited:
//
//   • LOCKED PARTICIPANTS. On a reply, everybody already on the thread is
//     shown as a chip that CANNOT be removed. Richard, 2026-08-07: it must be
//     impossible to silently drop someone from a conversation. The server
//     enforces it (the reply route always includes the derived participants
//     and has no wire format for removing one); this is the affordance that
//     stops an operator trying. The escape hatch is deliberate and explicit —
//     start a new email to a narrower set — not a delete key here.
//   • CC/BCC ARE HIDDEN UNTIL WANTED, as every mail client does, and revealed
//     for good the moment either holds an address. A permanently-open Bcc
//     field on a support reply invites a Bcc nobody needed.
//
// BCC IS LABELLED, NOT JUST PLACED. "Hidden from everyone else on this email"
// sits under the field, because the one thing a person must not have to
// remember at 5pm is which of two adjacent boxes is the private one.
//
// Validation is the SAME normalizeAddress() the server gates on, imported
// rather than re-expressed — an affordance that accepts what the route refuses
// is a form that loses your work on submit.

import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { MAX_RECIPIENTS, normalizeAddress } from '@/lib/email-recipients'

const FIELDS = [
  { key: 'to', label: 'To', hint: null },
  { key: 'cc', label: 'Cc', hint: 'Everyone on this email can see the Cc list.' },
  { key: 'bcc', label: 'Bcc', hint: 'Hidden from everyone else on this email.' },
]

const INPUT_CLASSES =
  'min-w-[12rem] flex-1 bg-transparent text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none'

const BOX_CLASSES =
  'flex flex-wrap items-center gap-1.5 rounded-md border border-un1t-border bg-un1t-bg px-2 py-1.5 focus-within:ring-1 focus-within:ring-un1t-text/30'

/**
 * @param {object} props
 * @param {{to: string[], cc: string[], bcc: string[]}} props.value  editable additions
 * @param {(next: {to: string[], cc: string[], bcc: string[]}) => void} props.onChange
 * @param {string[]} [props.lockedTo]  thread participants — shown, never removable
 * @param {string} [props.lockedHint]  why they cannot be removed
 * @param {boolean} [props.disabled]
 * @param {string} props.idPrefix  unique per mounted editor
 */
export default function RecipientEditor({
  value,
  onChange,
  lockedTo = [],
  lockedHint,
  disabled = false,
  idPrefix,
}) {
  const hasExtras = value.cc.length > 0 || value.bcc.length > 0
  const [showExtras, setShowExtras] = useState(hasExtras)
  const [drafts, setDrafts] = useState({ to: '', cc: '', bcc: '' })
  const [error, setError] = useState(null)

  const total = lockedTo.length + value.to.length + value.cc.length + value.bcc.length
  const full = total >= MAX_RECIPIENTS

  // Every address already committed anywhere, so the same person cannot be
  // added twice from two different boxes. The server dedupes across all three
  // lists regardless (To > Cc > Bcc); this stops the operator watching it
  // happen silently after they press send.
  const claimed = new Set([...lockedTo, ...value.to, ...value.cc, ...value.bcc])

  function commit(field, raw) {
    const text = String(raw || '').trim().replace(/[,;]+$/, '')
    if (!text) return true
    const address = normalizeAddress(text)
    if (!address) {
      setError(`"${text}" is not a valid email address.`)
      return false
    }
    if (claimed.has(address)) {
      // Not an error — they meant to include this person and this person is
      // included. Swallow the duplicate and clear the box.
      setError(null)
      return true
    }
    if (full) {
      setError(`That is ${MAX_RECIPIENTS + 1} recipients — the limit is ${MAX_RECIPIENTS} across To, Cc and Bcc.`)
      return false
    }
    setError(null)
    onChange({ ...value, [field]: [...value[field], address] })
    return true
  }

  function handleKeyDown(field, e) {
    // Enter / comma / semicolon / Tab all commit — people paste address lists
    // in every one of those shapes, and a Tab that moved focus while eating
    // the address is the version of this bug that loses a recipient silently.
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
      const draft = drafts[field]
      if (!draft.trim()) return
      // Tab still moves focus when the value is good; it must not when the
      // address was rejected, or the error scrolls away unread.
      const ok = commit(field, draft)
      if (e.key !== 'Tab' || !ok) e.preventDefault()
      if (ok) setDrafts(d => ({ ...d, [field]: '' }))
      return
    }
    if (e.key === 'Backspace' && !drafts[field] && value[field].length) {
      onChange({ ...value, [field]: value[field].slice(0, -1) })
    }
  }

  function handlePaste(field, e) {
    const text = e.clipboardData?.getData('text') || ''
    if (!/[,;\s]/.test(text.trim())) return
    e.preventDefault()
    let next = { ...value }
    const seen = new Set(claimed)
    let rejected = null
    let count = lockedTo.length + next.to.length + next.cc.length + next.bcc.length
    for (const part of text.split(/[,;\s]+/)) {
      if (!part.trim()) continue
      const address = normalizeAddress(part)
      if (!address) { rejected = rejected || part.trim(); continue }
      if (seen.has(address)) continue
      if (count >= MAX_RECIPIENTS) {
        rejected = rejected || `more than ${MAX_RECIPIENTS} recipients`
        break
      }
      seen.add(address)
      count += 1
      next = { ...next, [field]: [...next[field], address] }
    }
    setError(rejected ? `Skipped ${rejected}.` : null)
    setDrafts(d => ({ ...d, [field]: '' }))
    onChange(next)
  }

  function remove(field, address) {
    setError(null)
    onChange({ ...value, [field]: value[field].filter(a => a !== address) })
  }

  const visible = showExtras ? FIELDS : FIELDS.slice(0, 1)

  return (
    <div className="space-y-2">
      {visible.map(field => (
        <div key={field.key}>
          <div className="flex items-baseline justify-between gap-2">
            <label
              htmlFor={`${idPrefix}-${field.key}`}
              className="text-[11px] font-medium uppercase tracking-wider text-un1t-muted"
            >
              {field.label}
            </label>
            {/* The reveal lives on the To row so it is where the eye already
                is, and it disappears once the fields are open — a toggle that
                could re-hide a Bcc someone typed would hide a recipient. */}
            {field.key === 'to' && !showExtras && (
              <button
                type="button"
                onClick={() => setShowExtras(true)}
                disabled={disabled}
                className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-un1t-text"
              >
                <Plus size={11} aria-hidden="true" />
                Cc / Bcc
              </button>
            )}
          </div>

          <div className={BOX_CLASSES}>
            {field.key === 'to' && lockedTo.map(address => (
              <span
                key={`locked-${address}`}
                title={lockedHint}
                className="inline-flex items-center gap-1 rounded-full bg-un1t-surface px-2 py-0.5 text-xs text-un1t-text"
              >
                {address}
              </span>
            ))}
            {value[field.key].map(address => (
              <span
                key={address}
                className="inline-flex items-center gap-1 rounded-full bg-un1t-surface px-2 py-0.5 text-xs text-un1t-text"
              >
                {address}
                <button
                  type="button"
                  onClick={() => remove(field.key, address)}
                  disabled={disabled}
                  aria-label={`Remove ${address}`}
                  className="text-un1t-subtle hover:text-un1t-text"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
            <input
              id={`${idPrefix}-${field.key}`}
              type="text"
              inputMode="email"
              autoComplete="off"
              value={drafts[field.key]}
              disabled={disabled}
              onChange={(e) => setDrafts(d => ({ ...d, [field.key]: e.target.value }))}
              onKeyDown={(e) => handleKeyDown(field.key, e)}
              onPaste={(e) => handlePaste(field.key, e)}
              // Commit on blur too: an address left sitting in the box when
              // someone clicks Send is an address they believe they added.
              onBlur={() => {
                if (commit(field.key, drafts[field.key])) {
                  setDrafts(d => ({ ...d, [field.key]: '' }))
                }
              }}
              placeholder={
                field.key === 'to' && (lockedTo.length || value.to.length)
                  ? 'Add another…'
                  : 'name@example.com'
              }
              className={INPUT_CLASSES}
            />
          </div>

          {field.hint && (
            <p className="mt-0.5 text-[11px] text-un1t-muted">{field.hint}</p>
          )}
        </div>
      ))}

      {lockedTo.length > 0 && lockedHint && (
        <p className="text-[11px] text-un1t-muted">{lockedHint}</p>
      )}

      {error && (
        <p className="text-[11px] text-red-700" role="alert">{error}</p>
      )}

      {full && (
        <p className="text-[11px] text-amber-700">
          {MAX_RECIPIENTS} recipients — the limit for one email.
        </p>
      )}
    </div>
  )
}

/** The empty value, so callers do not each invent their own shape. */
export const EMPTY_RECIPIENTS = Object.freeze({ to: [], cc: [], bcc: [] })
