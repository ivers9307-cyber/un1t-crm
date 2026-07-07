'use client'

// UIX-P1b — the unified inbox. One queue for WhatsApp + Instagram
// (docs/UNIFIED_INBOX_2026-06.md): channel filter chips, the
// Needs-reply/Everything split from P1a, per-row channel badge +
// unread + resolved tick. The thread pane is the EXISTING channel
// inbox rendered in `embedded` mode — WAInbox/IGInbox keep owning
// their composers, templates, 24h-window logic and Resolve buttons,
// so nothing about sending changed here.

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { needsReply, isAgentHandoff } from '@/lib/inbox-queues'
import {
  MessageCircle, Instagram, RefreshCw, Check, Inbox as InboxIcon,
  ArrowLeft,
} from 'lucide-react'
import WAInbox from '@/components/WAInbox'
import IGInbox from '@/components/IGInbox'
import CommandCentre from '@/components/CommandCentre'

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

const CHANNELS = [
  ['all', 'All'],
  ['wa', 'WhatsApp'],
  ['ig', 'Instagram'],
]

export default function UnifiedInbox({ locationId, userId, initialConversationId, initialChannel, canEditConsent = false }) {
  const [waConvs, setWaConvs] = useState([])
  const [igConvs, setIgConvs] = useState([])
  const [loading, setLoading] = useState(true)
  const [channelFilter, setChannelFilter] = useState('all')
  const [queueFilter, setQueueFilter] = useState('needs_reply')
  const [selected, setSelected] = useState(
    initialConversationId ? { ch: initialChannel === 'ig' ? 'ig' : 'wa', id: initialConversationId } : null
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
    // blanking half the queue.
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

  const channelMatched = channelFilter === 'all' ? merged : merged.filter(c => c._ch === channelFilter)
  const visible = queueFilter === 'all'
    ? channelMatched
    : channelMatched.filter(queueFilter === 'handoff' ? isAgentHandoff : needsReply)
  const needsReplyCount = merged.filter(needsReply).length
  const handoffCount = merged.filter(isAgentHandoff).length

  // UIX-P2 — the command centre needs the selected thread's linked
  // contact. The queue rows already embed contacts!contact_id, so no
  // extra lookup: resolve from the merged list (null until the list
  // has loaded on a cold deep link — the pane shows a stub meanwhile).
  const selectedConv = selected
    ? merged.find(c => c._ch === selected.ch && c.id === selected.id)
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
          <button onClick={loadConversations} className="text-un1t-subtle hover:text-un1t-text" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Channel chips */}
        <div className="flex gap-1.5 px-3 pt-2">
          {CHANNELS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setChannelFilter(key)}
              className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                channelFilter === key
                  ? 'bg-un1t-text text-un1t-bg border-transparent'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {key === 'wa' && <MessageCircle size={11} />}
              {key === 'ig' && <Instagram size={11} />}
              {label}
            </button>
          ))}
        </div>

        {/* Queue split chips (P1a semantics; INBOX-HANDOFF.1 added the agent-handoff queue) */}
        <div className="flex gap-1.5 px-3 py-2 border-b border-un1t-border">
          {[['needs_reply', 'Needs reply'], ['handoff', 'Agent handoff'], ['all', 'Everything']].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setQueueFilter(key)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                queueFilter === key
                  ? key === 'handoff'
                    ? 'bg-amber-500 text-white border-transparent'
                    : 'bg-un1t-text text-un1t-bg border-transparent'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {label}
              {key === 'needs_reply' && needsReplyCount > 0 && <span className="ml-1">· {needsReplyCount}</span>}
              {key === 'handoff' && handoffCount > 0 && <span className="ml-1">· {handoffCount}</span>}
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
              {queueFilter === 'handoff'
                ? 'No agent handoffs waiting — the agent is handling things. 🤖'
                : 'Queue clear — nothing needs a reply. 🎉'}
            </p>
          )}

          {visible.map(conv => {
            const isSelected = selected?.id === conv.id && selected?.ch === conv._ch
            return (
              <button
                key={`${conv._ch}:${conv.id}`}
                onClick={() => { setSelected({ ch: conv._ch, id: conv.id }); setCcTab('profile') }}
                className={`w-full text-left px-4 py-3 border-b border-un1t-border/50 transition-colors ${
                  isSelected ? 'bg-un1t-border/50' : 'hover:bg-un1t-border/20'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {conv._ch === 'wa'
                      ? <MessageCircle size={13} className="text-green-600 shrink-0" />
                      : <Instagram size={13} className="text-pink-600 shrink-0" />}
                    <span className="font-medium text-sm truncate">{rowName(conv)}</span>
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
                  <span className="text-xs text-un1t-muted shrink-0">{formatTime(conv.last_message_at)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5 pl-[19px]">
                  <span className="text-xs text-un1t-subtle truncate">{conv.last_message_preview || '—'}</span>
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
