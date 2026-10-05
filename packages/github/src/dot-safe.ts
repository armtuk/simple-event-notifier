/**
 * `.` is a structural delimiter of the S3 object key, so any provider value that becomes an event's
 * `source` or `name` must lose its dots before it gets there — `github.com` → `github-com`. The
 * event-model rejects a dotted segment outright, which is the right behaviour for a contract but a
 * useless one for a normalizer staring at a real repository name.
 *
 * Whitespace is folded for the same reason at one remove: a key containing a space is legal in S3
 * but miserable to handle in a URL, a shell, or a log line.
 */

const unsafeSegmentPattern = /[.\s]+/g

export const dotSafeReplacement = "-"

export const toDotSafe = (value: string): string => value.trim().replace(unsafeSegmentPattern, dotSafeReplacement)
