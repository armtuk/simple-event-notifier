import { execFile } from "node:child_process"
import { platform } from "node:process"
import { promisify } from "node:util"
import { describeCause } from "@personal-events/event-model"
import { type NotifierKind, notifierKinds } from "./config.ts"
import type { DesktopNotification } from "./notification-content.ts"

/**
 * Persist: raising the notification on the OS. `toasted-notifier` is a single-maintainer CJS fork,
 * so it lives behind this one interface alongside a dependency-free shell fallback — swapping or
 * dropping it is a change to this file only.
 */

export interface NotifySuccess {
  readonly _tag: "NotifySuccess"
}

export interface NotifyFailure {
  readonly _tag: "NotifyFailure"
  readonly message: string
}

export type NotifyResult = NotifySuccess | NotifyFailure

export interface NotifierAdapter {
  readonly name: string
  readonly notify: (notification: DesktopNotification) => Promise<NotifyResult>
}

export const toastedNotifierAdapter: NotifierAdapter = {
  name: "toasted-notifier",
  notify: async (notification): Promise<NotifyResult> => {
    const { default: notifier } = await import("toasted-notifier")
    return new Promise<NotifyResult>(resolve => {
      notifier.notify({ title: notification.title, message: notification.message, sound: notification.sound }, error =>
        resolve(error === null || error === undefined ? { _tag: "NotifySuccess" } : { _tag: "NotifyFailure", message: error.message })
      )
    })
  }
}

export const shellNotifierAdapter: NotifierAdapter = {
  name: "shell",
  notify: async (notification): Promise<NotifyResult> => {
    const command = shellCommands[platform] ?? unsupportedPlatformCommand
    const { file, args } = command(notification)
    return file === "" ? { _tag: "NotifyFailure", message: `No shell notifier is known for platform "${platform}"` } : run(file, args)
  }
}

const notifierAdapters: Record<Exclude<NotifierKind, "auto">, NotifierAdapter> = {
  toasted: toastedNotifierAdapter,
  shell: shellNotifierAdapter
}

/**
 * `auto` prefers the richer library but must not leave the daemon silent if it is unusable on this
 * machine — and it frequently is: under pnpm the bundled `terminal-notifier` helper arrives without
 * its executable bit, so every call fails `EACCES`. So `auto` degrades to the shell adapter.
 */
export const createNotifier = (kind: NotifierKind): NotifierAdapter =>
  kind === notifierKinds.auto ? fallbackNotifier(toastedNotifierAdapter, shellNotifierAdapter) : notifierAdapters[kind]

/**
 * The fall-through **latches**: whatever makes the primary unusable (a missing executable bit, a
 * quarantined helper) is a property of the machine, not of one notification, so retrying it on
 * every event would burn a failed process spawn per event forever.
 */
export const fallbackNotifier = (primary: NotifierAdapter, secondary: NotifierAdapter): NotifierAdapter => {
  let primaryUsable = true
  return {
    name: `${primary.name}->${secondary.name}`,
    notify: async (notification): Promise<NotifyResult> => {
      if (!primaryUsable) {
        return secondary.notify(notification)
      }
      const result = await primary
        .notify(notification)
        .catch((cause: unknown): NotifyResult => ({ _tag: "NotifyFailure", message: String(cause) }))
      if (result._tag === "NotifySuccess") {
        return result
      }
      primaryUsable = false
      return secondary.notify(notification)
    }
  }
}

interface ShellCommand {
  readonly file: string
  readonly args: string[]
}

/** AppleScript string literals are double-quoted with backslash escapes, which is exactly JSON string syntax. */
const appleScriptCommand = ({ title, message }: DesktopNotification): ShellCommand => ({
  file: "osascript",
  args: ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]
})

const notifySendCommand = ({ title, message }: DesktopNotification): ShellCommand => ({ file: "notify-send", args: [title, message] })

const powerShellCommand = ({ title, message }: DesktopNotification): ShellCommand => ({
  file: "powershell",
  args: [
    "-NoProfile",
    "-Command",
    `[reflection.assembly]::loadwithpartialname('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(10000,${JSON.stringify(title)},${JSON.stringify(message)},'Info')`
  ]
})

const unsupportedPlatformCommand = (): ShellCommand => ({ file: "", args: [] })

const shellCommands: Partial<Record<NodeJS.Platform, (notification: DesktopNotification) => ShellCommand>> = {
  darwin: appleScriptCommand,
  linux: notifySendCommand,
  win32: powerShellCommand
}

const execFileAsync = promisify(execFile)

const run = async (file: string, args: string[]): Promise<NotifyResult> =>
  execFileAsync(file, args)
    .then((): NotifyResult => ({ _tag: "NotifySuccess" }))
    .catch((cause: unknown): NotifyResult => ({ _tag: "NotifyFailure", message: `${file} failed: ${describeCause(cause)}` }))
