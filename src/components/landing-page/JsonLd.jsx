'use client'

// JsonLd — inserts a schema.org JSON-LD <script> via the DOM rather
// than rendering inline HTML. Setting `script.text` assigns raw text
// with no HTML parsing context, so a `</script>` sequence inside
// operator-entered strings can never break out — safe by
// construction, no sanitiser needed. Googlebot renders JS and picks
// up DOM-inserted JSON-LD (documented behaviour), which is all this
// exists for.

import { useEffect } from 'react'

export default function JsonLd({ data }) {
  useEffect(() => {
    if (!data) return undefined
    let el
    try {
      el = document.createElement('script')
      el.type = 'application/ld+json'
      el.text = JSON.stringify(data)
      document.head.appendChild(el)
    } catch {
      return undefined
    }
    return () => {
      try {
        if (el && el.parentNode) el.parentNode.removeChild(el)
      } catch {
        /* unmount race — nothing to clean */
      }
    }
  }, [data])

  return null
}
