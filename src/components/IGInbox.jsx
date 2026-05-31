'use client'

// Operator Instagram inbox. Mirrors WAInbox but simpler: Instagram DMs are
// text-only here (no 24h-window templates, media, or broadcasts). Staff can
// read threads the agent is handling, send a manual reply (which takes the
// thread OVER from the agent), and hand it back.

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Send, MessageCircle, Clock, Check, AlertCircle,
  RefreshCw, Bot, UserCheck, Instagram,
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
  if (conv.ig_username) return `@${conv.ig_username}`
  return 'Instagram user'
}

export default function IGInbox({ locationId, initialConversationId }) {
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

  const loadThread = useCallback(async (id) => {
    if (!id) return
    try {
      const res = await fetch(`/api/instagram/conversations/${id}`)
      const data = await res.json()
      if (data.success) {
        setConversation(data.conversation)
        setMessages(data.messages || [])
      }
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])
  useEffect(() => {
    const t = setInterval(loadConversations, 15000)
    return () => clearInterval(t)
  }, [loadConversations])
  useEffect(() => { if (selectedId) loadThread(selectedId) }, [selectedId, loadThread])
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
      await loadConversations()
    } catch (err) {
      setError(err.message || 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  async function toggleAgent(active) {
    if (!selectedId) return
    try {
      const res = await fetch(`/api/instagram/conversations/${selectedId}/agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      const data = await res.json()
      if (data.success) await loadThread(selectedId)
    } catch {
      /* ignore */
    }
  }

  const agentActive = conversation?.agent_active !== false

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-un1t-bg">
      {/* Conversation list */}
      <div className={`${selectedId ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 border-r border-un1t-border`}>
        <div className="flex items-center justify-between p-4 border-b border-un1t-border">
          <div className="flex items-center gap-2">
            <Instagram size={18} className="text-un1t-accent" />
            <h2 className="font-semibold">Instagram</h2>
          </div>
          <button onClick={loadConversations} className="text-un1t-subtle hover:text-un1t-text" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-4 text-sm text-un1t-subtle">Loading…</p>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-sm text-un1t-subtle">
              <MessageCircle size={28} className="mx-auto mb-2 opacity-40" />
              No Instagram conversations yet.
            </div>
          ) : conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => setSelectedId(conv.id)}
              className={`w-full text-left p-4 border-b border-un1t-border/50 hover:bg-un1t-surface transition-colors ${selectedId === conv.id ? 'bg-un1t-surface' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate">{displayName(conv)}</span>
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
      <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1`}>
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
              <div className="flex items-center gap-2 min-w-0">
                <button onClick={() => setSelectedId(null)} className="md:hidden text-un1t-subtle" aria-label="Back">
                  <ArrowLeft size={18} />
                </button>
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{displayName(conversation)}</p>
                  {conversation?.contacts?.id ? (
                    <Link href={`/contacts/${conversation.contacts.id}`} className="text-xs text-un1t-accent hover:underline">
                      View contact
                    </Link>
                  ) : (
                    <span className="text-xs text-un1t-muted">Not linked to a contact</span>
                  )}
                </div>
              </div>
              <div className="shrink-0">
                {agentActive ? (
                  <span className="inline-flex items-center gap-1 text-xs text-un1t-muted">
                    <Bot size={12} /> Agent active
                    <button onClick={() => toggleAgent(false)} className="ml-2 text-amber-400 hover:underline">Take over</button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                    <UserCheck size={12} /> You&apos;re handling this
                    <button onClick={() => toggleAgent(true)} className="ml-2 text-un1t-accent hover:underline">Hand back to agent</button>
                  </span>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m) => {
                const outbound = m.direction === 'outbound'
                const fromAgent = outbound && m.source && m.source !== 'operator'
                return (
                  <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${outbound ? 'bg-un1t-accent text-un1t-bg' : 'bg-un1t-surface text-un1t-text'}`}>
                      {m.body}
                      <div className={`flex items-center gap-1 mt-1 text-[10px] ${outbound ? 'text-un1t-bg/70' : 'text-un1t-muted'}`}>
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
    </div>
  )
}
