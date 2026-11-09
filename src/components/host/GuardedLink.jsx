'use client'

// next/link that asks before leaving a page with unsaved changes
// (HOSTPORTAL.2). Same props as Link; `ref` arrives as an ordinary prop
// (React 19) and goes straight to the link. The caller's onClick runs only
// once the guard allows the navigation. A click that will not leave this page
// (a modifier or non-primary click, or a target=_blank link) never prompts.

import Link from 'next/link'
import { confirmLeave } from '@/lib/unsaved-guard'

function staysOnPage(event, target) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 || target === '_blank'
}

export default function GuardedLink({ onClick, ...props }) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        if (!staysOnPage(event, props.target) && !confirmLeave()) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
    />
  )
}
