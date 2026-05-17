import { NextResponse } from 'next/server'
import { sendBroadcast } from '@/lib/whatsapp'

// POST /api/whatsapp/broadcasts/[id]/send
export async function POST(request, props) {
  const params = await props.params;
  try {
    const result = await sendBroadcast(params.id)
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('Broadcast send error:', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 400 }
    )
  }
}
