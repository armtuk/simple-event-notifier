/**
 * Turns an arbitrary thrown value into a line an operator can read. This lives in the event-model
 * package because it already owns rendering failures as messages, and because every consumer needs
 * the same rendering — if it ever grows (unwrap `cause.cause`, include `error.name`, truncate a
 * huge body) it must grow in exactly one place.
 */
export const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
