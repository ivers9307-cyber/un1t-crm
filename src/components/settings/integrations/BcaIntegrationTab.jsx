'use client'

// BCA Submit integration tab. Wraps the existing BcaSubmitSettings
// component (originally rendered on the standalone /settings/locations/
// [id]/bca page that we're deleting as part of SETTINGS.1). The form,
// validator, live preview etc. are unchanged — just embedded in the
// tabbed Integrations container now.

import { getBcaConfig, DEFAULT_BCA_CONFIG } from '@/lib/bca'
import BcaSubmitSettings from '@/components/settings/BcaSubmitSettings'

export default function BcaIntegrationTab({ location, canEdit, sampleCar }) {
  // BcaSubmitSettings expects an already-merged config. The page-level
  // server fetch passes the raw location; we materialise the config
  // here so the inner component doesn't need to know about defaults.
  const initialConfig = getBcaConfig(location) || { ...DEFAULT_BCA_CONFIG }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-light">
        Only a master account can edit BCA Submit configuration. View-only mode is not implemented yet.
      </div>
    )
  }

  return (
    <BcaSubmitSettings
      location={location}
      initialConfig={initialConfig}
      sampleCar={sampleCar || null}
    />
  )
}
