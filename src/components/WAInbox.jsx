'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Send, MessageCircle, Clock, CheckCheck,
  Check, Image, FileText, Mic, AlertCircle, RefreshCw
} from 'lucide-react'

function formatTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now - d
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return d.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString('en-IE', { weekday: 'short' })
  return d.toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })
}

function StatusIcon({ status }) {
  switch (status) {
    case 'read': return <CheckCheck size={12} className="text-blue-400" />
    case 'delivered': return <CheckCheck size={12} className="text-un1t-light" />
    case 'sent': return <Check size={12} className="text-un1t-light" />
    case 'failed': return <AlertCircle size={12} className="text-red-400" />
    default: return <Clock size={12} className="text-un1t-mid" />
  }
}

function MessageTypeIcon({ type }) {
  switch (type) {
    case 'image': return <Image size={12} className="inline mr-1" />
    case 'video': return <Image size={12} className="inline mr-1" />
    case 'document': return <FileText size={12} className="inline mr-1" />
    case 'audio': return <Mic size={12} className="inline mr-1" />
    default: return null
  }
}

export default function WAInbox({ locationId, userId }) {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [messages, setMessages] = useState([])
  const [conversation, setConversation] = useState(null)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const messagesEndRef = useRef(null)
  const pollRef = useRef(null)

  // Load conversations
  useEffect(() => {
    fetchConversations()
    // Poll every 10 seconds
    pollRef.current = setInterval(fetchConversations, 10000)
    return () => clearInterval(pollRef.current)
  }, [locationId])

  // Load messages when conversation selected
  useEffect(() => {
    if (selectedId) fetchMessages(selectedId)
  }, [selectedId])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function fetchConversations() {
    try {
      const res = await fetch(`/api/whatsapp/conversations?location_id=${locationId}`)
      const data = await res.json()
      if (data.success) setConversations(data.conversations)
    } catch (err) {
      console.error('Failed to fetch conversations:', err)
    } finally {
      setLoading(false)
    }
  }

  async function fetchMessages(convId) {
    try {
      const res = await fetch(`/api/whatsapp/conversations/${convId}`)
      const data = await res.json()
      if (data.success) {
        setConversation(data.conversation)
        setMessages(data.messages)
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err)
    }
  }

  async function handleSend() {
    if (!newMessage.trim() || !selectedId) return

    setSending(true)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${selectedId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'text',
          text: newMessage,
          sent_by: userId,
        }),
      })

      const data = await res.json()

      if (data.success) {
        setNewMessage('')
        // Refresh messages
        await fetchMessages(selectedId)
        await fetchConversations()
      } else if (data.window_expired) {
        alert('The 24-hour messaging window has expired. You can only send approved template messages now.')
      } else {
        alert(data.error || 'Failed to send message')
      }
    } catch (err) {
      alert('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const windowOpen = conversation?.window_expires_at && new Date(conversation.window_expires_at) > new Date()
  const windowExpiry = conversation?.window_expires_at
    ? new Date(conversation.window_expires_at).toLocaleString('en-IE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    : null

  return (
    <div className="flex h-screen">
      {/* Conversation list */}
      <div className="w-80 border-r border-un1t-gray flex flex-col shrink-0 bg-un1t-dark">
        <div className="p-4 border-b border-un1t-gray flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/whatsapp" className="text-un1t-light hover:text-white transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <h3 className="font-semibold">Inbox</h3>
          </div>
          <button onClick={fetchConversations} className="p-1.5 text-un1t-light hover:text-white transition-colors">
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && (
            <p className="text-sm text-un1t-light p-4 text-center">Loading...</p>
          )}

          {!loading && conversations.length === 0 && (
            <div className="p-6 text-center">
              <MessageCircle size={28} className="mx-auto mb-2 text-un1t-mid" />
              <p className="text-sm text-un1t-light">No conversations yet</p>
              <p className="text-xs text-un1t-mid mt-1">Messages will appear when contacts message you on WhatsApp</p>
            </div>
          )}

          {conversations.map(conv => {
            const contact = conv.contacts
            const isSelected = selectedId === conv.id

            return (
              <button
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={`w-full text-left px-4 py-3 border-b border-un1t-gray transition-colors ${
                  isSelected ? 'bg-un1t-gray/50' : 'hover:bg-un1t-gray/20'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {contact?.name || conv.wa_phone}
                      </p>
                      {conv.unread_count > 0 && (
                        <span className="bg-green-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-un1t-mid truncate mt-0.5">
                      {conv.last_message_direction === 'outbound' && <span className="text-un1t-light">You: </span>}
                      {conv.last_message_preview || 'No messages'}
                    </p>
                  </div>
                  <span className="text-[10px] text-un1t-mid shrink-0 ml-2">
                    {formatTime(conv.last_message_at)}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageCircle size={48} className="mx-auto mb-3 text-un1t-mid" />
              <p className="text-un1t-light">Select a conversation to start messaging</p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="px-5 py-3 border-b border-un1t-gray bg-un1t-dark flex items-center justify-between shrink-0">
              <div>
                <p className="font-semibold text-sm">
                  {conversation?.contacts?.name || conversation?.wa_phone}
                </p>
                <p className="text-xs text-un1t-mid">
                  {conversation?.wa_phone}
                  {conversation?.contacts?.lead_status && (
                    <span> · {conversation.contacts.lead_status.replace(/_/g, ' ')}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {windowOpen ? (
                  <span className="text-xs text-green-400">
                    <Clock size={10} className="inline mr-1" />
                    Window open until {windowExpiry}
                  </span>
                ) : (
                  <span className="text-xs text-orange-400">
                    <Clock size={10} className="inline mr-1" />
                    Window closed — templates only
                  </span>
                )}
                {conversation?.contacts?.id && (
                  <Link
                    href={`/contacts/${conversation.contacts.id}`}
                    className="text-xs text-un1t-light hover:text-white transition-colors"
                  >
                    View contact
                  </Link>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto p-4 space-y-2 bg-[#0b141a]">
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[65%] rounded-lg px-3 py-2 ${
                    msg.direction === 'outbound'
                      ? 'bg-[#005c4b] text-white'
                      : 'bg-un1t-dark text-white'
                  }`}>
                    {msg.message_type === 'template' && (
                      <p className="text-[10px] text-green-300 mb-1">Template: {msg.template_name}</p>
                    )}
                    <MessageTypeIcon type={msg.message_type} />
                    <p className="text-sm whitespace-pre-wrap">{msg.body || `[${msg.message_type}]`}</p>
                    <div className="flex items-center justify-end gap-1 mt-0.5">
                      <span className="text-[10px] text-white/50">
                        {new Date(msg.sent_at || msg.created_at).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {msg.direction === 'outbound' && <StatusIcon status={msg.status} />}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Message input */}
            <div className="px-4 py-3 border-t border-un1t-gray bg-un1t-dark shrink-0">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder={windowOpen ? "Type a message..." : "Window closed — use template messages"}
                  disabled={!windowOpen}
                  className="flex-1 bg-black border border-un1t-gray rounded-full px-4 py-2 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40 disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !newMessage.trim() || !windowOpen}
                  className="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center hover:bg-green-700 transition-colors disabled:opacity-50"
                >
                  <Send size={16} className="text-white ml-0.5" />
                </button>
              </div>
              {!windowOpen && (
                <p className="text-xs text-orange-400 mt-2 text-center">
                  The 24h window has expired. Send a template message to re-engage this contact via a broadcast.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
