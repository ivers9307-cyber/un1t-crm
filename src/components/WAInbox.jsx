'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@/lib/supabase'
import { isServableMedia } from '@shared/whatsapp-media'
import { mergeTimeline } from '@shared/approval-cards'
import WAMediaContent from '@/components/WAMediaContent'
import ApprovalActionCard from '@/components/ApprovalActionCard'
import {
  ArrowLeft, Send, MessageCircle, Clock, CheckCheck,
  Check, Image as ImageIcon, FileText, Mic, AlertCircle, RefreshCw,
  UserPlus, X, UserCheck, LayoutTemplate, CalendarPlus
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
    case 'delivered': return <CheckCheck size={12} className="text-un1t-subtle" />
    case 'sent': return <Check size={12} className="text-un1t-subtle" />
    case 'failed': return <AlertCircle size={12} className="text-red-400" />
    default: return <Clock size={12} className="text-un1t-muted" />
  }
}

function MessageTypeIcon({ type }) {
  switch (type) {
    case 'image': return <ImageIcon size={12} className="inline mr-1" />
    case 'video': return <ImageIcon size={12} className="inline mr-1" />
    case 'document': return <FileText size={12} className="inline mr-1" />
    case 'audio': return <Mic size={12} className="inline mr-1" />
    default: return null
  }
}

// Display name helper — prefers contact name, falls back to WA profile name, then phone
function getDisplayName(conv) {
  if (conv.contacts?.name) return conv.contacts.name
  if (conv.wa_profile_name) return conv.wa_profile_name
  return conv.wa_phone
}

function isUnknownSender(conv) {
  return !conv.contact_id && !conv.contacts
}

// `embedded` (UIX-P1b): thread-pane-only mode for the unified inbox —
// the internal conversation list is hidden and selection is driven by
// the `initialConversationId` prop (synced on change, not just mount).
export default function WAInbox({ locationId, userId, initialConversationId, embedded = false, onOpenBookTab }) {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(initialConversationId || null)
  const [messages, setMessages] = useState([])
  const [conversation, setConversation] = useState(null)
  const [newMessage, setNewMessage] = useState('')
  // INBOX-APPROVALS.7 — pending/decided agent approval requests for the
  // open conversation, merged into the message timeline below.
  const [approvals, setApprovals] = useState([])
  // AGENT-QA.1 — local rating state (id → 'up'|'down'); persisted via
  // /api/agent/feedback (upsert per rater, server re-checks the message).
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
        body: JSON.stringify({ channel: 'whatsapp', message_id: msg.id, rating, note }),
      })
      if (!r.ok) setAgentFeedback(f => ({ ...f, [msg.id]: undefined }))
    } catch {
      setAgentFeedback(f => ({ ...f, [msg.id]: undefined }))
    }
  }
  // C6 — emoji reactions on inbound messages. The route sends via Meta and
  // logs a thread row; no optimistic rendering (the row shows on refresh).
  const [reactingId, setReactingId] = useState(null)
  async function reactToMessage(msg, emoji) {
    if (!conversation?.id || !msg.wa_message_id) return
    setReactingId(msg.id)
    try {
      await fetch(`/api/whatsapp/conversations/${conversation.id}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: msg.wa_message_id, emoji }),
      })
    } catch {} finally {
      setReactingId(null)
    }
  }
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showAddContact, setShowAddContact] = useState(false)
  const [addContactForm, setAddContactForm] = useState({
    name: '', first_name: '', email: '', add_to_pipeline: true, pipeline_stage: 'new',
  })
  const [addingContact, setAddingContact] = useState(false)
  const [templates, setTemplates] = useState([])
  // C4 — operator-curated card sets (settings → WhatsApp → Card sets), sent
  // as an in-session media carousel. null = not fetched yet (lazy — loaded
  // the first time an open-window composer renders, then cached).
  const [cardSets, setCardSets] = useState(null)
  const [selectedCardSetId, setSelectedCardSetId] = useState('')
  const [sendingCardSet, setSendingCardSet] = useState(false)
  // FLOW-SEND — drop the location's booking Flow into an open conversation
  // (availability comes back on the conversation GET).
  const [flowAvailable, setFlowAvailable] = useState(false)
  const [sendingFlow, setSendingFlow] = useState(false)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [templateVars, setTemplateVars] = useState({})
  const [sendingTemplate, setSendingTemplate] = useState(false)
  const messagesEndRef = useRef(null)
  // Slow heartbeat — safety net for cases where Realtime drops a row
  // event (network blip, reconnect race). 60s is plenty given that
  // Realtime catches the live cases. Previously this was a 10s poll
  // doing all the work; mig 042 published the WhatsApp tables to
  // supabase_realtime so we get push events for free.
  const pollRef = useRef(null)
  // The selected-conversation id changes; the realtime subscription
  // needs the latest value when handling a message event without
  // re-subscribing on every selection. ref carries it across renders.
  const selectedIdRef = useRef(initialConversationId || null)
  // Signature (count + last id) of the rendered thread — lets the
  // open-thread safety-net poll skip state churn + scroll-yank on no-op ticks.
  const threadSigRef = useRef('')

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/conversations?location_id=${locationId}`)
      const data = await res.json()
      if (data.success) setConversations(data.conversations)
    } catch (err) {
      console.error('Failed to fetch conversations:', err)
    } finally {
      setLoading(false)
    }
  }, [locationId])

  // UIX-P1 — the queue defaults to "Needs reply": last message inbound
  // and nobody has resolved the thread. Resolve stamps resolved_at via
  // PATCH (mig 255); a fresh inbound auto-clears it webhook-side so
  // replied-to threads come back to the queue.
  const [queueFilter, setQueueFilter] = useState('needs_reply')
  const needsReply = (c) => !c.resolved_at && c.last_message_direction === 'inbound'
  const visibleConversations = queueFilter === 'all' ? conversations : conversations.filter(needsReply)

  // WA-BLOCK — block/unblock the sender at Meta (spam/abuse; protects the
  // number's quality rating). Confirmed action; mirrors is_blocked locally.
  async function toggleBlocked(conv) {
    const next = !conv.is_blocked
    const msg = next
      ? 'Block this sender? They will no longer be able to message this number (and it cannot message them).'
      : 'Unblock this sender?'
    if (!window.confirm(msg)) return
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conv.id}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: next ? 'block' : 'unblock' }),
      })
      const j = await res.json().catch(() => ({}))
      if (!j.success) { window.alert(j.error || 'Block update failed'); return }
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, is_blocked: next } : c))
      setConversation(prev => prev && prev.id === conv.id ? { ...prev, is_blocked: next } : prev)
    } catch { /* leave state as-is */ }
  }

  async function toggleResolved(conv) {
    const next = !conv.resolved_at
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: next }),
      })
      const j = await res.json().catch(() => ({}))
      if (!j.success) return
      const stamp = next ? new Date().toISOString() : null
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, resolved_at: stamp } : c))
      setConversation(prev => prev && prev.id === conv.id ? { ...prev, resolved_at: stamp } : prev)
    } catch { /* leave state as-is */ }
  }

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}&status=APPROVED`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch (err) {
      console.error('Failed to fetch templates:', err)
    }
  }, [locationId])

  // Initial load + 60s heartbeat (a backstop for missed realtime events).
  useEffect(() => {
    fetchConversations()
    fetchTemplates()
    pollRef.current = setInterval(fetchConversations, 60000)
    return () => clearInterval(pollRef.current)
  }, [locationId, fetchConversations, fetchTemplates])

  // Realtime subscription — push updates instead of polling. RLS scopes
  // events to rows the user can read, so the per-location filter is
  // already enforced server-side. We listen on:
  //   - whatsapp_conversations: new conversations + assignment / status
  //     changes for the conversation list (left panel).
  //   - whatsapp_messages: new inbound + outbound messages. If the
  //     event belongs to the open conversation, refresh its message
  //     list; in either case refresh the conversation list so unread
  //     counts and last-message previews update.
  useEffect(() => {
    if (!locationId) return
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`wa-inbox-${locationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_conversations' },
        () => { fetchConversations() }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' },
        (payload) => {
          fetchConversations()
          const convId = payload?.new?.conversation_id
          if (convId && convId === selectedIdRef.current) {
            fetchMessages(convId)
          }
        }
      )
      // INBOX-APPROVALS.7 — refresh approval cards live (mig 363 publishes
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
  }, [locationId, fetchConversations])

  // Load messages when conversation selected. Also mirror selectedId
  // into the ref so the realtime handler can branch on the currently
  // open conversation without re-subscribing every time the user
  // clicks a different thread.
  useEffect(() => {
    selectedIdRef.current = selectedId
    setApprovals([])
    threadSigRef.current = ''   // force a fresh load when switching threads
    if (selectedId) {
      fetchMessages(selectedId)
      fetchApprovals(selectedId)
      setShowAddContact(false)
    }
  }, [selectedId])

  // Safety-net poll for the OPEN thread. Realtime pushes new messages
  // instantly when connected; if the socket drops the thread would
  // otherwise only refresh on re-select. Mirrors the 60s list poll; 10s
  // here, skipped when the tab is hidden, and a no-op (signature guard in
  // fetchMessages) when nothing changed.
  useEffect(() => {
    if (!selectedId) return
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      fetchMessages(selectedId)
    }, 10000)
    return () => clearInterval(t)
  }, [selectedId])

  // Embedded mode — the unified inbox owns the queue; follow its selection.
  useEffect(() => {
    if (embedded) setSelectedId(initialConversationId || null)
  }, [embedded, initialConversationId])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // C4 — lazy card-set fetch: the first time a conversation with an open
  // 24h window renders, load the location's card sets once and cache them
  // for the session. [] (loaded-but-empty or fetch failure) hides the
  // composer control entirely.
  useEffect(() => {
    if (cardSets !== null || !locationId) return
    if (!(conversation?.window_expires_at && new Date(conversation.window_expires_at) > new Date())) return
    let cancelled = false
    fetch(`/api/whatsapp/card-sets?location_id=${locationId}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setCardSets(j.success ? (j.sets || []) : []) })
      .catch(() => { if (!cancelled) setCardSets([]) })
    return () => { cancelled = true }
  }, [cardSets, locationId, conversation])

  async function fetchMessages(convId) {
    try {
      const res = await fetch(`/api/whatsapp/conversations/${convId}`)
      const data = await res.json()
      if (data.success) {
        const msgs = data.messages || []
        const sig = `${msgs.length}:${msgs[msgs.length - 1]?.id || ''}`
        if (sig === threadSigRef.current) return
        threadSigRef.current = sig
        setConversation(data.conversation)
        setMessages(msgs)
        setFlowAvailable(Boolean(data.flow_available))

        // Pre-fill add contact form with WA profile name
        if (!data.conversation.contact_id && data.conversation.wa_profile_name) {
          const profileName = data.conversation.wa_profile_name
          setAddContactForm(prev => ({
            ...prev,
            name: profileName,
            first_name: profileName.split(' ')[0] || '',
          }))
        }
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err)
    }
  }

  // INBOX-APPROVALS.7 — approval requests tied to this conversation, for
  // the inline cards in the timeline. Never errors for a valid session
  // (returns { success:true, requests:[] } for foreign/unknown ids), so
  // failure here just means the cards silently don't render.
  async function fetchApprovals(convId) {
    try {
      const res = await fetch(`/api/agent/membership-requests?conversation_id=${convId}`)
      const data = await res.json()
      if (data.success) setApprovals(data.requests || [])
    } catch {
      /* non-fatal — cards just don't render */
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
        await fetchMessages(selectedId)
        await fetchApprovals(selectedId)
        await fetchConversations()
      } else if (data.window_expired) {
        alert('The 24-hour messaging window has expired. You can only send approved template messages now.')
      } else {
        alert(data.error || 'Failed to send message')
      }
    } catch {
      alert('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  async function handleAddContact() {
    if (!addContactForm.name.trim()) return

    setAddingContact(true)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${selectedId}/add-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addContactForm),
      })

      const data = await res.json()
      if (data.success) {
        setShowAddContact(false)
        await fetchMessages(selectedId)
        await fetchApprovals(selectedId)
        await fetchConversations()
      } else {
        alert(data.error || 'Failed to add contact')
      }
    } catch {
      alert('Failed to add contact')
    } finally {
      setAddingContact(false)
    }
  }

  function selectTemplate(template) {
    setSelectedTemplate(template)
    setTemplateVars({})
    // Pre-fill variable mapping with contact name if available
    const bodyComp = template.components?.find(c => c.type === 'BODY')
    const vars = bodyComp?.text?.match(/\{\{\d+\}\}/g) || []
    if (vars.length > 0 && conversation?.contacts?.first_name) {
      setTemplateVars({ '1': conversation.contacts.first_name })
    }
  }

  async function handleSendTemplate() {
    if (!selectedTemplate || !selectedId) return

    setSendingTemplate(true)
    try {
      // Build template components with variable values
      const bodyComp = selectedTemplate.components?.find(c => c.type === 'BODY')
      const vars = bodyComp?.text?.match(/\{\{\d+\}\}/g) || []
      const components = []

      if (vars.length > 0) {
        const parameters = vars.map((_, i) => ({
          type: 'text',
          text: templateVars[String(i + 1)] || ' ',
        }))
        components.push({ type: 'body', parameters })
      }

      const res = await fetch(`/api/whatsapp/conversations/${selectedId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'template',
          template_name: selectedTemplate.name,
          template_language: selectedTemplate.language || 'en',
          template_components: components,
          sent_by: userId,
        }),
      })

      const data = await res.json()
      if (data.success) {
        setShowTemplatePicker(false)
        setSelectedTemplate(null)
        setTemplateVars({})
        await fetchMessages(selectedId)
        await fetchApprovals(selectedId)
        await fetchConversations()
      } else {
        alert(data.error || 'Failed to send template')
      }
    } catch {
      alert('Failed to send template')
    } finally {
      setSendingTemplate(false)
    }
  }

  // C4 — send the selected card set as an in-session media carousel; the
  // route logs the thread row, so on success just clear + refresh.
  async function handleSendCardSet() {
    if (!selectedCardSetId || !selectedId) return
    setSendingCardSet(true)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${selectedId}/send-carousel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_set_id: selectedCardSetId }),
      })
      const data = await res.json()
      if (data.success) {
        setSelectedCardSetId('')
        await fetchMessages(selectedId)
        await fetchApprovals(selectedId)
        await fetchConversations()
      } else {
        alert(data.error || 'Failed to send card set')
      }
    } catch {
      alert('Failed to send card set')
    } finally {
      setSendingCardSet(false)
    }
  }

  // FLOW-SEND — send the location's booking Flow as an in-session flow
  // message; the route logs the thread row, so on success just refresh.
  async function handleSendFlow() {
    if (!selectedId || sendingFlow) return
    setSendingFlow(true)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${selectedId}/send-flow`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        await fetchMessages(selectedId)
        await fetchApprovals(selectedId)
        await fetchConversations()
      } else {
        alert(data.error || 'Failed to send booking Flow')
      }
    } catch {
      alert('Failed to send booking Flow')
    } finally {
      setSendingFlow(false)
    }
  }

  const windowOpen = conversation?.window_expires_at && new Date(conversation.window_expires_at) > new Date()
  const windowExpiry = conversation?.window_expires_at
    ? new Date(conversation.window_expires_at).toLocaleString('en-IE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    : null
  const isUnknown = conversation && !conversation.contact_id

  return (
    <div className={`flex ${embedded ? 'h-full' : 'h-screen'}`}>
      {/* Conversation list (hidden in embedded mode — the unified queue replaces it) */}
      <div className={`${embedded ? 'hidden' : 'flex'} w-80 border-r border-un1t-border flex-col shrink-0 bg-un1t-surface`}>
        <div className="p-4 border-b border-un1t-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/whatsapp" className="text-un1t-subtle hover:text-un1t-text transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <h3 className="font-semibold">Inbox</h3>
          </div>
          <button onClick={fetchConversations} className="p-1.5 text-un1t-subtle hover:text-un1t-text transition-colors">
            <RefreshCw size={14} />
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

        <div className="flex-1 overflow-auto">
          {loading && (
            <p className="text-sm text-un1t-subtle p-4 text-center">Loading...</p>
          )}

          {!loading && conversations.length === 0 && (
            <div className="p-6 text-center">
              <MessageCircle size={28} className="mx-auto mb-2 text-un1t-muted" />
              <p className="text-sm text-un1t-subtle">No conversations yet</p>
              <p className="text-xs text-un1t-muted mt-1">Messages will appear when contacts message you on WhatsApp</p>
            </div>
          )}

          {!loading && conversations.length > 0 && visibleConversations.length === 0 && (
            <p className="text-xs text-un1t-subtle p-4 text-center">
              Queue clear — nothing needs a reply. 🎉
            </p>
          )}

          {visibleConversations.map(conv => {
            const isSelected = selectedId === conv.id
            const displayName = getDisplayName(conv)
            const unknown = isUnknownSender(conv)

            return (
              <button
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={`w-full text-left px-4 py-3 border-b border-un1t-border transition-colors ${
                  isSelected ? 'bg-un1t-border/50' : 'hover:bg-un1t-border/20'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {displayName}
                      </p>
                      {unknown && (
                        <span className="bg-orange-500/20 text-orange-700 text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0">
                          NEW
                        </span>
                      )}
                      {conv.resolved_at && (
                        <Check size={12} className="text-green-600 shrink-0" />
                      )}
                      {conv.unread_count > 0 && (
                        <span className="bg-green-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-un1t-muted truncate mt-0.5">
                      {conv.last_message_direction === 'outbound' && <span className="text-un1t-subtle">You: </span>}
                      {conv.last_message_preview || 'No messages'}
                    </p>
                  </div>
                  <span className="text-[10px] text-un1t-muted shrink-0 ml-2">
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
              <MessageCircle size={48} className="mx-auto mb-3 text-un1t-muted" />
              <p className="text-un1t-subtle">Select a conversation to start messaging</p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="px-5 py-3 border-b border-un1t-border bg-un1t-surface flex items-center justify-between shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-sm">
                    {conversation?.contacts?.name || conversation?.wa_profile_name || conversation?.wa_phone}
                  </p>
                  {isUnknown && (
                    <span className="bg-orange-500/20 text-orange-700 text-[9px] font-bold px-1.5 py-0.5 rounded">
                      Not in contacts
                    </span>
                  )}
                </div>
                <p className="text-xs text-un1t-muted">
                  {conversation?.wa_phone}
                  {conversation?.contacts?.pipeline_stage_slug && (
                    <span> · {conversation.contacts.pipeline_stage_slug.replace(/_/g, ' ')}</span>
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
                {conversation && (
                  <button
                    onClick={() => toggleResolved(conversation)}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      conversation.resolved_at
                        ? 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
                        : 'bg-green-600 border-transparent text-white hover:bg-green-700'
                    }`}
                  >
                    <Check size={12} />
                    {conversation.resolved_at ? 'Reopen' : 'Resolve'}
                  </button>
                )}
                {conversation && (
                  <button
                    onClick={() => toggleBlocked(conversation)}
                    title={conversation.is_blocked ? 'Unblock this sender' : 'Block this sender (spam/abuse)'}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      conversation.is_blocked
                        ? 'bg-red-600 border-transparent text-white hover:bg-red-700'
                        : 'border-un1t-border text-un1t-subtle hover:text-red-600'
                    }`}
                  >
                    {conversation.is_blocked ? 'Blocked — unblock' : 'Block'}
                  </button>
                )}
                {isUnknown ? (
                  <button
                    onClick={() => setShowAddContact(!showAddContact)}
                    className="flex items-center gap-1.5 text-xs bg-green-600 text-white px-3 py-1.5 rounded-md hover:bg-green-700 transition-colors"
                  >
                    <UserPlus size={12} />
                    Add to Contacts
                  </button>
                ) : conversation?.contacts?.id && (
                  <Link
                    href={`/contacts/${conversation.contacts.id}`}
                    className="flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text transition-colors"
                  >
                    <UserCheck size={12} />
                    View contact
                  </Link>
                )}
              </div>
            </div>

            {/* UIX-P1 composer state — opted-out contact. STOP flipped
                wa_status to opted_out (#455/#456); marketing sends are
                blocked elsewhere, this banner tells the operator that
                only service replies belong in this thread. */}
            {conversation?.contacts?.wa_status === 'opted_out' && (
              <div className="shrink-0 px-5 py-2 bg-amber-500/10 border-b border-un1t-border text-xs text-amber-700">
                This contact replied STOP — unsubscribed from WhatsApp marketing. Service replies only.
              </div>
            )}

            {/* Add to Contacts form — slides in below header */}
            {showAddContact && isUnknown && (
              <div className="border-b border-un1t-border bg-un1t-surface/80 px-5 py-4 shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <UserPlus size={14} />
                    Add to Contacts
                  </h4>
                  <button onClick={() => setShowAddContact(false)} className="text-un1t-subtle hover:text-un1t-text">
                    <X size={14} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 max-w-2xl">
                  <div>
                    <label className="block text-xs text-un1t-subtle mb-1">Full Name *</label>
                    <input
                      type="text"
                      value={addContactForm.name}
                      onChange={e => setAddContactForm({ ...addContactForm, name: e.target.value, first_name: e.target.value.split(' ')[0] })}
                      placeholder="John Smith"
                      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-subtle mb-1">Email (optional)</label>
                    <input
                      type="email"
                      value={addContactForm.email}
                      onChange={e => setAddContactForm({ ...addContactForm, email: e.target.value })}
                      placeholder="john@example.com"
                      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-subtle mb-1">Pipeline Stage</label>
                    <select
                      value={addContactForm.pipeline_stage}
                      onChange={e => setAddContactForm({ ...addContactForm, pipeline_stage: e.target.value })}
                      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                    >
                      <option value="new">New</option>
                      <option value="contacted">Contacted</option>
                      <option value="trial_booked">Trial Booked</option>
                      <option value="trial_attended">Trial Attended</option>
                      <option value="negotiation">Negotiation</option>
                      <option value="won">Won</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-4 mt-3">
                  <label className="flex items-center gap-2 text-xs text-un1t-subtle cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addContactForm.add_to_pipeline}
                      onChange={e => setAddContactForm({ ...addContactForm, add_to_pipeline: e.target.checked })}
                      className="rounded border-un1t-border"
                    />
                    Add to pipeline
                  </label>
                  <div className="flex-1" />
                  <button
                    onClick={() => setShowAddContact(false)}
                    className="text-xs text-un1t-subtle hover:text-un1t-text px-3 py-1.5 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddContact}
                    disabled={addingContact || !addContactForm.name.trim()}
                    className="flex items-center gap-1.5 text-xs bg-green-600 text-white px-4 py-1.5 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    <UserPlus size={12} />
                    {addingContact ? 'Adding...' : 'Add Contact'}
                  </button>
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-auto p-4 space-y-2 bg-[#0b141a]">
              {mergeTimeline(messages, approvals).map(item => {
                if (item.kind === 'approval') {
                  return (
                    <ApprovalActionCard
                      key={item.key}
                      request={item.request}
                      contactId={conversation?.contact_id || null}
                      locationId={locationId}
                      contactFirstName={conversation?.contacts?.first_name || conversation?.wa_profile_name?.split(' ')[0] || null}
                      onDecided={updated => setApprovals(prev => prev.map(r => (r.id === updated.id ? updated : r)))}
                      onPrefillComposer={text => setNewMessage(text)}
                      onOpenBookTab={onOpenBookTab}
                    />
                  )
                }
                const msg = item.message
                return (
                  <div
                    key={item.key}
                    className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`max-w-[65%] rounded-lg px-3 py-2 ${
                      msg.direction === 'outbound'
                        ? 'bg-[#005c4b] text-un1t-text'
                        : 'bg-un1t-surface text-un1t-text'
                    }`}>
                      {msg.message_type === 'template' && (
                        <p className="text-[10px] text-green-300 mb-1">Template: {msg.template_name}</p>
                      )}
                      {isServableMedia(msg)
                        ? <WAMediaContent message={msg} />
                        : <MessageTypeIcon type={msg.message_type} />}
                      {(msg.body || !isServableMedia(msg)) && (
                        <p className="text-sm whitespace-pre-wrap">{msg.body || `[${msg.message_type}]`}</p>
                      )}
                      <div className="flex items-center justify-end gap-1 mt-0.5">
                        {/* C6 — react to a customer message (👍 ❤️ 🔥) */}
                        {msg.direction === 'inbound' && msg.wa_message_id && (
                          <span className="flex items-center gap-1 mr-auto">
                            {['👍', '❤️', '🔥'].map(emoji => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => reactToMessage(msg, emoji)}
                                disabled={reactingId === msg.id}
                                className="text-[11px] leading-none opacity-40 hover:opacity-90 disabled:opacity-20"
                                title="React"
                              >{emoji}</button>
                            ))}
                          </span>
                        )}
                        {/* AGENT-QA.1 — rate Mia's replies; feeds the analytics quality list */}
                        {msg.source === 'agent' && (
                          <span className="flex items-center gap-1 mr-auto">
                            <button
                              type="button"
                              onClick={() => rateAgentMessage(msg, 'up')}
                              className={`text-[11px] leading-none ${agentFeedback[msg.id] === 'up' ? 'opacity-100' : 'opacity-40 hover:opacity-90'}`}
                              title="Good reply"
                            >👍</button>
                            <button
                              type="button"
                              onClick={() => rateAgentMessage(msg, 'down')}
                              className={`text-[11px] leading-none ${agentFeedback[msg.id] === 'down' ? 'opacity-100' : 'opacity-40 hover:opacity-90'}`}
                              title="Bad reply — add a note"
                            >👎</button>
                          </span>
                        )}
                        <span className="text-[10px] text-un1t-text/50">
                          {new Date(msg.sent_at || msg.created_at).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {msg.direction === 'outbound' && <StatusIcon status={msg.status} />}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Message input / Template picker */}
            <div className="border-t border-un1t-border bg-un1t-surface shrink-0">
              {windowOpen ? (
                /* Normal text input when window is open */
                <div className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newMessage}
                      onChange={e => setNewMessage(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                      placeholder="Type a message..."
                      className="flex-1 bg-un1t-bg border border-un1t-border rounded-full px-4 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || !newMessage.trim()}
                      className="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      <Send size={16} className="text-un1t-text ml-0.5" />
                    </button>
                  </div>
                  {/* C4 — send a curated card set as a media carousel (hidden
                      when the location has none configured) */}
                  {Array.isArray(cardSets) && cardSets.length > 0 && (
                    <div className="flex items-center gap-2 mt-2">
                      <ImageIcon size={12} className="text-un1t-muted shrink-0" />
                      <select
                        value={selectedCardSetId}
                        onChange={e => setSelectedCardSetId(e.target.value)}
                        disabled={sendingCardSet}
                        className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                      >
                        <option value="">Send cards…</option>
                        {cardSets.map(s => (
                          <option key={s.id} value={s.id}>{s.name} ({s.cards?.length || 0} cards)</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={handleSendCardSet}
                        disabled={sendingCardSet || !selectedCardSetId}
                        className="text-xs bg-green-600 text-white px-3 py-1 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                      >
                        {sendingCardSet ? 'Sending…' : 'Send cards'}
                      </button>
                    </div>
                  )}
                  {/* FLOW-SEND — drop the booking Flow into the chat (hidden when
                      the location has no Flow configured, or the sender isn't a
                      contact yet — the Flow books against the linked contact) */}
                  {flowAvailable && conversation?.contact_id && (
                    <div className="flex items-center gap-2 mt-2">
                      <CalendarPlus size={12} className="text-un1t-muted shrink-0" />
                      <button
                        type="button"
                        onClick={handleSendFlow}
                        disabled={sendingFlow}
                        className="text-xs bg-green-600 text-white px-3 py-1 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                      >
                        {sendingFlow ? 'Sending…' : 'Send booking Flow'}
                      </button>
                      <span className="text-[11px] text-un1t-muted">In-chat &ldquo;Book your first visit&rdquo;</span>
                    </div>
                  )}
                </div>
              ) : (
                /* Template picker when window is closed */
                <div className="px-4 py-3">
                  {!showTemplatePicker && !selectedTemplate && (
                    <div className="text-center">
                      <p className="text-xs text-orange-400 mb-2">
                        The 24h window is closed. Send a template message to start the conversation.
                      </p>
                      <button
                        onClick={() => setShowTemplatePicker(true)}
                        className="flex items-center gap-2 mx-auto text-sm bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors"
                      >
                        <LayoutTemplate size={14} />
                        Choose Template
                      </button>
                    </div>
                  )}

                  {showTemplatePicker && !selectedTemplate && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-un1t-subtle font-semibold uppercase tracking-wider">Select a template</p>
                        <button onClick={() => setShowTemplatePicker(false)} className="text-un1t-subtle hover:text-un1t-text">
                          <X size={14} />
                        </button>
                      </div>
                      {templates.length === 0 ? (
                        <p className="text-xs text-un1t-muted py-2">No approved templates available. Create one in WhatsApp → Templates.</p>
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-auto">
                          {templates.map(t => {
                            const bodyComp = t.components?.find(c => c.type === 'BODY')
                            return (
                              <button
                                key={t.id}
                                onClick={() => selectTemplate(t)}
                                className="w-full text-left px-3 py-2 rounded-md hover:bg-un1t-border/30 transition-colors"
                              >
                                <p className="text-sm font-medium flex items-center gap-1.5">
                                  {t.name}
                                  {t.quality_rating === 'RED' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-700">RED</span>}
                                  {t.quality_rating === 'YELLOW' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700">YELLOW</span>}
                                </p>
                                <p className="text-xs text-un1t-muted truncate mt-0.5">
                                  {bodyComp?.text || 'No body text'}
                                </p>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {selectedTemplate && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-un1t-subtle font-semibold uppercase tracking-wider">
                          Template: {selectedTemplate.name}
                        </p>
                        <button
                          onClick={() => { setSelectedTemplate(null); setShowTemplatePicker(true) }}
                          className="text-xs text-un1t-subtle hover:text-un1t-text"
                        >
                          Change
                        </button>
                      </div>

                      {/* Template preview */}
                      <div className="bg-[#005c4b] rounded-lg px-3 py-2 mb-3 max-w-[80%]">
                        <p className="text-sm text-un1t-text whitespace-pre-wrap">
                          {(() => {
                            const bodyComp = selectedTemplate.components?.find(c => c.type === 'BODY')
                            let text = bodyComp?.text || ''
                            // Replace variables with filled values
                            text = text.replace(/\{\{(\d+)\}\}/g, (match, num) => {
                              return templateVars[num] || `{{${num}}}`
                            })
                            return text
                          })()}
                        </p>
                      </div>

                      {/* Variable inputs */}
                      {(() => {
                        const bodyComp = selectedTemplate.components?.find(c => c.type === 'BODY')
                        const vars = bodyComp?.text?.match(/\{\{\d+\}\}/g) || []
                        if (vars.length === 0) return null

                        return (
                          <div className="space-y-2 mb-3">
                            {vars.map((v, i) => {
                              const num = String(i + 1)
                              return (
                                <div key={num} className="flex items-center gap-2">
                                  <span className="text-xs text-un1t-muted w-10">{`{{${num}}}`}</span>
                                  <input
                                    type="text"
                                    value={templateVars[num] || ''}
                                    onChange={e => setTemplateVars({ ...templateVars, [num]: e.target.value })}
                                    placeholder={num === '1' ? 'e.g. first name' : `Variable ${num}`}
                                    className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                                  />
                                </div>
                              )
                            })}
                          </div>
                        )
                      })()}

                      <button
                        onClick={handleSendTemplate}
                        disabled={sendingTemplate}
                        className="flex items-center gap-2 text-sm bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 w-full justify-center"
                      >
                        <Send size={14} />
                        {sendingTemplate ? 'Sending...' : 'Send Template'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
