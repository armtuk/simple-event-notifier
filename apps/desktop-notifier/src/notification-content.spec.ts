import { describe, expect, it } from "vitest"
import { toNotification } from "./notification-content.ts"
import { readExemplarEvent } from "./testing/exemplars.ts"

describe("toNotification", () => {
  it("puts the attention class, priority and source in the title of an alert", () => {
    const notification = toNotification(readExemplarEvent("valid-github-pull-request.json"))
    expect(notification.title).toBe("Alert p5 · github")
  })

  it("puts the event name and the work-item link in the body when there is one", () => {
    const notification = toNotification(readExemplarEvent("valid-github-pull-request.json"))
    expect(notification.message).toBe("new-pull-request\nhttps://www.jira.com/browse/AWE-150")
  })

  it("omits the work-item line entirely when the event has none", () => {
    const notification = toNotification(readExemplarEvent("valid-agent-notification.json"))
    expect(notification.message).toBe("prompt-complete")
    expect(notification.message).not.toContain("\n")
  })

  it("sounds for an alert, which is the class that needs attention", () => {
    expect(toNotification(readExemplarEvent("valid-github-pull-request.json")).sound).toBe(true)
  })

  it("stays silent for a notification, which is informational", () => {
    const notification = toNotification(readExemplarEvent("valid-agent-notification.json"))
    expect(notification.sound).toBe(false)
    expect(notification.title).toBe("Notification p8 · claude-code")
  })
})
