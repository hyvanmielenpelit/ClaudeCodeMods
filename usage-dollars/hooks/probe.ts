/* The check message: a real turn sent from the first-reading card, only when the person
   presses its button, since only a main-conversation reply brings a usage reading in a
   headless session. Pure: register.tsx sends it and keeps the in-flight flag. */

import type { WaitingReport } from '../types'

/* Says what it is in the transcript, and keeps the turn as short as the session's model
   allows. Carries nothing from the session. */
export const CHECK_PROMPT =
  'usage-dollars check: this message only fetches a usage reading. Reply with the single word OK. Do not use any tools.'

export const CHECK_LABEL = 'Send a short check message (uses one turn)'

/** The first-reading card for `command`: a subscription with no check in flight may send
    one; a sign-in without a subscription never gets a reading to wait for. */
export function waitingReport(command: string, subscription: string, isCheckInFlight: boolean): WaitingReport {
  if (subscription === 'none') return { type: 'waiting', command, canSend: false, isUnsubscribed: true }
  return { type: 'waiting', command, canSend: !isCheckInFlight }
}
