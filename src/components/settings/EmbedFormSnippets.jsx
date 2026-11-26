'use client'

// EMBEDFORM.1 — the code to paste into a website or Linktree for each studio's
// sign-up form (/embed/lead/<studio page slug>). Shown on Settings → Landing
// pages. Copy only: nothing here writes.

import { useState } from 'react'

export function embedSnippet(baseUrl, slug) {
  return `<iframe src="${baseUrl}/embed/lead/${slug}" title="Sign up" style="width:100%;max-width:480px;height:520px;border:0" loading="lazy"></iframe>`
}

function Row({ name, snippet, url }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard blocked */ }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-un1t-text">{name}</p>
        <div className="flex items-center gap-3 text-xs">
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline text-un1t-subtle hover:text-un1t-text">Preview</a>
          <button type="button" onClick={copy} className="rounded-md border border-un1t-border px-2 py-1 text-un1t-text hover:border-un1t-text/30">
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
      </div>
      <pre className="text-[11px] bg-un1t-bg border border-un1t-border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all">{snippet}</pre>
    </div>
  )
}

export default function EmbedFormSnippets({ forms }) {
  if (!forms?.length) return null
  return (
    <section className="mt-8 bg-un1t-surface border border-un1t-border rounded-2xl p-5 max-w-3xl">
      <h3 className="text-sm font-semibold text-un1t-text mb-1">Website sign-up form</h3>
      <p className="text-xs text-un1t-subtle mb-4">
        Paste this code into your website, Linktree or any page builder that accepts an embed. People who sign up
        join the studio&apos;s list and pipeline like the landing page form, with the marketing box ticked by default.
      </p>
      <div className="space-y-4">
        {forms.map((f) => <Row key={f.slug} name={f.name} snippet={embedSnippet(f.baseUrl, f.slug)} url={`${f.baseUrl}/embed/lead/${f.slug}`} />)}
      </div>
    </section>
  )
}
