'use client'

// APPROVALSQ.6 — a link out of an approvals card. For an item at the studio the
// person is in (and always in "This studio", where items carry no studio) it is
// the plain link it always was. For an item at another studio the page it opens
// would be judged at the WRONG studio, so the control first switches the active
// studio, the way the location switcher does (the one shared cookie write in
// src/lib/active-location.js, then a refresh so server pages re-read it), and
// then navigates. It reads "Switch to <studio> and open".
//
// Only the switching variant calls useRouter, so a card that never shows another
// studio's item needs no router.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui'
import { setActiveLocation } from '@/lib/active-location'

export const needsStudioSwitch = (item, activeStudioId) =>
  !!item?.studioId && item.studioId !== activeStudioId

function SwitchLink({ item, href, className, asButton }) {
  const router = useRouter()
  const label = item.studioName ? `Switch to ${item.studioName} and open` : 'Switch studio and open'
  const go = () => {
    setActiveLocation(item.studioId)
    router.push(href)
    router.refresh()
  }
  if (asButton) {
    return <Button type="button" size="sm" variant="primary" onClick={go}>{label}</Button>
  }
  return (
    <button type="button" onClick={go} className={className || 'underline text-un1t-subtle'}>
      {label}
    </button>
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
