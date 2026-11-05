'use client'

// MIASETTINGS.2c — Member app: settings the member app reads, stored and
// saved with Mia's but not Mia's own. Studio-only (champ-app reads this
// studio's own value).

import { CARD } from './field-renderer'

export default function MemberAppSection({ renderField, canEdit }) {
  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      <section className={`space-y-5 ${CARD}`}>
        {renderField('monthly_points_target')}
        {renderField('social_enabled')}
        {renderField('membership_cta_label')}
      </section>
    </fieldset>
  )
}
