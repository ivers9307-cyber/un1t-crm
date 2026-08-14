// K5 anti-vacuity fixture — this IS the retired /cars redirect stub,
// moved here verbatim when PRUNE.1 deleted every real stub page, so
// command-palette.test.js can still prove isRedirectStub() recognises
// the shape. Never imported by app code.

import { redirect } from 'next/navigation'

export default function CarsIndex() {
  redirect('/cars/active')
}
