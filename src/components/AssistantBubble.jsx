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
  const [hasInteracted, setHasInteracted] = useState(false)
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

  async function sendMessage(text) {
    if (!text.trim() || loading) return
    setHasInteracted(true)

    const userMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          userContext: {
            name: user?.full_name,
            role: user?.role,
            userId: user?.id,
            currentPage: pathname,
            locationId: user?.activeLocation?.id,
            locationName: user?.activeLocation?.name,
            permissions: user?.permissions,
          },
        }),
      })

      const data = await res.json()

      if (data.error) {
        setMessages([...newMessages, { role: 'assistant', content: `Sorry, something went wrong: ${data.error}` }])
      } else {
        setMessages([...newMessages, { role: 'assistant', content: data.response, navigateTo: data.navigateTo }])

        // If the assistant suggests navigation, offer to go there
        if (data.navigateTo) {
          router.push(data.navigateTo)
        }
      }
    } catch (err) {
      setMessages([...newMessages, { role: 'assistant', content: 'Sorry, I couldn\'t connect to the assistant. Please try again.' }])
    }

    setLoading(false)
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
        <div className="fixed bottom-20 right-6 w-96 h-[520px] bg-un1t-dark border border-un1t-gray rounded-2xl shadow-2xl flex flex-col z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-un1t-gray bg-un1t-dark">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
                <Sparkles size={16} className="text-white" />
              </div>
              <div>
                <span className="text-sm font-semibold">UN1T Assistant</span>
                <p className="text-[10px] text-un1t-light">Powered by Claude</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 rounded-lg hover:bg-un1t-gray/50 text-un1t-light hover:text-un1t-white transition-colors"
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
                  <div className="bg-un1t-gray/30 rounded-xl rounded-tl-sm px-3 py-2.5 text-sm max-w-[280px]">
                    Hi {user?.full_name?.split(' ')[0] || 'there'}! I'm your UN1T assistant. I can help you navigate the CRM, answer questions, or take actions for you. What can I help with?
                  </div>
                </div>

                {/* Suggestions */}
                <div className="pl-9 flex flex-wrap gap-1.5">
                  {WELCOME_SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      className="text-xs px-3 py-1.5 rounded-full border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors"
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
                      : 'bg-un1t-gray/30 rounded-tl-sm'
                  }`}
                >
                  {msg.content}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-un1t-gray flex items-center justify-center shrink-0 mt-0.5">
                    <User size={14} className="text-un1t-white" />
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex gap-2">
                <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                  <Bot size={14} className="text-white" />
                </div>
                <div className="bg-un1t-gray/30 rounded-xl rounded-tl-sm px-4 py-3">
                  <Loader2 size={16} className="animate-spin text-un1t-light" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-un1t-gray p-3">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me anything..."
                className="flex-1 bg-un1t-black border border-un1t-gray rounded-lg px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
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
            <p className="text-[10px] text-un1t-mid mt-1.5 text-center">
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
            ? 'bg-un1t-gray hover:bg-un1t-gray/80'
            : 'bg-blue-600 hover:bg-blue-500 hover:scale-105'
        }`}
      >
        {isOpen ? (
          <X size={22} className="text-un1t-white" />
        ) : (
          <MessageCircle size={22} className="text-white" />
        )}
      </button>
    </>
  )
}
