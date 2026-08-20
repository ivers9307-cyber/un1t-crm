'use client'

// Operator Instagram inbox. Mirrors WAInbox but simpler: no 24h-window
// templates or broadcasts. Inbound media (images/video/audio) received via
// DM renders inline (IG-MEDIA.1); outbound is still text-only. Staff can
// read threads the agent is handling, send a manual reply (which takes the
// thread OVER from the agent), and hand it back.

// IG-MEDIA.3 — the "does this row carry servable media" rule now lives in
// shared/ (isServableInstagramMedia) so this inbox and the mobile app agree.
// Mobile had no such rule at all, which is why IG media never rendered there.

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@/lib/supabase'
import { mergeTimeline } from '@shared/approval-cards'
import { CHANNELS } from '@shared/channels'
import LinkInstagramContactModal from '@/components/communications/LinkInstagramContactModal'
import ApprovalActionCard from '@/components/ApprovalActionCard'
import { ChannelAvatar } from '@/components/inbox/ChannelBits'
import HandledByControl from '@/components/inbox/HandledByControl'
import MiaDecisionTrace from '@/components/inbox/MiaDecisionTrace'
import WAMediaContent from '@/components/WAMediaContent'
import { isServableInstagramMedia as igHasMedia } from '@shared/whatsapp-media'
import {
  ArrowLeft, Send, MessageCircle, Clock, Check, AlertCircle,
  RefreshCw, Bot, UserCheck,
} from 'lucide-react'
import { Instagram } from '@/components/icons/InstagramIcon'

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

function displayName(conv) {
  if (!conv) return ''
  if (conv.contacts?.name) return conv.contacts.name
  if (conv.contacts?.first_name) return conv.contacts.first_name
  if (conv.ig_username) return `@${conv.ig_username}`
  return 'Instagram user'
}

// Two-letter avatar initials — first letters of the first two words
// (mirrors UnifiedInbox.jsx's initialsOf / WAInbox.jsx's twin so a
// contact's tile initials read the same everywhere in the inbox).
function initialsOf(name) {
  return String(name || '').replace(/^@/, '').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

// `embedded` (UIX-P1b): thread-pane-only mode for the unified inbox —
// the internal list is hidden and selection follows initialConversationId.
export default function IGInbox({ locationId, initialConversationId, embedded = false, onOpenBookTab }) {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(initialConversationId || null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [newMessage, setNewMessage] = useState('')
  // INBOX-APPROVALS.8 — pending/decided agent approval requests for the
  // open conversation, merged into the message timeline below.
  const [approvals, setApprovals] = useState([])
  const [linkOpen, setLinkOpen] = useState(false)
  // AGENT-QA.1 — see WAInbox twin.
  const [agentFeedback, setAgentFeedback] = useState({})
  async function rateAgentMessage(msg, rating) {
    let note = null
    if (rating === 'down') {
      note = window.prompt("What was wrong with this reply? (optional — helps improve the agent)") || null
    }
    setAgentFeedback(f => ({ ...f, [msg.id]: rating }))
    try {
      const r = await fetch('/api/agent/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'instagram', message_id: msg.id, rating, note }),
      })
      if (!r.ok) setAgentFeedback(f => ({ ...f, [msg.id]: undefined }))
    } catch {
      setAgentFeedback(f => ({ ...f, [msg.id]: undefined }))
    }
  }
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const endRef = useRef(null)

  const listUrl = locationId
    ? `/api/instagram/conversations?location_id=${encodeURIComponent(locationId)}`
    : '/api/instagram/conversations'

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(listUrl)
      const data = await res.json()
      if (data.success) setConversations(data.conversations || [])
    } catch {
      /* transient — keep prior list */
    } finally {
      setLoading(false)
    }
  }, [listUrl])

  // UIX-P1 — same Needs-reply/Everything queue split as WAInbox.
  // Resolve PATCHes resolved_at; a new inbound clears it in the
  // agent's webhook handler so the thread re-enters the queue.
  const [queueFilter, setQueueFilter] = useState('needs_reply')
  const needsReply = (c) => !c.resolved_at && c.last_message_direction === 'inbound'
  const visibleConversations = queueFilter === 'all' ? conversations : conversations.filter(needsReply)

  async function toggleResolved(conv) {
    const next = !conv.resolved_at
    try {
      const res = await fetch(`/api/instagram/conversations/${conv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.success) return
      const stamp = next ? new Date().toISOString() : null
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, resolved_at: stamp } : c))
      setConversation(prev => prev && prev.id === conv.id ? { ...prev, resolved_at: stamp } : prev)
    } catch { /* leave state as-is */ }
  }

  // Signature of the currently-rendered thread (count + last message id).
  // Lets the safety-net poll below skip all state churn — and the
  // scroll-to-bottom yank — when a poll returns nothing new.
  const threadSigRef = useRef('')
  const loadThread = useCallback(async (id) => {
    if (!id) return
    try {
      const res = await fetch(`/api/instagram/conversations/${id}`)
      const data = await res.json()
      if (data.success) {
        const msgs = data.messages || []
        const sig = `${msgs.length}:${msgs[msgs.length - 1]?.id || ''}`
        if (sig === threadSigRef.current) return
        threadSigRef.current = sig
        setConversation(data.conversation)
        setMessages(msgs)
      }
    } catch {
      /* ignore */
    }
  }, [])

  // IG-LINK.1 — after linking/unlinking, the CONVERSATION changed but the
  // message list didn't, so the signature guard in loadThread would skip the
  // refresh and the header would keep showing the old state. Clear it first.
  const refreshThreadHard = useCallback(async (id) => {
    threadSigRef.current = ''
    await loadThread(id)
    await loadConversations()
  }, [loadThread, loadConversations])

  const unlinkContact = useCallback(async () => {
    if (!selectedId) return
    try {
      await fetch(`/api/instagram/conversations/${selectedId}/link`, { method: 'DELETE' })
      await refreshThreadHard(selectedId)
    } catch { /* header stays as-is; staff can retry */ }
  }, [selectedId, refreshThreadHard])

  // INBOX-APPROVALS.8 — approval requests tied to this conversation, for
  // the inline cards in the timeline. Never errors for a valid session
  // (returns { success:true, requests:[] } for foreign/unknown ids), so
  // failure here just means the cards silently don't render. The GET
  // route filters by conversation_id only — channel-agnostic, so IG rows
  // (channel='instagram') resolve through the same endpoint as WA.
  const fetchApprovals = useCallback(async (convId) => {
    try {
      const res = await fetch(`/api/agent/membership-requests?conversation_id=${convId}`)
      const data = await res.json()
      if (data.success) setApprovals(data.requests || [])
    } catch {
      /* non-fatal — cards just don't render */
    }
  }, [])

  // Realtime needs the current selection without re-subscribing per
  // click — same ref pattern as WAInbox.
  const selectedIdRef = useRef(initialConversationId || null)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  useEffect(() => { loadConversations() }, [loadConversations])
  useEffect(() => {
    if (embedded) setSelectedId(initialConversationId || null)
  }, [embedded, initialConversationId])

  // UIX-POLISH.3 — Realtime push (mig 256 published the Instagram
  // tables). New messages in the OPEN thread appear instantly; the
  // poll drops to a 60s safety net.
  //
  // RLS-RESTRICTIVE.1: that was only true from mig 485. Mig 231's
  // `ig_conv_deny_writes` / `ig_msg_deny_writes` were `AS RESTRICTIVE
  // FOR ALL USING (false)`, and FOR ALL includes SELECT — so the
  // permissive SELECT policy was folded away and realtime, which
  // authorises each row through it, delivered nothing. Publishing the
  // tables in mig 256 could not help. The 60s poll masked it.
  useEffect(() => {
    if (!locationId) return
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`ig-inbox-${locationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'instagram_conversations' },
        () => { loadConversations() }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'instagram_messages' },
        (payload) => {
          loadConversations()
          const convId = payload?.new?.conversation_id
          if (convId && convId === selectedIdRef.current) {
            loadThread(convId)
          }
        }
      )
      // INBOX-APPROVALS.8 — refresh approval cards live (mig 363 publishes
      // this table to supabase_realtime). Until that migration lands in
      // prod this listener simply never fires; fetch-on-open still works.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_membership_requests' },
        (payload) => {
          const convId = payload?.new?.conversation_id || payload?.old?.conversation_id
          if (convId && convId === selectedIdRef.current) fetchApprovals(convId)
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [locationId, loadConversations, loadThread, fetchApprovals])

  useEffect(() => {
    const t = setInterval(loadConversations, 60000)
    return () => clearInterval(t)
  }, [loadConversations])
  useEffect(() => {
    setApprovals([])
    threadSigRef.current = ''   // force a fresh load when switching threads
    if (selectedId) {
      loadThread(selectedId)
      fetchApprovals(selectedId)
    }
  }, [selectedId, loadThread, fetchApprovals])

  // Safety-net poll for the OPEN thread. Realtime pushes new messages
  // instantly when the socket is connected, but if it drops (websocket
  // blocked, resubscribe gap) the thread would otherwise only refresh on
  // re-select — the reported bug. Mirrors the 60s conversation-list poll;
  // 10s here, skipped when the tab is hidden, and a no-op (via the
  // signature guard in loadThread) when nothing changed.
  useEffect(() => {
    if (!selectedId) return
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      loadThread(selectedId)
    }, 10000)
    return () => clearInterval(t)
  }, [selectedId, loadThread])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSend(e) {
    e?.preventDefault()
    const text = newMessage.trim()
    if (!text || sending || !selectedId) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/instagram/conversations/${selectedId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to send'); return }
      setNewMessage('')
      await loadThread(selectedId)
      await fetchApprovals(selectedId)
      await loadConversations()
      // BAREWRITE.4 — the send route reports a DELIVERED message whose
      // bookkeeping failed (the thread row, or the Mia take-over stamp) as
      // `warnings`. Meta has the DM either way, so this is not an error — but
      // it is exactly the case where an operator would otherwise retype the
      // message (sending it twice) or assume Mia is paused when she is not.
      // Nothing read this array until now, so the route was warning into a
      // vacuum. Set AFTER the reloads so nothing they do can clear it.
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        setError(data.warnings.join(' '))
      }
    } catch (err) {
      setError(err.message || 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={`flex ${embedded ? 'h-full' : 'h-[calc(100vh-4rem)]'} bg-un1t-bg`}>
      {/* Conversation list (hidden in embedded mode — the unified queue replaces it) */}
      <div className={`${embedded ? 'hidden' : selectedId ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 border-r border-un1t-border`}>
        <div className="flex items-center justify-between p-4 border-b border-un1t-border">
          <div className="flex items-center gap-2">
            <Instagram size={18} className="text-un1t-accent" />
            <h2 className="font-semibold">Instagram</h2>
          </div>
          <button onClick={loadConversations} className="text-un1t-subtle hover:text-un1t-text" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
        {/* UIX-P1 — queue split */}
        <div className="flex gap-1.5 px-3 py-2 border-b border-un1t-border">
          {[['needs_reply', 'Needs reply'], ['all', 'Everything']].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setQueueFilter(key)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                queueFilter === key
                  ? 'bg-un1t-text text-un1t-bg border-transparent'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {label}
              {key === 'needs_reply' && conversations.filter(needsReply).length > 0 && (
                <span className="ml-1">· {conversations.filter(needsReply).length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-4 text-sm text-un1t-subtle">Loading…</p>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-sm text-un1t-subtle">
              <MessageCircle size={28} className="mx-auto mb-2 opacity-40" />
              No Instagram conversations yet.
            </div>
          ) : visibleConversations.length === 0 ? (
            <p className="p-4 text-xs text-un1t-subtle text-center">
              Queue clear — nothing needs a reply. 🎉
            </p>
          ) : visibleConversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => setSelectedId(conv.id)}
              className={`w-full text-left p-4 border-b border-un1t-border/50 hover:bg-un1t-surface transition-colors ${selectedId === conv.id ? 'bg-un1t-surface' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate flex items-center gap-1.5">
                  {displayName(conv)}
                  {conv.resolved_at && <Check size={12} className="text-green-600 shrink-0" />}
                </span>
                <span className="text-xs text-un1t-muted shrink-0">{formatTime(conv.last_message_at)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <span className="text-xs text-un1t-subtle truncate">{conv.last_message_preview || '—'}</span>
                {conv.unread_count > 0 && (
                  <span className="text-[10px] bg-un1t-accent text-un1t-bg rounded-full px-1.5 py-0.5 shrink-0">{conv.unread_count}</span>
                )}
              </div>
              <div className="mt-1">
                {conv.agent_active === false
                  ? <span className="inline-flex items-center gap-1 text-[10px] text-amber-400"><UserCheck size={10} /> Staff handling</span>
                  : <span className="inline-flex items-center gap-1 text-[10px] text-un1t-muted"><Bot size={10} /> Agent</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0`}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-un1t-subtle">
            <div className="text-center">
              <Instagram size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a conversation</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 p-4 border-b border-un1t-border">
              <div className="flex items-center gap-3 min-w-0">
                <button onClick={() => setSelectedId(null)} className={embedded ? 'hidden' : 'md:hidden text-un1t-subtle'} aria-label="Back">
                  <ArrowLeft size={18} />
                </button>
                <ChannelAvatar channel="ig" initials={initialsOf(displayName(conversation))} badge />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm truncate">{displayName(conversation)}</p>
                    <span className="text-[10px] font-semibold text-channel-ig">{CHANNELS.ig.name}</span>
                  </div>
                  {/* IG-LINK.1 — Instagram has no phone/email to match on, so
                      an unlinked thread needs a human to say who this is (once). */}
                  {conversation?.contacts?.id ? (
                    <span className="flex items-center gap-2">
                      <Link href={`/contacts/${conversation.contacts.id}`} className="text-xs text-un1t-accent hover:underline">
                        View contact
                      </Link>
                      <button
                        type="button"
                        onClick={unlinkContact}
                        className="text-xs text-un1t-muted hover:text-un1t-text underline"
                      >
                        Unlink
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setLinkOpen(true)}
                      className="text-xs text-un1t-accent hover:underline"
                    >
                      Link to a contact
                    </button>
                  )}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-3">
                {conversation && (
                  <button
                    onClick={() => toggleResolved(conversation)}
                    className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border transition-colors ${
                      conversation.resolved_at
                        ? 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
                        : 'bg-green-600 border-transparent text-white hover:bg-green-700'
                    }`}
                  >
                    <Check size={11} />
                    {conversation.resolved_at ? 'Reopen' : 'Resolve'}
                  </button>
                )}
                <HandledByControl
                  channel="ig"
                  conversation={conversation}
                  onChanged={() => { loadThread(selectedId); fetchApprovals(selectedId) }}
                />
                {conversation && (
                  <MiaDecisionTrace conversationId={conversation.id} />
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {mergeTimeline(messages, approvals).map(item => {
                if (item.kind === 'approval') {
                  return (
                    <ApprovalActionCard
                      key={item.key}
                      request={item.request}
                      contactId={conversation?.contact_id || null}
                      locationId={locationId}
                      contactFirstName={conversation?.contacts?.first_name || conversation?.ig_username || null}
                      onDecided={updated => setApprovals(prev => prev.map(r => (r.id === updated.id ? updated : r)))}
                      onPrefillComposer={text => setNewMessage(text)}
                      onOpenBookTab={onOpenBookTab}
                    />
                  )
                }
                const m = item.message
                const outbound = m.direction === 'outbound'
                const fromAgent = outbound && m.source === 'agent'
                return (
                  <div key={item.key} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${outbound ? 'bg-un1t-accent text-un1t-bg' : 'bg-un1t-surface text-un1t-text'}`}>
                      {igHasMedia(m) && <WAMediaContent message={m} endpoint="/api/instagram/media" />}
                      {m.body && <div className={igHasMedia(m) ? 'mt-1' : ''}>{m.body}</div>}
                      <div className={`flex items-center gap-1 mt-1 text-[10px] ${outbound ? 'text-un1t-bg/70' : 'text-un1t-muted'}`}>
                        {m.source === 'agent' && (
                          <span className="flex items-center gap-1">
                            <button type="button" onClick={() => rateAgentMessage(m, 'up')}
                              className={`text-[11px] leading-none ${agentFeedback[m.id] === 'up' ? 'opacity-100' : 'opacity-40 hover:opacity-90'}`}
                              title="Good reply">👍</button>
                            <button type="button" onClick={() => rateAgentMessage(m, 'down')}
                              className={`text-[11px] leading-none ${agentFeedback[m.id] === 'down' ? 'opacity-100' : 'opacity-40 hover:opacity-90'}`}
                              title="Bad reply — add a note">👎</button>
                          </span>
                        )}
                        {fromAgent && <Bot size={10} />}
                        {outbound && !fromAgent && <span>Staff</span>}
                        <span>{formatTime(m.sent_at || m.created_at)}</span>
                        {outbound && <Check size={10} />}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={endRef} />
            </div>

            {error && (
              <div className="px-4 py-2 text-xs text-red-400 flex items-center gap-1 border-t border-un1t-border">
                <AlertCircle size={12} /> {error}
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-center gap-2 p-3 border-t border-un1t-border">
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="Reply on Instagram…"
                maxLength={1000}
                className="flex-1 bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-un1t-accent"
              />
              <button
                type="submit"
                disabled={sending || !newMessage.trim()}
                className="bg-un1t-accent text-un1t-bg rounded-lg px-3 py-2 disabled:opacity-40"
                aria-label="Send"
              >
                {sending ? <Clock size={16} /> : <Send size={16} />}
              </button>
            </form>
          </>
        )}
      </div>

      <LinkInstagramContactModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        conversation={conversation}
        onLinked={() => refreshThreadHard(selectedId)}
      />
    </div>
  )
}
