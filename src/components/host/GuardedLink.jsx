'use client'

// next/link that asks before leaving a page with unsaved changes
// (HOSTPORTAL.2). Same props as Link; `ref` arrives as an ordinary prop
// (React 19) and goes straight to the link. The caller's onClick runs only
// once the guard allows the navigation.

import Link from 'next/link'
import { confirmLeave } from '@/lib/unsaved-guard'

export default function GuardedLink({ onClick, ...props }) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        if (!confirmLeave()) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
    />
  )
}
