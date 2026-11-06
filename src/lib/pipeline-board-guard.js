// PIPEBUILD.2 — boards with no board_type are built in code (acquisition,
// paid_trial, programmes…) and must not be edited through the builder routes.
import { NextResponse } from 'next/server'

export function assertNotLegacyBoard(board) {
  if (board?.board_type == null) {
    return NextResponse.json(
      { success: false, error: "This board is built in code and can't be changed here." },
      { status: 409 },
    )
  }
  return null
}
