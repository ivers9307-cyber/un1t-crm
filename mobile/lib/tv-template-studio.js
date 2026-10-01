// C118 TVTEMPLATESTUDIO.1 — which studio the phone's template editor works at.
//
// The editor used to upload a new base image at the ACTIVE studio even while
// editing another studio's template (an owner at two studios, or a studio
// switch with the editor open), so the image landed in the wrong studio's
// tv-content folder. Since MEMBERWRITESWEEP.1f the save route refuses a new
// base image outside the template's own studio folder, so the editor must
// upload where the template lives.
//
// Pure: no React Native import, so it runs under vitest.

/**
 * @param {object} p
 * @param {boolean} p.isNew                 creating (no template id yet)
 * @param {string|null} [p.templateLocationId]  an existing template's own studio, once loaded
 * @param {string|null} [p.openedAtLocationId]  the active studio when the editor opened
 * @param {string|null} [p.activeLocationId]    the active studio now
 * @returns {string|null} the studio to upload and create at; null = not known
 *   yet (an existing template still loading), so do not upload.
 */
export function templateStudioId({ isNew, templateLocationId = null, openedAtLocationId = null, activeLocationId = null } = {}) {
  // An existing template lives where it lives; never guess the active studio.
  if (!isNew) return templateLocationId || null
  // A new template stays at the studio it was started at, so a studio switch
  // mid-edit cannot split its image from its row.
  return openedAtLocationId || activeLocationId || null
}
