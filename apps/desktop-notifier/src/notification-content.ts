import type { Event } from "@personal-events/event-model"

/**
 * Compute: the pure derivation of what the user actually sees. It takes only the event — no
 * client, no config, no ambient state — so the wording is unit-testable without S3 or the OS.
 */

export interface DesktopNotification {
  readonly title: string
  readonly message: string
  readonly sound: boolean
}

const eventTypeLabels = { alert: "Alert", notification: "Notification" } as const

/** An alert is the class of event that needs attention, so only alerts make a sound. */
const eventTypeSounds = { alert: true, notification: false } as const

export const toNotification = (event: Event): DesktopNotification => ({
  title: `${eventTypeLabels[event.eventType]} p${event.priority} · ${event.source}`,
  message: toMessage(event),
  sound: eventTypeSounds[event.eventType]
})

const toMessage = (event: Event): string => (event.workItem === undefined ? event.name : `${event.name}\n${event.workItem}`)
