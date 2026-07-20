import { platform } from "node:process"
import { describe, expect, it } from "vitest"
import { notifierKinds } from "./config.ts"
import type { DesktopNotification } from "./notification-content.ts"
import { createNotifier, fallbackNotifier, type NotifierAdapter, type NotifyResult, shellNotifierAdapter } from "./notify.ts"

const notification: DesktopNotification = { title: "Alert p5 · github", message: 'a "quoted" title\nand a newline', sound: true }

const stubAdapter = (name: string, result: NotifyResult, calls: string[]): NotifierAdapter => ({
  name,
  notify: async (): Promise<NotifyResult> => {
    calls.push(name)
    return result
  }
})

const throwingAdapter = (name: string, calls: string[]): NotifierAdapter => ({
  name,
  notify: async (): Promise<NotifyResult> => {
    calls.push(name)
    throw new Error("the platform helper is quarantined")
  }
})

describe("createNotifier", () => {
  it.each([notifierKinds.toasted, notifierKinds.shell])("returns a single adapter for the %s kind", kind => {
    expect(createNotifier(kind).name).not.toContain("->")
  })

  it("chains a fallback for the auto kind so a broken library does not leave the daemon silent", () => {
    expect(createNotifier(notifierKinds.auto).name).toBe("toasted-notifier->shell")
  })
})

describe("fallbackNotifier", () => {
  it("does not touch the secondary when the primary succeeds", async () => {
    const calls: string[] = []
    const result = await fallbackNotifier(
      stubAdapter("primary", { _tag: "NotifySuccess" }, calls),
      stubAdapter("secondary", { _tag: "NotifySuccess" }, calls)
    ).notify(notification)
    expect(result._tag).toBe("NotifySuccess")
    expect(calls).toStrictEqual(["primary"])
  })

  it("falls through when the primary reports a failure", async () => {
    const calls: string[] = []
    await fallbackNotifier(
      stubAdapter("primary", { _tag: "NotifyFailure", message: "no" }, calls),
      stubAdapter("secondary", { _tag: "NotifySuccess" }, calls)
    ).notify(notification)
    expect(calls).toStrictEqual(["primary", "secondary"])
  })

  it("falls through when the primary throws rather than returning a failure", async () => {
    const calls: string[] = []
    const result = await fallbackNotifier(
      throwingAdapter("primary", calls),
      stubAdapter("secondary", { _tag: "NotifySuccess" }, calls)
    ).notify(notification)
    expect(result._tag).toBe("NotifySuccess")
    expect(calls).toStrictEqual(["primary", "secondary"])
  })

  it("latches after the primary fails once, rather than retrying it for every later event", async () => {
    const calls: string[] = []
    const notifier = fallbackNotifier(
      stubAdapter("primary", { _tag: "NotifyFailure", message: "no" }, calls),
      stubAdapter("secondary", { _tag: "NotifySuccess" }, calls)
    )
    await notifier.notify(notification)
    await notifier.notify(notification)
    expect(calls).toStrictEqual(["primary", "secondary", "secondary"])
  })

  it("surfaces the secondary's failure when both fail", async () => {
    const calls: string[] = []
    const result = await fallbackNotifier(
      throwingAdapter("primary", calls),
      stubAdapter("secondary", { _tag: "NotifyFailure", message: "also no" }, calls)
    ).notify(notification)
    expect(result).toStrictEqual({ _tag: "NotifyFailure", message: "also no" })
  })
})

describe("shellNotifierAdapter", () => {
  it.runIf(platform === "darwin")("raises a real macOS notification through osascript, quoting safely", async () => {
    const result = await shellNotifierAdapter.notify(notification)
    expect(result).toStrictEqual({ _tag: "NotifySuccess" })
  })

  it.skipIf(platform === "darwin" || platform === "linux" || platform === "win32")(
    "reports a clear failure on an unsupported platform",
    async () => {
      const result = await shellNotifierAdapter.notify(notification)
      expect(result._tag).toBe("NotifyFailure")
    }
  )
})
