'use client'

// APPROVALSQ.6 — a link out of an approvals card. For an item at the studio the
// person is in (and always in "This studio", where items carry no studio) it is
// the plain link it always was. For an item at another studio the page it opens
// would be judged at the WRONG studio, so the control first switches the active
// studio, the way the location switcher does (the one shared cookie write in
// src/lib/active-location.js, then a refresh so server pages re-read it), and
// then navigates. It reads "Switch to <studio> and open".
//
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'
import { setActiveLocation, ACTIVE_LOCATION_COOKIE } from '@/lib/active-location'

export const needsStudioSwitch = (item, activeStudioId) =>
  !!item?.studioId && item.studioId !== activeStudioId

function SwitchLink({ item, href, className, asButton }) {
  const [failed, setFailed] = useState(false)
  const label = item.studioName ? `Switch to ${item.studioName} and open` : 'Switch studio and open'
  const go = () => {
    let written = false
    try {
      setActiveLocation(item.studioId)
      // The write counts only if the browser kept it.
      written = document.cookie.split('; ').includes(`${ACTIVE_LOCATION_COOKIE}=${item.studioId}`)
    } catch { written = false }
    if (!written) { setFailed(true); return }
    setFailed(false)
    window.location.assign(href)
  }
  const problem = failed && <span role="alert" className="text-xs text-red-700">Could not switch studio.</span>
  if (asButton) {
    return (
      <>
        <Button type="button" size="sm" variant="primary" onClick={go}>{label}</Button>
        {problem}
      </>
    )
  }
  return (
    <>
      <button type="button" onClick={go} className={className || 'underline text-un1t-subtle'}>
        {label}
      </button>
      {problem}
    </>
  )
}

// `asButton` is the primary Open button of a link-only card; otherwise a text link.
export default function StudioLink({ item, activeStudioId, href, className, asButton = false, children }) {
  if (needsStudioSwitch(item, activeStudioId)) {
    return <SwitchLink item={item} href={href} className={className} asButton={asButton} />
  }
  if (asButton) return <Button as={Link} href={href} size="sm" variant="primary">{children}</Button>
  return <Link href={href} className={className}>{children}</Link>
}
