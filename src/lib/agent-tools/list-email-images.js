// MCPEMAIL.1 — `list_email_images`: images a campaign at this studio may use.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { defineTool } from './registry.js'
import { emailGate, studioImages, LIST_CAP } from './_email-campaign.js'

export default defineTool({
  name: 'list_email_images',
  title: 'Email images',
  description: 'Lists the studio\'s image library (url, name), newest first, up to 50. '
    + 'Use it to pick the image URLs an email campaign body may contain.',
  inputSchema: z.object({
    studio_id: uuidLike.optional().describe('A studio id; omit for the default studio.'),
  }),
  gate: (user, studioId) => emailGate(user, studioId),
  run: async (_input, ctx) => {
    const { db, user, studio } = ctx
    const images = await studioImages(db, user, studio)
    return {
      images: images.slice(0, LIST_CAP).map((i) => ({ url: i.url, name: i.name })),
      capped: images.length > LIST_CAP,
    }
  },
})
