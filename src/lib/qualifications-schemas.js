// src/lib/qualifications-schemas.js
//
// QUALS.1 — request bodies for the qualification routes. Zod only, no IO, so
// src/lib/openapi.js can import them without pulling in the data layer.
// Plain schemas, no transforms (zod v4 + zod-to-openapi): trimming a note and
// turning '' into null happen in src/lib/qualifications-server.js.

import { z } from 'zod'
import { uuidLike, realIsoDate } from './schemas'

export const MAX_TEMPLATE_REQUIREMENTS = 5
export const QUALIFICATION_NOTE_MAX = 300
export const QUALIFICATION_TYPE_NAME_MAX = 60

const DateOrNull = realIsoDate.nullable().optional()
const Note = z.string().max(QUALIFICATION_NOTE_MAX, 'A note is at most 300 characters').nullable().optional()
const datesInOrder = (v) => !v.issued_on || !v.expires_on || v.expires_on >= v.issued_on
const DATES_ORDER = { message: 'The expiry date is before the issue date', path: ['expires_on'] }
const TypeName = z.string().trim()
  .min(1, 'Give the qualification a name')
  .max(QUALIFICATION_TYPE_NAME_MAX, 'At most 60 characters')
  .refine((s) => !/[\r\n]/.test(s), 'One line only')

// expires_on null (or absent) = the qualification does not expire (plan
// decision 3). The page's form sends null only when "Does not expire" is ticked.
export const QualificationRecordCreateSchema = z.object({
  profile_id: uuidLike,
  qualification_type_id: uuidLike,
  issued_on: DateOrNull,
  expires_on: DateOrNull,
  note: Note,
}).refine(datesInOrder, DATES_ORDER)

// The type and the person are fixed: to change them, delete and record again.
export const QualificationRecordPatchSchema = z.object({
  issued_on: DateOrNull,
  expires_on: DateOrNull,
  note: Note,
}).refine((v) => v.issued_on !== undefined || v.expires_on !== undefined || v.note !== undefined, { message: 'Nothing to change' })
  .refine(datesInOrder, DATES_ORDER)

export const QualificationTypeCreateSchema = z.object({
  location_id: uuidLike, // the studio the owner is acting from; its organisation owns the type
  name: TypeName,
})

export const QualificationTypePatchSchema = z.object({
  name: TypeName.optional(),
  active: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.active !== undefined, { message: 'Nothing to change' })

export const TemplateQualificationsPutSchema = z.object({
  template_id: uuidLike,
  // The cap counts DISTINCT types (the data layer de-duplicates); a raw
  // ceiling still bounds the body.
  qualification_type_ids: z.array(uuidLike)
    .max(50, 'Too many entries')
    .refine((ids) => new Set(ids).size <= MAX_TEMPLATE_REQUIREMENTS, 'At most 5 qualifications'),
})
