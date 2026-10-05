/**
 * Hand-written shim for `toasted-notifier`, which ships CJS with no bundled types. It is a
 * single-maintainer fork, so only the small surface this app actually uses is declared — the
 * `notify(options, callback)` call on the default export. Everything else about the library is
 * confined to `src/notify.ts`, so replacing it is a two-file change.
 */
declare module "toasted-notifier" {
  interface NotifyOptions {
    title?: string
    message?: string
    subtitle?: string
    sound?: boolean | string
    wait?: boolean
    timeout?: number
    icon?: string
  }

  interface Notifier {
    notify(options: NotifyOptions, callback?: (error: Error | null, response?: string) => void): Notifier
  }

  const notifier: Notifier
  export default notifier
  export type { NotifyOptions }
}
