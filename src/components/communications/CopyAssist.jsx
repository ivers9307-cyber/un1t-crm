'use client'

// GAPS-P8 — the one copy-assist surface, shared by the unified composer and the
// full campaign editor. There is deliberately no second copy of this UI.
//
// Assist, never autopilot:
//   - nothing is requested until the operator clicks Suggest,
//   - nothing is applied until the operator clicks Use,
//   - the body variants only ever copy to the clipboard, because the body lives
//     in the Unlayer designer and writing into it would silently destroy the
//     design the operator built,
//   - the panel says plainly that the text is machine-generated, unreviewed,
//     and ignorant of the studio's offers, prices and timetable.
//
// It also fails quiet. Any error, any unset key, any upstream outage renders a
// single low-key line and leaves the composer exactly as it was.

import { useState } from 'react'
import { Wand2, Check, Copy, ChevronDown, ChevronUp } from 'lucide-react'

const KINDS = [
  { key: 'subject', label: 'Subject lines' },
  { key: 'body', label: 'Body copy' },
]

const inputCls =
  'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted'

export default function CopyAssist({
  locationId,
  subject = '',
  getBody,
  onUseSubject,
  allowBody = true,
  className = '',
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('subject')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [droppedCount, setDroppedCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [copiedIndex, setCopiedIndex] = useState(-1)

  const kinds = allowBody ? KINDS : KINDS.filter((k) => k.key === 'subject')

  async function requestSuggestions() {
    if (busy || !locationId) return
    setBusy(true)
    setNotice('')
    setSuggestions([])
    setDroppedCount(0)
    setCopiedIndex(-1)
    try {
      let body = ''
      if (typeof getBody === 'function') {
        try { body = (await getBody()) || '' } catch { body = '' }
      }
      const res = await fetch('/api/campaigns/copy-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, kind, brief: brief.trim(), subject, body }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        setNotice(json?.error || 'Suggestions are not available right now. Carry on writing, nothing else is affected.')
        return
      }
      if (!json.data?.available) {
        setNotice('Suggestions are not available right now. Carry on writing, nothing else is affected.')
        return
      }
      setSuggestions(json.data.suggestions || [])
      setDroppedCount((json.data.dropped || []).length)
      if (!(json.data.suggestions || []).length) {
        setNotice('Nothing usable came back. Try adding a line more detail to the brief.')
      }
    } catch {
      setNotice('Suggestions are not available right now. Carry on writing, nothing else is affected.')
    } finally {
      setBusy(false)
    }
  }

  async function copyToClipboard(text, index) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
    } catch {
      setNotice('Could not copy. Select the text and copy it manually.')
    }
  }

  const canSuggest = !busy && (brief.trim().length > 0 || subject.trim().length > 0)

  return (
    <div className={`border border-un1t-border rounded-md ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm text-un1t-text hover:bg-un1t-surface rounded-md"
      >
        <span className="flex items-center gap-2">
          <Wand2 size={14} className="text-un1t-subtle" aria-hidden="true" />
          Suggest alternatives
          <span className="text-[11px] text-un1t-subtle">Machine-generated</span>
        </span>
        {open
          ? <ChevronUp size={14} className="text-un1t-subtle" aria-hidden="true" />
          : <ChevronDown size={14} className="text-un1t-subtle" aria-hidden="true" />}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-un1t-border">
          <p className="text-[11px] text-un1t-subtle">
            Written by a language model and not reviewed by anyone. It only rewrites what you type
            here. It does not know the studio&apos;s offers, prices, dates or timetable, so every
            fact has to come from you. Check anything factual before you send.
          </p>

          {kinds.length > 1 && (
            <div className="inline-flex rounded-md border border-un1t-border overflow-hidden">
              {kinds.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => { setKind(k.key); setSuggestions([]); setNotice(''); setDroppedCount(0) }}
                  aria-pressed={kind === k.key}
                  className={`px-3 py-1.5 text-xs ${kind === k.key ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                >{k.label}</button>
              ))}
            </div>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-un1t-subtle mb-1">What is this email about?</span>
            <textarea
              rows={2}
              maxLength={600}
              className={inputCls}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="One or two lines. Include any price, date or offer you want mentioned, it will not invent them."
            />
          </label>

          <button
            type="button"
            onClick={requestSuggestions}
            disabled={!canSuggest}
            className="px-3 py-1.5 text-sm rounded-md bg-un1t-text text-un1t-bg disabled:opacity-40"
          >
            {busy ? 'Suggesting…' : 'Suggest'}
          </button>

          <div aria-live="polite" className="space-y-2">
            {notice && <p className="text-xs text-un1t-subtle">{notice}</p>}

            {suggestions.map((s, i) => (
              <div key={`${i}-${s.slice(0, 24)}`} className="flex items-start gap-2 rounded-md border border-un1t-border p-2">
                <p className="flex-1 text-sm text-un1t-text whitespace-pre-wrap break-words">{s}</p>
                {kind === 'subject' && typeof onUseSubject === 'function' ? (
                  <button
                    type="button"
                    onClick={() => onUseSubject(s)}
                    className="shrink-0 px-2 py-1 text-xs rounded border border-un1t-border text-un1t-text hover:bg-un1t-surface"
                  >Use</button>
                ) : (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(s, i)}
                    className="shrink-0 px-2 py-1 text-xs rounded border border-un1t-border text-un1t-text hover:bg-un1t-surface inline-flex items-center gap-1"
                  >
                    {copiedIndex === i
                      ? <><Check size={12} aria-hidden="true" />Copied</>
                      : <><Copy size={12} aria-hidden="true" />Copy</>}
                  </button>
                )}
              </div>
            ))}

            {droppedCount > 0 && (
              <p className="text-[11px] text-amber-700">
                {droppedCount === 1 ? '1 suggestion was' : `${droppedCount} suggestions were`} discarded for
                inventing a detail, repeating your draft, or naming how many places are left.
              </p>
            )}
          </div>

          {kind === 'body' && suggestions.length > 0 && (
            <p className="text-[11px] text-un1t-subtle">
              Body suggestions copy to the clipboard. Paste the parts you want into the designer so
              your layout stays as you built it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
