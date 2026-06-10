import { createTransport, buildSdk } from './create-sdk.js'
import { meDomain } from './me.js'

// Register every domain here. Each is a factory (request) => methods.
// Wave plans add staff, contacts, etc. alongside `me`.
const DOMAINS = {
  me: meDomain,
}

export { createTransport, buildSdk }

export function createSdk(transportOpts) {
  return buildSdk(createTransport(transportOpts), DOMAINS)
}
