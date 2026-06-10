import { createTransport, buildSdk } from './create-sdk.js'
import { meDomain } from './me.js'
import { staffDomain } from './staff.js'

// Register every domain here. Each is a factory (request) => methods.
// Wave plans add staff, contacts, etc. alongside `me`.
const DOMAINS = {
  me: meDomain,
  staff: staffDomain,
}

export { createTransport, buildSdk }

export function createSdk(transportOpts) {
  return buildSdk(createTransport(transportOpts), DOMAINS)
}
