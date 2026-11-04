'use client'

// VOICEREPLY.1 — "Mia's voices": which ElevenLabs voice Mia speaks with for
// each kind of voice reply at this studio. Owners and managers edit; everyone
// else who can see the customer agent page reads. Data comes from the guarded
// /api/settings/voice-replies route; samples play in the browser (a WhatsApp
// test only arrives within 24 hours of that number messaging the studio).

import { useEffect, useRef, useState } from 'react'
import { VOICE_KINDS, VOICE_KIND_LABELS } from '@shared/voice-note'

export default function MiaVoicesCard({ canEdit }) {
  const [available, setAvailable] = useState([])
  const [voices, setVoices] = useState({})
  const [aiNotice, setAiNotice] = useState('')
  const [buttonsLine, setButtonsLine] = useState('')
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [message, setMessage] = useState(null)
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState(null)
  const [check, setCheck] = useState(null) // null | 'running' | result

  const audioRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/voice-replies')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j?.success) { setStatus('error'); setMessage(j?.error || 'Could not load the voices.'); return }
        setAvailable(j.data.available || [])
        setVoices(j.data.voices || {})
        setAiNotice(j.data.ai_notice || '')
        setButtonsLine(j.data.buttons_line || '')
        setStatus('ready')
        if (j.warning) setMessage(j.warning)
      })
      .catch(() => { if (!cancelled) { setStatus('error'); setMessage('Could not load the voices.') } })
    return () => { cancelled = true }
  }, [])

  const choose = (kind, voiceId) => {
    const v = available.find((x) => x.voice_id === voiceId)
    setVoices((cur) => ({ ...cur, [kind]: v ? { voice_id: v.voice_id, name: v.name } : null }))
  }

  async function play(kind) {
    const voiceId = voices[kind]?.voice_id
    if (!voiceId) return
    setPlaying(kind)
    setMessage(null)
    try {
      const res = await fetch('/api/settings/voice-replies/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_id: voiceId }),
      })
      if (!res.ok) throw new Error('sample')
      const url = URL.createObjectURL(await res.blob())
      if (audioRef.current) audioRef.current.pause()
      audioRef.current = new Audio(url)
      await audioRef.current.play()
    } catch {
      setMessage('Could not play that sample. Try again.')
    } finally {
      setPlaying(null)
    }
  }

  // Runs the live setup check on the server with the key already in Vercel.
  async function runCheck() {
    setCheck('running')
    try {
      const res = await fetch('/api/settings/voice-replies/check', { method: 'POST' })
      const j = await res.json()
      setCheck(j?.success ? j.data : { error: j?.error || 'The check could not run.' })
    } catch {
      setCheck({ error: 'The check could not run. Try again.' })
    }
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    const body = {
      voices: Object.fromEntries(VOICE_KINDS.map((k) => [k, voices[k]?.voice_id ? { voice_id: voices[k].voice_id, name: voices[k].name } : null])),
      ai_notice: aiNotice.trim() || null,
      buttons_line: buttonsLine.trim() || null,
    }
    try {
      const res = await fetch('/api/settings/voice-replies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      setMessage(j?.success ? 'Voices saved.' : (j?.error || 'Could not save the voices.'))
    } catch {
      setMessage('Could not save the voices. Try again.')
    }
    setSaving(false)
  }

  return (
    <form onSubmit={save} className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mt-6 max-w-2xl">
      <div className="text-sm font-medium mb-1">Mia&rsquo;s voices</div>
      <p className="text-xs text-un1t-subtle mb-4">
        When a customer sends a voice note, Mia replies with one. Pick the voice she uses for each kind of reply.
        A kind with no voice uses the default; with no default, she replies in text. Voice replies are switched on
        for the organisation on the usage settings page.
      </p>
      {message && <p className="text-sm text-un1t-text mb-3">{message}</p>}
      {status === 'loading' && <p className="text-sm text-un1t-subtle">Loading voices…</p>}
      <div className="space-y-3">
        {VOICE_KINDS.map((kind) => (
          <div key={kind} className="flex items-end gap-2">
            <label htmlFor={`voice-${kind}`} className="block text-sm flex-1">
              <span className="text-un1t-text">{VOICE_KIND_LABELS[kind]}</span>
              <select
                id={`voice-${kind}`}
                value={voices[kind]?.voice_id || ''}
                onChange={(e) => choose(kind, e.target.value)}
                disabled={!canEdit || status !== 'ready'}
                className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">{kind === 'default' ? 'No voice (reply in text)' : 'Use the default voice'}</option>
                {available.map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name}</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={() => play(kind)}
              disabled={!voices[kind]?.voice_id || playing !== null}
              aria-label={`Play sample for ${VOICE_KIND_LABELS[kind]}`}
              className="text-sm border border-un1t-border rounded-lg px-3 py-2 disabled:opacity-50"
            >
              {playing === kind ? 'Playing…' : 'Play sample'}
            </button>
          </div>
        ))}
      </div>
      <label htmlFor="voice-buttons-line" className="block text-sm mt-4">
        <span className="text-un1t-text">Text above the buttons</span>
        <input
          id="voice-buttons-line"
          value={buttonsLine}
          onChange={(e) => setButtonsLine(e.target.value)}
          placeholder="Tap an option:"
          disabled={!canEdit}
          maxLength={80}
          className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
        />
      </label>
      <label htmlFor="voice-ai-notice" className="block text-sm mt-3">
        <span className="text-un1t-text">Notice after the first voice reply</span>
        <input
          id="voice-ai-notice"
          value={aiNotice}
          onChange={(e) => setAiNotice(e.target.value)}
          placeholder="Empty: no notice is sent"
          disabled={!canEdit}
          maxLength={300}
          className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
        />
      </label>
      {canEdit && (
        <div className="mt-4 border-t border-un1t-border pt-4">
          <button
            type="button"
            onClick={runCheck}
            disabled={check === 'running'}
            className="text-sm border border-un1t-border rounded-lg px-3 py-2 disabled:opacity-50"
          >
            {check === 'running' ? 'Checking…' : 'Check voice setup'}
          </button>
          {check && check !== 'running' && <CheckResult result={check} />}
        </div>
      )}
      {canEdit && (
        <button
          type="submit"
          disabled={saving || status !== 'ready'}
          className="mt-4 bg-un1t-text text-un1t-bg text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save voices'}
        </button>
      )}
    </form>
  )
}

function CheckResult({ result }) {
  if (result.error) return <p className="text-sm text-un1t-text mt-2">{result.error}</p>
  const lines = [`Key: ${result.key ? 'found' : 'not set in Vercel'}`]
  if (result.key) lines.push(result.voices?.ok ? `Voices: ${result.voices.count} on the account (tested with ${result.voices.tested})` : 'Voices: could not read the ElevenLabs voice list')
  for (const m of result.models || []) {
    lines.push(m.accepted
      ? `${m.model}: accepted · ${m.ogg ? 'WhatsApp voice-note format (Ogg)' : 'not in WhatsApp voice-note format'}`
      : `${m.model}: refused${m.status ? ` (HTTP ${m.status})` : ''}`)
  }
  return (
    <div className="mt-2 text-sm">
      {lines.map((l) => <p key={l} className="text-un1t-text">{l}</p>)}
      <p className="text-xs text-un1t-subtle mt-1">
        {result.ready
          ? `Ready: voice replies use ${result.inUse}.`
          : `Not ready: voice replies use ${result.inUse}, which needs to be accepted and in Ogg. Until then Mia replies in text.`}
      </p>
    </div>
  )
}
