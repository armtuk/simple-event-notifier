import { Schema } from "effect"

/**
 * A **trigger** is the thing a mapping rule matches on: the identity of an incoming provider event,
 * reduced to a `channel` tag plus a flat bag of string match-fields.
 *
 * `channel` — not `source` — is the discriminant on purpose. `source` is already the canonical
 * provider identity on an `Event` (`"github"`), and one object carrying two different meanings of
 * "source" is the defect this naming avoids. A channel names *how the event reached us*
 * (`webhook`, `notification`, `events_api`), which is exactly the axis along which two GitHub
 * namespaces must stay non-confusable: a webhook's `event`+`action` and an inbox item's `reason`
 * are different vocabularies that happen to share values.
 *
 * The shape here is deliberately **open** — any string field is allowed — because the framework
 * must host integrations it has never seen. A provider package narrows it to a real
 * `Schema.Union` of literal-tagged structs (see `@personal-events/github`); that union decodes
 * *to* this shape, so a provider gets compile-time non-confusability while the framework keeps a
 * single, provider-agnostic lookup key.
 */

export const TriggerSchema = /*#__PURE__*/ Schema.Struct(
  { channel: Schema.NonEmptyString },
  Schema.Record({ key: Schema.String, value: Schema.String })
).annotations({ identifier: "Trigger" })

export type Trigger = typeof TriggerSchema.Type

export const matchKeyFieldSeparator = "&"

export const matchKeyChannelSeparator = ":"

/**
 * The canonical string a trigger reduces to, so a JSON config rule and a runtime trigger compare
 * identically. Field order is normalised by sorting, because JSON authors write keys in whatever
 * order reads well and a normalizer builds them in whatever order the payload dictates — two
 * spellings of the same trigger must not miss each other. Absent fields are simply absent: a rule
 * that omits `action` and a trigger that omits `action` produce the same key, which is what lets
 * an action-less event (`push`) match a rule written without one.
 *
 * Keys and values are `encodeURIComponent`-escaped before joining, so a value containing the `&`
 * or `=` separators cannot forge a different rule's key. GitHub's values are already free of those,
 * so no existing key changes; the escaping matters for the next provider (Claude Code), whose
 * trigger fields may carry URL-ish or free text. The result stays human-readable for the logged
 * `matchKey` in `TransformError` and the unmapped-event warning.
 */
export const matchKey = (trigger: Trigger): string => {
  const { channel, ...match } = trigger
  const fields = Object.entries(match)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join(matchKeyFieldSeparator)
  return `${encodeURIComponent(channel)}${matchKeyChannelSeparator}${fields}`
}
