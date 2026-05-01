'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Send, MessageCircle, Clock, CheckCheck,
  Check, Image, FileText, Mic, AlertCircle, RefreshCw,
  UserPlus, X, UserCheck, LayoutTemplate
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

// Display name helper — prefers contact name, falls back to WA profile name, then phone
function getDisplayName(conv) {
  if (conv.contacts?.name) return conv.contacts.name
  if (conv.wa_profile_name) return conv.wa_profile_name
  return conv.wa_phone
}

function isUnknownSender(conv) {
  return !conv.contact_id && !conv.contacts
}

export default function WAInbox({ locationId, userId, initialConversationId }) {
  const [conversations, setConversations] = useState([])
  const [selectedId, setSelectedId] = useState(initialConversationId || null)
  const [messages, setMessages] = useState([])
  const [conversation, setConversation] = useState(null)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showAddContact, setShowAddContact] = useState(false)
  const [addContactForm, setAddContactForm] = useState({
    name: '', first_name: '', email: '', lead_status: 'new_lead', add_to_pipeline: true, pipeline_stage: 'new',
  })
  const [addingContact, setAddingContact] = useState(false)
  const [templates, setTemplates] = useState([])
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [templateVars, setTemplateVars] = useState({})
  const [sendingTemplate, setSendingTemplate] = useState(false)
  const messagesEndRef = useRef(null)
  const pollRef = useRef(null)

  // Load conversations
  useEffect(() => {
    fetchConversations()
    fetchTemplates()
    pollRef.current = setInterval(fetchConversations, 10000)
    return () => clearInterval(pollRef.current)
  }, [locationId])

  // Load messages when conversation selected
  useEffect(() => {
    if (selectedId) {
      fetchMessages(selectedId)
      setShowAddContact(false)
    }
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
        await fetchConversations()
      } else {
        alert(data.error || 'Failed to add contact')
      }
    } catch (err) {
      alert('Failed to add contact')
    } finally {
      setAddingContact(false)
    }
  }

  async function fetchTemplates() {
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}&status=APPROVED`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch (err) {
      console.error('Failed to fetch templates:', err)
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
        await fetchConversations()
      } else {
        alert(data.error || 'Failed to send template')
      }
    } catch (err) {
      alert('Failed to send template')
    } finally {
      setSendingTemplate(false)
    }
  }

  const windowOpen = conversation?.window_expires_at && new Date(conversation.window_expires_at) > new Date()
  const windowExpiry = conversation?.window_expires_at
    ? new Date(conversation.window_expires_at).toLocaleString('en-IE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    : null
  const isUnknown = conversation && !conversation.contact_id

  return (
    <div className="flex h-screen">
      {/* Conversation list */}
      <div className="w-80 border-r border-un1t-gray flex flex-col shrink-0 bg-un1t-dark">
        <div className="p-4 border-b border-un1t-gray flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/whatsapp" className="text-un1t-light hover:text-un1t-white transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <h3 className="font-semibold">Inbox</h3>
          </div>
          <button onClick={fetchConversations} className="p-1.5 text-un1t-light hover:text-un1t-white transition-colors">
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
            const isSelected = selectedId === conv.id
            const displayName = getDisplayName(conv)
            const unknown = isUnknownSender(conv)

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
                        {displayName}
                      </p>
                      {unknown && (
                        <span className="bg-orange-500/20 text-orange-400 text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0">
                          NEW
                        </span>
                      )}
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
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-sm">
                    {conversation?.contacts?.name || conversation?.wa_profile_name || conversation?.wa_phone}
                  </p>
                  {isUnknown && (
                    <span className="bg-orange-500/20 text-orange-400 text-[9px] font-bold px-1.5 py-0.5 rounded">
                      Not in contacts
                    </span>
                  )}
                </div>
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
                    className="flex items-center gap-1.5 text-xs text-un1t-light hover:text-un1t-white transition-colors"
                  >
                    <UserCheck size={12} />
                    View contact
                  </Link>
                )}
              </div>
            </div>

            {/* Add to Contacts form — slides in below header */}
            {showAddContact && isUnknown && (
              <div className="border-b border-un1t-gray bg-un1t-dark/80 px-5 py-4 shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <UserPlus size={14} />
                    Add to Contacts
                  </h4>
                  <button onClick={() => setShowAddContact(false)} className="text-un1t-light hover:text-un1t-white">
                    <X size={14} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 max-w-2xl">
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Full Name *</label>
                    <input
                      type="text"
                      value={addContactForm.name}
                      onChange={e => setAddContactForm({ ...addContactForm, name: e.target.value, first_name: e.target.value.split(' ')[0] })}
                      placeholder="John Smith"
                      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Email (optional)</label>
                    <input
                      type="email"
                      value={addContactForm.email}
                      onChange={e => setAddContactForm({ ...addContactForm, email: e.target.value })}
                      placeholder="john@example.com"
                      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Lead Status</label>
                    <select
                      value={addContactForm.lead_status}
                      onChange={e => setAddContactForm({ ...addContactForm, lead_status: e.target.value })}
                      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                    >
                      <option value="new_lead">New Lead</option>
                      <option value="contacted">Contacted</option>
                      <option value="active_trial">Active Trial</option>
                      <option value="member">Member</option>
                      <option value="past_member">Past Member</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-un1t-light mb-1">Pipeline Stage</label>
                    <select
                      value={addContactForm.pipeline_stage}
                      onChange={e => setAddContactForm({ ...addContactForm, pipeline_stage: e.target.value })}
                      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
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
                  <label className="flex items-center gap-2 text-xs text-un1t-light cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addContactForm.add_to_pipeline}
                      onChange={e => setAddContactForm({ ...addContactForm, add_to_pipeline: e.target.checked })}
                      className="rounded border-un1t-gray"
                    />
                    Add to pipeline
                  </label>
                  <div className="flex-1" />
                  <button
                    onClick={() => setShowAddContact(false)}
                    className="text-xs text-un1t-light hover:text-un1t-white px-3 py-1.5 transition-colors"
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
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[65%] rounded-lg px-3 py-2 ${
                    msg.direction === 'outbound'
                      ? 'bg-[#005c4b] text-un1t-white'
                      : 'bg-un1t-dark text-un1t-white'
                  }`}>
                    {msg.message_type === 'template' && (
                      <p className="text-[10px] text-green-300 mb-1">Template: {msg.template_name}</p>
                    )}
                    <MessageTypeIcon type={msg.message_type} />
                    <p className="text-sm whitespace-pre-wrap">{msg.body || `[${msg.message_type}]`}</p>
                    <div className="flex items-center justify-end gap-1 mt-0.5">
                      <span className="text-[10px] text-un1t-white/50">
                        {new Date(msg.sent_at || msg.created_at).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {msg.direction === 'outbound' && <StatusIcon status={msg.status} />}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Message input / Template picker */}
            <div className="border-t border-un1t-gray bg-un1t-dark shrink-0">
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
                      className="flex-1 bg-un1t-black border border-un1t-gray rounded-full px-4 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || !newMessage.trim()}
                      className="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      <Send size={16} className="text-un1t-white ml-0.5" />
                    </button>
                  </div>
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
                        <p className="text-xs text-un1t-light font-semibold uppercase tracking-wider">Select a template</p>
                        <button onClick={() => setShowTemplatePicker(false)} className="text-un1t-light hover:text-un1t-white">
                          <X size={14} />
                        </button>
                      </div>
                      {templates.length === 0 ? (
                        <p className="text-xs text-un1t-mid py-2">No approved templates available. Create one in WhatsApp → Templates.</p>
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-auto">
                          {templates.map(t => {
                            const bodyComp = t.components?.find(c => c.type === 'BODY')
                            return (
                              <button
                                key={t.id}
                                onClick={() => selectTemplate(t)}
                                className="w-full text-left px-3 py-2 rounded-md hover:bg-un1t-gray/30 transition-colors"
                              >
                                <p className="text-sm font-medium">{t.name}</p>
                                <p className="text-xs text-un1t-mid truncate mt-0.5">
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
                        <p className="text-xs text-un1t-light font-semibold uppercase tracking-wider">
                          Template: {selectedTemplate.name}
                        </p>
                        <button
                          onClick={() => { setSelectedTemplate(null); setShowTemplatePicker(true) }}
                          className="text-xs text-un1t-light hover:text-un1t-white"
                        >
                          Change
                        </button>
                      </div>

                      {/* Template preview */}
                      <div className="bg-[#005c4b] rounded-lg px-3 py-2 mb-3 max-w-[80%]">
                        <p className="text-sm text-un1t-white whitespace-pre-wrap">
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
                                  <span className="text-xs text-un1t-mid w-10">{`{{${num}}}`}</span>
                                  <input
                                    type="text"
                                    value={templateVars[num] || ''}
                                    onChange={e => setTemplateVars({ ...templateVars, [num]: e.target.value })}
                                    placeholder={num === '1' ? 'e.g. first name' : `Variable ${num}`}
                                    className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-3 py-1.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
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
