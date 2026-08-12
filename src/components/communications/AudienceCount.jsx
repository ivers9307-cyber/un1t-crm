'use client'

// FILTER-B.2 — ONE audience-count surface, mounted in every builder host.
//
// Before this, three of the five hosts (WhatsApp broadcast, SMS broadcast,
// sequence settings) passed `audienceCount={null}`: they rendered the filter
// builder with no number at all. Every defect the correctness phase fixed —
// a blank date value, an unresolvable tag, a filter that matches nobody — was
// SILENT in those three surfaces. The composer's count block (number, the
// "N match · M will receive it" split, the excluded-reason breakdown, the
// error state, the loading state) lives here instead of inline so all four
// hosts show the same thing.
//
// Two rules this component exists to keep:
//
//  1. CHANNEL PARITY. /api/communications/audience-count has send-parity
//     branches for email, SMS and WhatsApp — each host asks for its OWN
//     channel. A WhatsApp broadcast showing an email-reachable count would be
//     a new lie, not a fix, so `channel` is a required part of the contract
//     for every send surface.
//
//  2. A SEQUENCE IS NOT A SEND. Since SEQEXIT.1 a sequence's audience filter
//     is a CONTINUING condition, re-checked before every step: it decides who
//     enrols AND who stays, not who receives one message. mode="matching"
//     therefore asks channel-agnostically and labels the number as a match.
//     Never mount mode="send" on a sequence — a will-receive number there
//     would be a recipient count for a send that does not exist.

import { useEffect, useRef, useState } from 'react'
import { Users, AlertTriangle, Loader2 } from 'lucide-react'
import { stripUnsetFilterRows } from '@/lib/audience-filter'
import AudiencePreview from './AudiencePreview'

const EMPTY_FILTER = { logic: 'and', filters: [] }

// Reason keys the count route returns per channel, in the order an operator
// should read them, with their operator-facing wording. Reasons are
// INDEPENDENT counts and may overlap — never sum them.
const EXCLUDED_LABELS = {
  email: [
    ['not_opted_in', n => `${n} no marketing opt-in`],
    ['bounced_or_complained', n => `${n} bounced or complained`],
    // NOENGSUP.1 — was "inactive 90+ days". The engagement rule that produced
    // that population is retired (mig 537); the stamp now only ever means
    // repeat bounces, so the label has to say so or it names a reason that no
    // longer exists.
    ['suppressed', n => `${n} suppressed for repeat bounces`],
  ],
  sms: [
    ['no_phone', n => `${n} no phone number`],
    ['not_opted_in', n => `${n} no marketing opt-in`],
    ['opted_out', n => `${n} opted out`],
  ],
  whatsapp: [
    ['no_number', n => `${n} no WhatsApp number`],
    ['no_consent', n => `${n} no marketing opt-in`],
    ['opted_out', n => `${n} opted out`],
    ['undeliverable', n => `${n} not on WhatsApp`],
  ],
}

function reasonText(channel, excluded) {
  if (!excluded) return ''
  return (EXCLUDED_LABELS[channel] || [])
    .map(([key, fmt]) => (excluded[key] ? fmt(excluded[key].toLocaleString()) : null))
    .filter(Boolean)
    .join(', ')
}

function countUnsetRows(filter) {
  const before = Array.isArray(filter?.filters) ? filter.filters.length : 0
  const after = stripUnsetFilterRows(filter)?.filters?.length ?? before
  return before - after
}

/**
 * @param {string}   locationId  required — the location the audience is counted at.
 * @param {object}   filter      the RAW builder filter (unset rows are stripped here).
 * @param {'email'|'sms'|'whatsapp'|null} channel  required in send mode.
 * @param {'send'|'matching'} mode  'matching' = a continuing condition, not a send.
 * @param {(result)=>void} onResult  optional — lets a host gate Send on this
 *        exact number instead of counting a second time.
 * @param {boolean} showPreview  render the "show me who matches" drawer.
 */
export default function AudienceCount({
  locationId,
  filter,
  channel = null,
  mode = 'send',
  onResult = null,
  showPreview = true,
  className = '',
}) {
  const matching = mode === 'matching'
  // A matching count is deliberately channel-agnostic: a sequence's steps can
  // be any channel, and the question being answered is "who is in this
  // audience", not "who could we email".
  const askChannel = matching ? null : channel

  const [state, setState] = useState('loading')   // 'loading' | 'ready' | 'error'
  const [count, setCount] = useState(null)
  const [matched, setMatched] = useState(null)
  const [reachable, setReachable] = useState(null)
  const [excluded, setExcluded] = useState(null)
  const [error, setError] = useState(null)

  // stripUnsetFilterRows is applied at the ONE point the filter leaves the
  // builder, so a half-built row can never be counted (and the operator is
  // told below that it is being ignored).
  const sent = stripUnsetFilterRows(filter) || EMPTY_FILTER
  const sentKey = JSON.stringify(sent)
  const unsetRows = countUnsetRows(filter)

  // onResult is called from the effect; keeping it in a ref means a host that
  // passes an inline arrow does not re-trigger the count on every render.
  const onResultRef = useRef(onResult)
  useEffect(() => { onResultRef.current = onResult })

  useEffect(() => {
    let alive = true
    setState('loading')
    onResultRef.current?.({
      status: 'loading', count: null, matched: null, reachable: null,
      excluded: null, sendable: null, error: null,
    })
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/communications/audience-count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: locationId,
            audience_filter: JSON.parse(sentKey),
            ...(askChannel ? { channel: askChannel } : {}),
          }),
        })
        const data = await res.json()
        if (!alive) return
        if (data?.success) {
          const nextCount = data.count ?? null
          const nextMatched = typeof data.matched === 'number' ? data.matched : null
          const nextReachable = askChannel === 'whatsapp' ? (data.reachable ?? null) : null
          setCount(nextCount); setMatched(nextMatched)
          setReachable(nextReachable); setExcluded(data.excluded ?? null)
          setError(null); setState('ready')
          onResultRef.current?.({
            status: 'ready',
            count: nextCount,
            matched: askChannel === 'whatsapp' ? nextCount : (nextMatched ?? nextCount),
            reachable: nextReachable,
            excluded: data.excluded ?? null,
            // The number a host must gate Send on: for WhatsApp the reachable
            // set, for everything else the will-receive count.
            sendable: askChannel === 'whatsapp' ? nextReachable : nextCount,
            error: null,
          })
        } else {
          // Surface the server's message (InvalidAudienceFilterError → 400)
          // instead of silently rendering the add-a-condition placeholder.
          const msg = data?.error || `Couldn't count the audience (${res.status})`
          setCount(null); setMatched(null); setReachable(null); setExcluded(null)
          setError(msg); setState('error')
          onResultRef.current?.({
            status: 'error', count: null, matched: null, reachable: null,
            excluded: null, sendable: null, error: msg,
          })
        }
      } catch {
        if (!alive) return
        const msg = 'Couldn’t count the audience — check your connection and try again.'
        setCount(null); setMatched(null); setReachable(null); setExcluded(null)
        setError(msg); setState('error')
        onResultRef.current?.({
          status: 'error', count: null, matched: null, reachable: null,
          excluded: null, sendable: null, error: msg,
        })
      }
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [locationId, sentKey, askChannel])

  const gap = (matched ?? 0) - (count ?? 0)
  const waGap = (count ?? 0) - (reachable ?? 0)
  const reasons = reasonText(askChannel, excluded)

  return (
    <div className={`flex flex-col gap-0.5 text-xs text-un1t-subtle ${className}`}>
      <div className="flex items-center gap-1.5">
        <Users size={13} />
        {state === 'loading'
          ? <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> counting…</span>
          : state === 'error'
            ? <span className="flex items-start gap-1.5 text-rose-700"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{error}</span>
            : count == null
              ? <span>Add a condition to see how many contacts match.</span>
              : matching
                // SEQEXIT.1 — a match count, said out loud as a match count.
                ? <span><b className="text-un1t-text">{count.toLocaleString()}</b> contact{count === 1 ? '' : 's'} currently match this audience</span>
                : askChannel === 'whatsapp'
                  ? <span><b className="text-un1t-text">{count.toLocaleString()}</b> match · <b className="text-un1t-text">{(reachable ?? 0).toLocaleString()}</b> reachable on WhatsApp</span>
                  : matched != null
                    ? <span><b className="text-un1t-text">{matched.toLocaleString()}</b> match this filter · <b className="text-un1t-text">{count.toLocaleString()}</b> will receive it</span>
                    : <span><b className="text-un1t-text">{count.toLocaleString()}</b> contact{count === 1 ? '' : 's'} match this filter</span>}
      </div>

      {matching && state === 'ready' && count != null && (
        <p className="text-un1t-subtle/80">
          This is a continuing condition — it is re-checked before every step, so it decides
          who enrols and who stays, not who receives one send.
        </p>
      )}

      {/* Reasons are independent counts and may overlap — never summed. */}
      {!matching && state === 'ready' && askChannel !== 'whatsapp' && excluded && gap > 0 && (
        <div className="flex items-start gap-1.5 text-amber-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{gap.toLocaleString()} won&apos;t receive it{reasons ? ` — ${reasons}` : ''}</span>
        </div>
      )}
      {!matching && state === 'ready' && askChannel === 'whatsapp' && count != null && reachable != null && waGap > 0 && (
        <div className="flex items-start gap-1.5 text-amber-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{waGap.toLocaleString()} excluded{reasons ? ` — ${reasons}` : ''}</span>
        </div>
      )}

      {/* FILTER-B.2 — an unset row is INERT server-side (applyAudienceFilter
          skips it), which is exactly why it has to be said out loud: the
          operator meant to narrow the audience and it did not happen. This is
          the guardrail that makes an unset starting row safe on a send
          surface — the widening failure is now stated, not merely countable. */}
      {showPreview && (
        /* FILTER-B.9 — the preview is fed the SAME stripped filter and the
           SAME channel the count above just used, so the list it shows is the
           list that number stands for. Disabled until a count has arrived:
           there is nothing honest to preview against a failing filter. */
        <AudiencePreview
          locationId={locationId}
          filter={sent}
          channel={askChannel}
          mode={mode}
          disabled={state !== 'ready'}
        />
      )}

      {unsetRows > 0 && (
        <div className="flex items-start gap-1.5 text-amber-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {unsetRows} unfinished filter row{unsetRows === 1 ? ' is' : 's are'} being ignored — pick a
            field, or remove the row{unsetRows === 1 ? '' : 's'}.
          </span>
        </div>
      )}

    </div>
  )
}
