// W1.M1 — the provider for a location with NO membership source: a lead CRM
// (pipeline, comms, events) with nothing behind "memberships". Every
// capability is off, so a surface that asks the seam renders its
// "no membership source connected" state instead of empty Glofox-shaped data.
export const noneSource = Object.freeze({
  key: 'none',
  label: 'No membership source',
  capabilities: Object.freeze({ memberships: false, bookings: false, credits: false, invoices: false, schedule: false }),
  async isConfigured() {
    return { configured: false }
  },
})
