'use client'

import { useState, useRef, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { MessageCircle, X, Send, Bot, User, Loader2, Sparkles } from 'lucide-react'

const WELCOME_SUGGESTIONS = [
  'How do I create a new shift?',
  'Show me how the pipeline works',
  'Who is working this week?',
  'Help me get started',
]

export default function AssistantBubble({ user }) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [, setHasInteracted] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const pathname = usePathname()
  const router = useRouter()

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input when opened
  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  // Apply a buffered (non-streaming) JSON response. Used both when the
  // server returns JSON and as the fallback when streaming fails.
  function applyBuffered(baseMessages, data) {
    if (!data || data.error) {
      setMessages([...baseMessages, { role: 'assistant', content: `Sorry, something went wrong: ${data?.error || 'unknown error'}` }])
      return
    }
    setMessages([...baseMessages, { role: 'assistant', content: data.response, navigateTo: data.navigateTo }])
    if (data.navigateTo) router.push(data.navigateTo)
  }

  async function sendMessage(text) {
    if (!text.trim() || loading) return
    setHasInteracted(true)

    const userMessage = { role: 'user', content: text }
    const baseMessages = [...messages, userMessage]
    setMessages(baseMessages)
    setInput('')
    setLoading(true)

    const payload = {
      messages: baseMessages.map(({ role, content }) => ({ role, content })),
      userContext: {
        name: user?.full_name,
        role: user?.role,
        userId: user?.id,
        currentPage: pathname,
        locationId: user?.activeLocation?.id,
        locationName: user?.activeLocation?.name,
        permissions: user?.permissions,
      },
    }

    // Update the in-flight streaming assistant bubble with accumulated text.
    const paintStreaming = (content) => setMessages((prev) => {
      const copy = prev.slice()
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'assistant' && copy[i].streaming) {
          copy[i] = { ...copy[i], content }
          break
        }
      }
      return copy
    })

    try {
      // Prefer streaming (ASSIST-STREAM.1).
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, stream: true }),
      })
      const ct = res.headers.get('content-type') || ''

      if (res.ok && ct.includes('text/event-stream') && res.body) {
        setLoading(false)
        setMessages((prev) => [...prev, { role: 'assistant', content: '', streaming: true }])

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let acc = ''
        let navigateTo = null

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const frames = buf.split('\n\n')
          buf = frames.pop() || ''
          for (const f of frames) {
            const dataLine = f.split('\n').find((l) => l.startsWith('data:'))
            if (!dataLine) continue
            let obj
            try { obj = JSON.parse(dataLine.slice(5).trim()) } catch { continue }
            if (obj.type === 'text') { acc += obj.delta || ''; paintStreaming(acc) }
            else if (obj.type === 'done') { navigateTo = obj.navigateTo || null }
            else if (obj.type === 'error') { acc = acc || `Sorry, something went wrong: ${obj.error}`; paintStreaming(acc) }
          }
        }

        // Finalize the bubble.
        setMessages((prev) => {
          const copy = prev.slice()
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'assistant' && copy[i].streaming) {
              copy[i] = { role: 'assistant', content: acc || '…', navigateTo }
              break
            }
          }
          return copy
        })
        if (navigateTo) router.push(navigateTo)
        return
      }

      // Server didn't stream — consume as buffered JSON.
      if (ct.includes('application/json')) {
        applyBuffered(baseMessages, await res.json())
        setLoading(false)
        return
      }
      throw new Error('unexpected response')
    } catch {
      // Fallback: one buffered (non-streaming) attempt.
      try {
        const res2 = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        applyBuffered(baseMessages, await res2.json())
      } catch {
        setMessages([...baseMessages, { role: 'assistant', content: 'Sorry, I couldn\'t connect to the assistant. Please try again.' }])
      }
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  // Don't show on public pages
  if (['/login', '/book/', '/unsubscribe/', '/preferences/'].some(p => pathname.startsWith(p))) {
    return null
  }

  return (
    <>
      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed bottom-20 right-6 w-96 h-[520px] bg-un1t-surface border border-un1t-border rounded-2xl shadow-2xl flex flex-col z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-un1t-border bg-un1t-surface">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
                <Sparkles size={16} className="text-white" />
              </div>
              <div>
                <span className="text-sm font-semibold">Repset Assistant</span>
                <p className="text-[10px] text-un1t-subtle">Powered by Claude</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Welcome message */}
            {messages.length === 0 && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot size={14} className="text-white" />
                  </div>
                  <div className="bg-un1t-border/30 rounded-xl rounded-tl-sm px-3 py-2.5 text-sm max-w-[280px]">
                    Hi {user?.full_name?.split(' ')[0] || 'there'}! I'm your Repset assistant. I can help you navigate the CRM, answer questions, or take actions for you. What can I help with?
                  </div>
                </div>

                {/* Suggestions */}
                <div className="pl-9 flex flex-wrap gap-1.5">
                  {WELCOME_SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      className="text-xs px-3 py-1.5 rounded-full border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot size={14} className="text-white" />
                  </div>
                )}
                <div
                  className={`rounded-xl px-3 py-2.5 text-sm max-w-[280px] whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-tr-sm'
                      : 'bg-un1t-border/30 rounded-tl-sm'
                  }`}
                >
                  {msg.content || (msg.streaming ? '▍' : '')}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-un1t-border flex items-center justify-center shrink-0 mt-0.5">
                    <User size={14} className="text-un1t-text" />
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex gap-2">
                <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                  <Bot size={14} className="text-white" />
                </div>
                <div className="bg-un1t-border/30 rounded-xl rounded-tl-sm px-4 py-3">
                  <Loader2 size={16} className="animate-spin text-un1t-subtle" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-un1t-border p-3">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me anything..."
                className="flex-1 bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                disabled={loading}
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || loading}
                className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 disabled:hover:bg-blue-600"
              >
                <Send size={16} />
              </button>
            </div>
            <p className="text-[10px] text-un1t-muted mt-1.5 text-center">
              Currently on: {pathname}
            </p>
          </div>
        </div>
      )}

      {/* Floating Bubble */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all z-50 ${
          isOpen
            ? 'bg-un1t-border hover:bg-un1t-border/80'
            : 'bg-blue-600 hover:bg-blue-500 hover:scale-105'
        }`}
      >
        {isOpen ? (
          <X size={22} className="text-un1t-text" />
        ) : (
          <MessageCircle size={22} className="text-white" />
        )}
      </button>
    </>
  )
}
