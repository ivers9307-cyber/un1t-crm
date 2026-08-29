'use client'

// UIX-P1b — the unified inbox. One queue for WhatsApp + Instagram
// (docs/UNIFIED_INBOX_2026-06.md): client-side search + the
// Needs-reply/Everything split from P1a, per-row channel badge +
// unread + resolved tick. The old channel filter chips
// (All/WhatsApp/Instagram) were dropped in INBOX-REDESIGN.5 — the
// per-row ChannelGlyph already makes the channel obvious, so the row
// was redundant. The thread pane is the EXISTING channel inbox
// rendered in `embedded` mode — WAInbox/IGInbox keep owning their
// composers, templates, 24h-window logic and Resolve buttons, so
// nothing about sending changed here.
//
// INBOX-SPLIT.1 (Richard, 2026-08-07) — EMAIL IS NOT AN INBOX CHANNEL.
// EMAIL-INBOX.1 had made it a third channel here; email now has its own
// surface — today /communications/mail (RETIRE-TICKETS.1) — and
// leaving it in both places meant the same message was workable from two
// places under two different state models (email_conversations
// resolve/unresolve vs the ticket lifecycle). That is a correctness
// problem, not a convenience one. ?ch=em deep links redirect to
// /communications/mail from the page above.

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { needsReply, isAgentHandoff } from '@/lib/inbox-queues'
import { matchesSearch } from '@/lib/inbox-search'
import {
  MessageCircle, RefreshCw, Check, Inbox as InboxIcon,
  ArrowLeft, Search,
} from 'lucide-react'
import WAInbox from '@/components/WAInbox'
import IGInbox from '@/components/IGInbox'
import CommandCentre from '@/components/CommandCentre'
import { ChannelGlyph, ChannelAvatar } from '@/components/inbox/ChannelBits'
import { channelOf } from '../../shared/channels'

function formatTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString('en-IE', { weekday: 'short' })
  return d.toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })
}

// Channel-aware display name — mirrors WAInbox.getDisplayName and
// IGInbox.displayName so rows read identically to the old per-channel
// lists.
function rowName(conv) {
  if (conv.contacts?.name) return conv.contacts.name
  if (conv.contacts?.first_name) return conv.contacts.first_name
  if (conv._ch === 'wa') return conv.wa_profile_name || conv.wa_phone
  if (conv.ig_username) return `@${conv.ig_username}`
  return 'Instagram user'
}

// Two-letter initials for the queue row's ChannelAvatar tile — first
// letters of the first two words of the display name (INBOX-REDESIGN.4).
// Strips a leading "@" and splits on non-alphanumerics so Instagram
// handles like "@niamh.obrien" yield "NO" instead of a lone "@"
// (INBOX-REDESIGN.6).
function initialsOf(name) {
  return String(name || '').replace(/^@/, '').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

// The Approvals queue filter reads the SAME signal as the row's purple
// "Approval" badge below (conv.pending_approval — stamped server-side from
// a pending agent_membership_requests row by the wa/ig conversations
// routes; see src/app/api/whatsapp/conversations/route.js). Deliberately
// NOT inbox-queues.js's needsAction() — that predicate is the reply/handoff
// badge signal (needsReply || isAgentHandoff) and is unrelated to pending
// approvals (INBOX-REDESIGN.6).
function isPendingApproval(conv) {
  return !!conv?.pending_approval
}

const VALID_CHANNELS = new Set(['wa', 'ig'])

export default function UnifiedInbox({ locationId, userId, initialConversationId, initialChannel, canEditConsent = false }) {
  const [waConvs, setWaConvs] = useState([])
  const [igConvs, setIgConvs] = useState([])
  const [loading, setLoading] = useState(true)
  const [queueFilter, setQueueFilter] = useState('needs_reply')
  const [search, setSearch] = useState('')
  // INBOX-SEARCH.1 — server hits for the current query, or null when not
  // searching. The plain lists cap at the latest 50 per channel, so the
  // old client-only filter silently missed everything older; a 2+ char
  // query now also asks the server for the most-recent 50 MATCHES per
  // channel (contact name/phone/email + thread fields).
  const [serverHits, setServerHits] = useState(null)
  const [selected, setSelected] = useState(
    initialConversationId
      ? { ch: VALID_CHANNELS.has(initialChannel) ? initialChannel : 'wa', id: initialConversationId }
      : null
  )
  const [ccTab, setCcTab] = useState('profile')

  const loadConversations = useCallback(async () => {
    const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
    const [wa, ig] = await Promise.all([
      fetch(`/api/whatsapp/conversations${qs}`).then(r => r.json()).then(
        d => (d.success ? d.conversations || [] : null),
        () => null
      ),
      fetch(`/api/instagram/conversations${qs}`).then(r => r.json()).then(
        d => (d.success ? d.conversations || [] : null),
        () => null
      ),
    ])
    // Transient per-channel failures keep the prior list rather than
    // blanking part of the queue.
    if (wa) setWaConvs(wa)
    if (ig) setIgConvs(ig)
    setLoading(false)
  }, [locationId])

  useEffect(() => { loadConversations() }, [loadConversations])

  // UIX-POLISH.3 — Realtime push for the queue. The WA tables have
  // been published since mig 042; mig 256 added the Instagram tables,
  // so every inbound/outbound/resolve change now refreshes the list
  // instantly. The poll below drops to a 60s safety net (same shape
  // as WAInbox's heartbeat).
  //
  // RLS-RESTRICTIVE.1: the IG pair below delivered nothing until mig 485 —
  // their restrictive `FOR ALL ... USING (false)` deny-writes policies also
  // denied SELECT, and realtime authorises each row through the SELECT
  // policy. Only the WA pair and agent_membership_requests ever fired; the
  // 60s poll covered the rest. (The email pair was in the same boat and is
  // no longer subscribed at all — INBOX-SPLIT.1.)
  useEffect(() => {
    if (!locationId) return
    const supabase = createBrowserClient()
    const channel = supabase.channel(`unified-inbox-${locationId}`)
    for (const table of [
      'whatsapp_conversations', 'whatsapp_messages',
      'instagram_conversations', 'instagram_messages',
      'agent_membership_requests',
    ]) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        loadConversations()
      })
    }
    channel.subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [locationId, loadConversations])

  useEffect(() => {
    const t = setInterval(loadConversations, 60000)
    return () => clearInterval(t)
  }, [loadConversations])

  // INBOX-SEARCH.1 — debounced server search. Below 2 chars the server
  // hits clear and the queue falls back to the instant client filter
  // over the loaded lists (which also bridges the debounce gap).
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setServerHits(null); return undefined }
    let cancelled = false
    const t = setTimeout(async () => {
      const base = locationId ? `location_id=${encodeURIComponent(locationId)}&` : ''
      const qs = `?${base}q=${encodeURIComponent(q)}`
      const [wa, ig] = await Promise.all([
        fetch(`/api/whatsapp/conversations${qs}`).then(r => r.json()).then(d => (d.success ? d.conversations || [] : null), () => null),
        fetch(`/api/instagram/conversations${qs}`).then(r => r.json()).then(d => (d.success ? d.conversations || [] : null), () => null),
      ])
      if (cancelled) return
      // A failed channel degrades to no server hits for that channel —
      // the client filter over its loaded rows still applies via merge.
      setServerHits({ wa: wa || [], ig: ig || [] })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, locationId])

  // Quick-resolve from the queue (no need to open the thread) — for
  // messages that don't need a reply, e.g. a plain acknowledgement.
  async function quickResolve(conv) {
    const url = conv._ch === 'ig'
      ? `/api/instagram/conversations/${conv.id}`
      : `/api/whatsapp/conversations/${conv.id}`
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.success) return
      const stamp = new Date().toISOString()
      const apply = prev => prev.map(c => (c.id === conv.id ? { ...c, resolved_at: stamp } : c))
      if (conv._ch === 'ig') setIgConvs(apply)
      else setWaConvs(apply)
    } catch { /* leave state as-is */ }
  }

  const merged = [
    ...waConvs.map(c => ({ ...c, _ch: 'wa' })),
    ...igConvs.map(c => ({ ...c, _ch: 'ig' })),
  ].sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))

  const queueMatched = queueFilter === 'all'
    ? merged
    : queueFilter === 'handoff'
      ? merged.filter(isAgentHandoff)
      : queueFilter === 'approvals'
        ? merged.filter(isPendingApproval)
        : merged.filter(needsReply)

  // INBOX-SEARCH.1 — while a server search is active, rows are the
  // server hits UNIONed with client matches from the loaded lists
  // (dedup by channel:id), and the queue chips are bypassed: search is
  // global, not scoped to Needs-reply. Server hits are NOT re-filtered
  // client-side — they can match on contact phone/email, which the
  // client haystack (name + preview) doesn't contain.
  const searchActive = search.trim().length >= 2 && serverHits !== null
  let visible
  if (searchActive) {
    const hits = [
      ...serverHits.wa.map(c => ({ ...c, _ch: 'wa' })),
      ...serverHits.ig.map(c => ({ ...c, _ch: 'ig' })),
    ]
    const seen = new Set(hits.map(c => `${c._ch}:${c.id}`))
    for (const conv of merged) {
      if (seen.has(`${conv._ch}:${conv.id}`)) continue
      if (matchesSearch(`${rowName(conv)} ${conv.last_message_preview || ''}`, search)) hits.push(conv)
    }
    visible = hits.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
  } else {
    visible = queueMatched.filter(conv => matchesSearch(`${rowName(conv)} ${conv.last_message_preview || ''}`, search))
  }
  const needsReplyCount = merged.filter(needsReply).length
  const handoffCount = merged.filter(isAgentHandoff).length
  const approvalsCount = merged.filter(isPendingApproval).length

  // UIX-P2 — the command centre needs the selected thread's linked
  // contact. The queue rows already embed contacts!contact_id, so no
  // extra lookup: resolve from the merged list (null until the list
  // has loaded on a cold deep link — the pane shows a stub meanwhile).
  const selectedConv = selected
    ? (merged.find(c => c._ch === selected.ch && c.id === selected.id)
      || (searchActive ? visible.find(c => c._ch === selected.ch && c.id === selected.id) : null))
    : null
  const selectedContactId = selectedConv?.contacts?.id || null

  // When the operator resolves/replies inside the embedded thread, the
  // unified queue refreshes on the next poll tick; the refresh button
  // covers the impatient path.

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-un1t-bg">
      {/* ── Unified queue ── */}
      <div className={`${selected ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-96 border-r border-un1t-border bg-un1t-surface`}>
        <div className="flex items-center justify-between p-4 border-b border-un1t-border">
          <div className="flex items-center gap-2">
            <InboxIcon size={18} className="text-un1t-accent" />
            <h2 className="font-semibold">Inbox</h2>
            {needsReplyCount > 0 && (
              <span className="bg-green-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {needsReplyCount}
              </span>
            )}
          </div>
          <button type="button" onClick={loadConversations} className="text-un1t-subtle hover:text-un1t-text" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Search — instant client filter over the loaded queue, plus a
            debounced server search (?q=, INBOX-SEARCH.1) so matches beyond
            each channel's latest-50 window surface too. (Channel is obvious
            per-row via ChannelGlyph — the old channel-filter row is gone;
            INBOX-REDESIGN.5) */}
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-[9px] border border-un1t-border bg-un1t-surface px-[11px] py-2 text-un1t-subtle">
            <Search size={15} className="flex-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search people & messages"
              className="w-full border-0 bg-transparent text-sm text-un1t-text outline-none placeholder:text-un1t-subtle"
            />
          </div>
        </div>

        {/* Queue split chips (P1a semantics; INBOX-HANDOFF.1 added the
            agent-handoff queue; INBOX-REDESIGN.6 added Approvals and
            relabelled Everything/Agent handoff → All/Handoff per spec §4.2) */}
        <div className="flex gap-1.5 px-3 py-2 border-b border-un1t-border">
          {[['all', 'All'], ['needs_reply', 'Needs reply'], ['handoff', 'Handoff'], ['approvals', 'Approvals']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQueueFilter(key)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                queueFilter === key
                  ? key === 'handoff'
                    ? 'bg-amber-500 text-white border-transparent'
                    : key === 'approvals'
                      ? 'bg-purple-500 text-white border-transparent'
                      : 'bg-un1t-text text-un1t-bg border-transparent'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {label}
              {key === 'needs_reply' && needsReplyCount > 0 && <span className="ml-1">· {needsReplyCount}</span>}
              {key === 'handoff' && handoffCount > 0 && <span className="ml-1">· {handoffCount}</span>}
              {key === 'approvals' && approvalsCount > 0 && <span className="ml-1">· {approvalsCount}</span>}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm text-un1t-subtle text-center">Loading…</p>}

          {!loading && merged.length === 0 && (
            <div className="p-6 text-center text-sm text-un1t-subtle">
              <MessageCircle size={28} className="mx-auto mb-2 opacity-40" />
              No conversations yet.
            </div>
          )}

          {!loading && merged.length > 0 && visible.length === 0 && (
            <p className="p-4 text-xs text-un1t-subtle text-center">
              {search.trim()
                ? `No matches for "${search.trim()}"`
                : queueFilter === 'handoff'
                  ? 'No agent handoffs waiting — the agent is handling things. 🤖'
                  : 'Queue clear — nothing needs a reply. 🎉'}
            </p>
          )}

          {visible.map(conv => {
            const isSelected = selected?.id === conv.id && selected?.ch === conv._ch
            const name = rowName(conv)
            return (
              <button
                key={`${conv._ch}:${conv.id}`}
                type="button"
                onClick={() => { setSelected({ ch: conv._ch, id: conv.id }); setCcTab('profile') }}
                className={`relative grid grid-cols-[auto_auto_1fr_auto] items-center gap-[11px] w-full text-left px-4 py-3 border-b border-un1t-border/50 transition-colors ${
                  isSelected
                    ? 'bg-un1t-surface before:absolute before:inset-y-0 before:left-0 before:w-[2.5px] before:bg-un1t-text before:content-[""]'
                    : 'hover:bg-un1t-border/20'
                }`}
              >
                <ChannelGlyph channel={channelOf(conv)} />
                <ChannelAvatar channel={channelOf(conv)} initials={initialsOf(name)} />
                <div className="min-w-0 flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium text-sm truncate">{name}</span>
                    {isAgentHandoff(conv) && (
                      <span className="text-[10px] font-semibold text-amber-700 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                        Needs human
                      </span>
                    )}
                    {conv.resolved_at && <Check size={12} className="text-green-600 shrink-0" />}
                    {conv.pending_approval && (
                      <span className="text-[10px] font-semibold text-purple-700 bg-purple-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                        Approval
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-un1t-subtle truncate">{conv.last_message_preview || '—'}</span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-xs text-un1t-muted shrink-0">{formatTime(conv.last_message_at)}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {conv.unread_count > 0 && (
                      <span className="bg-green-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        {conv.unread_count}
                      </span>
                    )}
                    {(needsReply(conv) || isAgentHandoff(conv)) && (
                      <span
                        role="button"
                        tabIndex={0}
                        title={isAgentHandoff(conv) ? 'Mark handled — hand back to the agent' : 'Mark handled — no reply needed'}
                        onClick={e => { e.stopPropagation(); quickResolve(conv) }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); quickResolve(conv) } }}
                        className="p-1 rounded-md border border-un1t-border text-un1t-muted hover:text-emerald-700 hover:border-emerald-600 transition-colors"
                      >
                        <Check size={11} />
                      </span>
                    )}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Thread (embedded channel inbox) ── */}
      <div className={`${selected ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-un1t-subtle">
            <div className="text-center">
              <InboxIcon size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a conversation</p>
            </div>
          </div>
        ) : (
          <>
            {/* Mobile back to the unified queue */}
            <button
              onClick={() => setSelected(null)}
              className="md:hidden flex items-center gap-1.5 px-4 py-2 text-xs text-un1t-subtle border-b border-un1t-border"
            >
              <ArrowLeft size={14} /> Back to inbox
            </button>
            <div className="flex-1 min-h-0">
              {selected.ch === 'wa' ? (
                <WAInbox
                  embedded
                  locationId={locationId}
                  userId={userId}
                  initialConversationId={selected.id}
                  onOpenBookTab={() => setCcTab('book')}
                />
              ) : (
                <IGInbox
                  embedded
                  locationId={locationId}
                  initialConversationId={selected.id}
                  onOpenBookTab={() => setCcTab('book')}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Contact command centre (UIX-P2, desktop) ── */}
      {selected && (
        <div className="hidden xl:flex flex-col w-80 border-l border-un1t-border bg-un1t-surface shrink-0">
          {selectedContactId ? (
            <CommandCentre
              key={selectedContactId}
              contactId={selectedContactId}
              locationId={locationId}
              canEditConsent={canEditConsent}
              channel={selected.ch}
              conversationId={selected.id}
              tab={ccTab}
              onTabChange={setCcTab}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-un1t-subtle">
              No linked contact yet — use “Add to Contacts” in the thread header.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
