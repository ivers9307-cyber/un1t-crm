'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { ArrowLeft, Save, Send, Eye, Users, Code, Paintbrush } from 'lucide-react'
import AudienceBuilder from './AudienceBuilder'
import Link from 'next/link'

export default function CampaignEditor({ campaign, locationId, userId }) {
  const router = useRouter()
  const db = createBrowserClient()
  const editorRef = useRef(null)
  const isEditing = !!campaign

  const [tab, setTab] = useState('design')  // design, code, audience, settings
  const [name, setName] = useState(campaign?.name || '')
  const [subject, setSubject] = useState(campaign?.subject || '')
  const [previewText, setPreviewText] = useState(campaign?.preview_text || '')
  const [fromName, setFromName] = useState(campaign?.from_name || 'UN1T')
  const [fromEmail, setFromEmail] = useState(campaign?.from_email || '')
  const [replyTo, setReplyTo] = useState(campaign?.reply_to || '')
  const [audienceFilter, setAudienceFilter] = useState(
    campaign?.audience_filter || { filters: [], logic: 'and' }
  )
  const [htmlContent, setHtmlContent] = useState(campaign?.html_content || '')
  const [designJson, setDesignJson] = useState(campaign?.design_json || null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [audienceCount, setAudienceCount] = useState(null)
  const [campaignId, setCampaignId] = useState(campaign?.id || null)
  const [error, setError] = useState(null)
  const [editorMode, setEditorMode] = useState(designJson ? 'visual' : 'visual')  // visual or code
  const [unlayerLoaded, setUnlayerLoaded] = useState(false)

  // Load Unlayer script
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.unlayer) {
      const script = document.createElement('script')
      script.src = 'https://editor.unlayer.com/embed.js'
      script.async = true
      script.onload = () => setUnlayerLoaded(true)
      document.body.appendChild(script)
    } else if (window.unlayer) {
      setUnlayerLoaded(true)
    }
  }, [])

  // Initialize Unlayer editor
  useEffect(() => {
    if (unlayerLoaded && tab === 'design' && editorMode === 'visual' && editorRef.current) {
      // Clear previous instance
      editorRef.current.innerHTML = ''

      window.unlayer.init({
        id: 'unlayer-editor',
        projectId: undefined,  // No account needed for basic features
        displayMode: 'email',
        appearance: {
          theme: 'dark',
          panels: {
            tools: { dock: 'left' },
          },
        },
        tools: {
          image: { enabled: true },
          button: { enabled: true },
          divider: { enabled: true },
          heading: { enabled: true },
          html: { enabled: true },
          menu: { enabled: true },
          social: { enabled: true },
          text: { enabled: true },
          timer: { enabled: true },
          video: { enabled: true },
        },
        mergeTags: [
          { name: 'First Name', value: '{{first_name}}' },
          { name: 'Full Name', value: '{{name}}' },
          { name: 'Email', value: '{{email}}' },
          { name: 'Location', value: '{{location_name}}' },
          { name: 'Unsubscribe', value: '{{unsubscribe_url}}' },
          { name: 'Preferences', value: '{{preference_url}}' },
          { name: 'Year', value: '{{current_year}}' },
        ],
        features: {
          textEditor: {
            spellChecker: true,
          },
        },
      })

      // Load existing design if editing
      if (designJson) {
        window.unlayer.loadDesign(designJson)
      }
    }
  }, [unlayerLoaded, tab, editorMode])

  // Get HTML and design JSON from Unlayer
  const exportFromUnlayer = useCallback(() => {
    return new Promise((resolve) => {
      if (!window.unlayer) {
        resolve({ html: htmlContent, design: designJson })
        return
      }

      window.unlayer.exportHtml((data) => {
        resolve({ html: data.html, design: data.design })
      })
    })
  }, [htmlContent, designJson])

  // Save campaign
  async function handleSave() {
    setSaving(true)
    setError(null)

    try {
      let html = htmlContent
      let design = designJson

      if (editorMode === 'visual' && window.unlayer) {
        const exported = await exportFromUnlayer()
        html = exported.html
        design = exported.design
      }

      const payload = {
        name: name || 'Untitled Campaign',
        subject,
        preview_text: previewText || null,
        from_name: fromName || null,
        from_email: fromEmail || null,
        reply_to: replyTo || null,
        design_json: design,
        html_content: html,
        audience_filter: audienceFilter,
        location_id: locationId,
        created_by: userId,
      }

      let result
      if (campaignId) {
        result = await db.from('campaigns').update(payload).eq('id', campaignId).select().single()
      } else {
        result = await db.from('campaigns').insert({ ...payload, status: 'draft' }).select().single()
      }

      if (result.error) throw new Error(result.error.message)

      if (!campaignId) {
        setCampaignId(result.data.id)
        // Update URL without navigation
        window.history.replaceState(null, '', `/email/campaigns/${result.data.id}`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // Send campaign
  async function handleSend() {
    if (!campaignId) {
      await handleSave()
    }

    if (!confirm(`Send this campaign to ${audienceCount || 'all matching'} contacts? This cannot be undone.`)) return

    setSending(true)
    setError(null)

    try {
      // Save latest content first
      await handleSave()

      const response = await fetch(`/api/campaigns/${campaignId}/send`, {
        method: 'POST',
      })

      const result = await response.json()

      if (!result.success) throw new Error(result.error)

      router.push(`/email/campaigns/${campaignId}`)
      router.refresh()
    } catch (err) {
      setError(err.message)
      setSending(false)
    }
  }

  // Fetch audience count
  async function refreshAudienceCount() {
    if (!campaignId) return

    try {
      const response = await fetch(`/api/campaigns/${campaignId}/preview`)
      const result = await response.json()
      if (result.success) setAudienceCount(result.audience_count)
    } catch (err) {
      console.error('Failed to get audience count:', err)
    }
  }

  useEffect(() => {
    if (campaignId) refreshAudienceCount()
  }, [campaignId, audienceFilter])

  const tabs = [
    { key: 'design', label: 'Design', icon: Paintbrush },
    { key: 'audience', label: 'Audience', icon: Users },
    { key: 'settings', label: 'Settings', icon: null },
  ]

  return (
    <div className="flex flex-col h-screen">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-gray bg-un1t-dark shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/email" className="text-un1t-light hover:text-un1t-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Campaign name..."
            className="bg-transparent text-lg font-semibold text-un1t-white placeholder:text-un1t-mid focus:outline-none w-64"
          />
          <span className="text-xs bg-un1t-gray text-un1t-light px-2 py-0.5 rounded-full">Draft</span>
        </div>

        <div className="flex items-center gap-2">
          {audienceCount !== null && (
            <span className="text-xs text-un1t-light mr-2">
              <Users size={12} className="inline mr-1" />
              {audienceCount} recipients
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white border border-un1t-gray hover:border-un1t-white/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !subject}
            className="flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            <Send size={14} />
            {sending ? 'Sending...' : 'Send Campaign'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-un1t-gray bg-un1t-dark shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'text-un1t-white border-un1t-white'
                : 'text-un1t-light border-transparent hover:text-un1t-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === 'design' && (
          <div className="h-full flex flex-col">
            {/* Visual/Code toggle */}
            <div className="flex items-center gap-2 px-5 py-2 bg-un1t-dark border-b border-un1t-gray">
              <button
                onClick={() => setEditorMode('visual')}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
                  editorMode === 'visual' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'
                }`}
              >
                <Paintbrush size={12} /> Visual Editor
              </button>
              <button
                onClick={async () => {
                  // Export from Unlayer before switching to code
                  if (editorMode === 'visual' && window.unlayer) {
                    const exported = await exportFromUnlayer()
                    setHtmlContent(exported.html)
                    setDesignJson(exported.design)
                  }
                  setEditorMode('code')
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
                  editorMode === 'code' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'
                }`}
              >
                <Code size={12} /> HTML Code
              </button>
            </div>

            {editorMode === 'visual' ? (
              <div id="unlayer-editor" ref={editorRef} className="flex-1" style={{ minHeight: '600px' }} />
            ) : (
              <textarea
                value={htmlContent}
                onChange={e => setHtmlContent(e.target.value)}
                placeholder="Paste or write your HTML email here..."
                className="flex-1 w-full bg-black text-green-400 font-mono text-sm p-5 resize-none focus:outline-none"
                style={{ minHeight: '600px' }}
              />
            )}
          </div>
        )}

        {tab === 'audience' && (
          <div className="p-6 max-w-3xl">
            <h3 className="text-lg font-semibold mb-1">Audience</h3>
            <p className="text-sm text-un1t-light mb-6">
              Define who receives this campaign. Only contacts who have opted in to email marketing will be included.
            </p>
            <AudienceBuilder
              filter={audienceFilter}
              onChange={(f) => {
                setAudienceFilter(f)
                refreshAudienceCount()
              }}
              audienceCount={audienceCount}
            />
          </div>
        )}

        {tab === 'settings' && (
          <div className="p-6 max-w-2xl space-y-6">
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Email Settings</h3>

              <div>
                <label className="block text-sm mb-1.5">Subject Line *</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Your subject line — use {{first_name}} for personalisation"
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                />
              </div>

              <div>
                <label className="block text-sm mb-1.5">Preview Text</label>
                <input
                  type="text"
                  value={previewText}
                  onChange={e => setPreviewText(e.target.value)}
                  placeholder="Short text shown in inbox preview (optional)"
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1.5">From Name</label>
                  <input
                    type="text"
                    value={fromName}
                    onChange={e => setFromName(e.target.value)}
                    placeholder="UN1T"
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1.5">From Email</label>
                  <input
                    type="email"
                    value={fromEmail}
                    onChange={e => setFromEmail(e.target.value)}
                    placeholder="hello@un1t.ie"
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm mb-1.5">Reply-To Email</label>
                <input
                  type="email"
                  value={replyTo}
                  onChange={e => setReplyTo(e.target.value)}
                  placeholder="Same as From if left empty"
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                />
              </div>
            </div>

            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">Merge Tags</h3>
              <p className="text-xs text-un1t-mid mb-3">Use these in your subject line or email body for personalisation:</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  ['{{first_name}}', "Contact's first name"],
                  ['{{name}}', "Contact's full name"],
                  ['{{email}}', "Contact's email"],
                  ['{{location_name}}', 'Your location name'],
                  ['{{unsubscribe_url}}', 'Unsubscribe link'],
                  ['{{preference_url}}', 'Preference centre link'],
                  ['{{current_year}}', 'Current year'],
                ].map(([tag, desc]) => (
                  <div key={tag} className="flex items-center gap-2 p-2 bg-un1t-dark rounded">
                    <code className="text-blue-400">{tag}</code>
                    <span className="text-un1t-mid">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
