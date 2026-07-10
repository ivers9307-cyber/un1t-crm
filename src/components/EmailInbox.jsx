'use client'

// Operator email inbox (EMAIL-INBOX.1). Mirrors IGInbox but simpler
// still: no customer agent, no approvals, no 24h window. Threads are
// email_conversations (one per location + external address); messages
// render text_body ONLY (plain text, whitespace preserved) — raw HTML
// is never injected into the DOM.

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@/lib/supabase'
import {
  ArrowLeft, Send, Clock, Check, AlertCircle, RefreshCw, Mail,
} from 'lucide-react'

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
  if (conv.counterpart_name) return conv.counterpart_name
  return conv.counterpart_email || 'Email contact'
}

// `embedded` (UIX-P1b semantics): thread-pane-only mode for the unified
// inbox — the internal list is hidden and selection follows
// initialConversationId. Mirrors IGInbox's contract.
export default function EmailInbox({ locationId, initialConversationId, embedded = false }) {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(initialConversationId || null)
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const endRef = useRef(null)

  const listUrl = locationId
    ? `/api/email/conversations?location_id=${encodeURIComponent(locationId)}`
    : '/api/email/conversations'

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

  const [queueFilter, setQueueFilter] = useState('needs_reply')
  const needsReply = (c) => !c.resolved_at && c.last_message_direction === 'inbound'
  const visibleConversations = queueFilter === 'all' ? conversations : conversations.filter(needsReply)

  async function toggleResolved(conv) {
    const next = !conv.resolved_at
    try {
      const res = await fetch(`/api/email/conversations/${conv.id}`, {
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

  const loadThread = useCallback(async (id) => {
    if (!id) return
    try {
      const res = await fetch(`/api/email/conversations/${id}`)
      const data = await res.json()
      if (data.success) {
        setConversation(data.conversation)
        setMessages(data.messages || [])
      }
    } catch {
      /* ignore */
    }
  }, [])

  const selectedIdRef = useRef(initialConversationId || null)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  useEffect(() => { loadConversations() }, [loadConversations])
  useEffect(() => {
    if (embedded) setSelectedId(initialConversationId || null)
  }, [embedded, initialConversationId])

  // Realtime push (mig 394 publishes the email tables); until the
  // migration lands the listeners simply never fire and the 60s poll
  // below covers it — same posture as the IG inbox pre-mig-256.
  useEffect(() => {
    if (!locationId) return
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`email-inbox-${locationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'email_conversations' },
        () => { loadConversations() }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'email_inbox_messages' },
        (payload) => {
          loadConversations()
          const convId = payload?.new?.conversation_id
          if (convId && convId === selectedIdRef.current) {
            loadThread(convId)
          }
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [locationId, loadConversations, loadThread])

  useEffect(() => {
    const t = setInterval(loadConversations, 60000)
    return () => clearInterval(t)
  }, [loadConversations])
  useEffect(() => {
    if (selectedId) loadThread(selectedId)
  }, [selectedId, loadThread])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSend(e) {
    e?.preventDefault()
    const text = newMessage.trim()
    if (!text || sending || !selectedId) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/email/conversations/${selectedId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to send'); return }
      setNewMessage('')
      await loadThread(selectedId)
      await loadConversations()
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
            <Mail size={18} className="text-un1t-accent" />
            <h2 className="font-semibold">Email</h2>
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
              <Mail size={28} className="mx-auto mb-2 opacity-40" />
              No email conversations yet.
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
              {conv.subject && (
                <div className="text-xs text-un1t-text truncate mt-0.5">{conv.subject}</div>
              )}
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <span className="text-xs text-un1t-subtle truncate">{conv.last_message_preview || '—'}</span>
                {conv.unread_count > 0 && (
                  <span className="text-[10px] bg-un1t-accent text-un1t-bg rounded-full px-1.5 py-0.5 shrink-0">{conv.unread_count}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1`}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-un1t-subtle">
            <div className="text-center">
              <Mail size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a conversation</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 p-4 border-b border-un1t-border">
              <div className="flex items-center gap-2 min-w-0">
                <button onClick={() => setSelectedId(null)} className={embedded ? 'hidden' : 'md:hidden text-un1t-subtle'} aria-label="Back">
                  <ArrowLeft size={18} />
                </button>
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{displayName(conversation)}</p>
                  <p className="text-xs text-un1t-muted truncate">{conversation?.counterpart_email}</p>
                  {conversation?.contacts?.id ? (
                    <Link href={`/contacts/${conversation.contacts.id}`} className="text-xs text-un1t-accent hover:underline">
                      View contact
                    </Link>
                  ) : (
                    <span className="text-xs text-un1t-muted">Not linked to a contact</span>
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
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m) => {
                const outbound = m.direction === 'outbound'
                return (
                  <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${outbound ? 'bg-un1t-accent text-un1t-bg' : 'bg-un1t-surface text-un1t-text'}`}>
                      {m.subject && (
                        <div className={`text-xs font-semibold mb-1 ${outbound ? 'text-un1t-bg/80' : 'text-un1t-subtle'}`}>
                          {m.subject}
                        </div>
                      )}
                      {/* text_body only — never raw HTML (see component header). */}
                      <div className="whitespace-pre-wrap break-words">{m.text_body || '(no text content)'}</div>
                      <div className={`flex items-center gap-1 mt-1 text-[10px] ${outbound ? 'text-un1t-bg/70' : 'text-un1t-muted'}`}>
                        {outbound && <span>Staff</span>}
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
              <div className="px-4 py-2 text-xs text-red-700 flex items-center gap-1 border-t border-un1t-border">
                <AlertCircle size={12} /> {error}
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-end gap-2 p-3 border-t border-un1t-border">
              <textarea
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={`Reply to ${conversation?.counterpart_email || 'sender'}…`}
                maxLength={10000}
                rows={2}
                className="flex-1 bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-un1t-accent resize-none"
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
    </div>
  )
}
