'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowLeft, Save, Code, Paintbrush } from 'lucide-react'
import Link from 'next/link'
import { UNLAYER_MERGE_TAGS } from '@/lib/merge-tags'

export default function TemplateEditor({ template, locationId, userId }) {
  const editorRef = useRef(null)

  const [name, setName] = useState(template?.name || '')
  const [description, setDescription] = useState(template?.description || '')
  const [category, setCategory] = useState(template?.category || 'general')
  const [htmlContent, setHtmlContent] = useState(template?.html_content || '')
  const [designJson, setDesignJson] = useState(template?.design_json || null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [templateId, setTemplateId] = useState(template?.id || null)
  const [editorMode, setEditorMode] = useState('visual')
  const [unlayerLoaded, setUnlayerLoaded] = useState(false)

  // Load Unlayer
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

  // Init Unlayer
  useEffect(() => {
    if (unlayerLoaded && editorMode === 'visual' && editorRef.current) {
      editorRef.current.innerHTML = ''
      window.unlayer.init({
        id: 'unlayer-template-editor',
        displayMode: 'email',
        appearance: {
          theme: 'dark',
          panels: { tools: { dock: 'left' } },
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
        // K3 — from @/lib/merge-tags, which is checked against what
        // applyMergeTags() actually substitutes. Do not re-inline this list:
        // this copy had drifted five tags behind the substitution table.
        mergeTags: [...UNLAYER_MERGE_TAGS],
      })

      if (designJson) {
        window.unlayer.loadDesign(designJson)
      }
    }
    // designJson is intentionally NOT a dep — re-loading it after the
    // user starts editing would clobber their in-progress changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlayerLoaded, editorMode])

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
        name: name || 'Untitled Template',
        description,
        category,
        design_json: design,
        html_content: html,
        location_id: locationId,
        created_by: userId,
      }

      let result
      if (templateId) {
        result = await fetch(`/api/templates/${templateId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json())
      } else {
        result = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json())
      }

      if (!result.success) throw new Error(result.error)

      if (!templateId && result.template?.id) {
        setTemplateId(result.template.id)
        window.history.replaceState(null, '', `/communications/templates/email/${result.template.id}`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const categories = ['general', 'promotion', 'newsletter', 'event', 'transactional', 'welcome', 'sequence']

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-border bg-un1t-surface shrink-0">
        <div className="flex items-center gap-4">
          {/* COMMSLAYOUT.4 — was `/email/templates`, a stub that redirects to
              this same URL. The editor is opened from /communications/templates,
              so link straight there with the channel filter it arrived on. */}
          <Link href="/communications/templates?channel=email" className="text-un1t-subtle hover:text-un1t-text transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Template name..."
            className="bg-transparent text-lg font-semibold text-un1t-text placeholder:text-un1t-muted focus:outline-none w-64"
          />
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="bg-un1t-border text-xs text-un1t-subtle px-2 py-1 rounded-md border-0 focus:outline-none"
          >
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? 'Saving...' : 'Save Template'}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-700 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {/* Description */}
      <div className="px-5 py-2 border-b border-un1t-border bg-un1t-surface">
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Template description (optional)..."
          className="bg-transparent text-sm text-un1t-subtle placeholder:text-un1t-muted focus:outline-none w-full"
        />
      </div>

      {/* Visual/Code toggle */}
      <div className="flex items-center gap-2 px-5 py-2 bg-un1t-surface border-b border-un1t-border">
        <button
          type="button"
          onClick={() => setEditorMode('visual')}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
            editorMode === 'visual' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          <Paintbrush size={12} /> Visual Editor
        </button>
        <button
          type="button"
          onClick={async () => {
            if (editorMode === 'visual' && window.unlayer) {
              const exported = await exportFromUnlayer()
              setHtmlContent(exported.html)
              setDesignJson(exported.design)
            }
            setEditorMode('code')
          }}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
            editorMode === 'code' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
          }`}
        >
          <Code size={12} /> HTML Code
        </button>
      </div>

      {/* Editor */}
      <div className="flex-1">
        {editorMode === 'visual' ? (
          // UNLAYER-H.1 — definite height required (see CampaignEditor): the
          // embed's iframe is `height: 100%`, and h-full resolves through an
          // indefinite ancestor chain, so the iframe collapsed to 150px.
          <div id="unlayer-template-editor" ref={editorRef} style={{ height: '75vh', minHeight: '600px' }} />
        ) : (
          <textarea
            value={htmlContent}
            onChange={e => setHtmlContent(e.target.value)}
            placeholder="Paste or write your HTML email here..."
            className="w-full h-full bg-black text-green-400 font-mono text-sm p-5 resize-none focus:outline-none"
            style={{ minHeight: '600px' }}
          />
        )}
      </div>
    </div>
  )
}
