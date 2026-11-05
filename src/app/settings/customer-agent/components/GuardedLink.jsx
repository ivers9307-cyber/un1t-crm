'use client'

// MIASETTINGS.2d — a link that leaves the Mia settings page. While the page
// holds unsaved changes it asks first, and a "Cancel" keeps the person here.

import Link from 'next/link'

export default function GuardedLink({ href, dirty = false, onClick, children, ...rest }) {
  return (
    <Link href={href} {...rest}
      onClick={(e) => {
        if (dirty && !window.confirm('Discard your unsaved changes?')) { e.preventDefault(); return }
        onClick?.(e)
      }}>
      {children}
    </Link>
  )
}
