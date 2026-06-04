// Save the signed-in user's bottom-bar arrangement for a location.
import { api } from './api'

export function saveBarLayout(locationId, bar) {
  return api('/api/mobile/layout', { method: 'PUT', locationId, body: { location_id: locationId, bar } })
}
