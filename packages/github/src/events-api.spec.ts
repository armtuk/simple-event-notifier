import { classify, matchKey } from "@personal-events/integration-core"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { decodeEventsApiItem, eventsApiActionOf, eventsApiWorkItemOf } from "./events-api.ts"
import { buildEventsApiTrigger } from "./github-trigger.ts"
import { loadGithubConfig } from "./mapping.ts"
import { githubEventsApiToEvent, normalizeEventsApi } from "./normalizer.ts"
import { readGithubExemplar } from "./testing/exemplars.ts"

const compiled = Either.getOrThrow(loadGithubConfig())
const toEvent = githubEventsApiToEvent(compiled)

describe("EventsApiItemSchema over captured activity items", () => {
  it.for([["events-api-pull_request-opened.json"], ["events-api-push.json"], ["events-api-unmapped-watch.json"]])(
    "accepts %s",
    ([fileName]) => {
      expect(Either.isRight(decodeEventsApiItem(readGithubExemplar(fileName as string)))).toBe(true)
    }
  )

  it("rejects an item with no repo, rather than emitting an event that cannot say where it happened", () => {
    expect(Either.isLeft(decodeEventsApiItem(readGithubExemplar("invalid-events-api-missing-repo.json")))).toBe(true)
  })

  it("reads the action from one level down in payload", () => {
    const item = Either.getOrThrow(decodeEventsApiItem(readGithubExemplar("events-api-pull_request-opened.json")))
    expect(eventsApiActionOf(item)).toBe("opened")
  })

  it("reports a PushEvent as action-less, because its payload has none", () => {
    const item = Either.getOrThrow(decodeEventsApiItem(readGithubExemplar("events-api-push.json")))
    expect(eventsApiActionOf(item)).toBeUndefined()
  })

  it("extracts the pull request link as the work item", () => {
    const item = Either.getOrThrow(decodeEventsApiItem(readGithubExemplar("events-api-pull_request-opened.json")))
    expect(eventsApiWorkItemOf(item)).toBe("https://github.com/fifthdimensionengineering/aws-work-eventer/pull/42")
  })

  it("reports no work item when the payload carries no addressable resource", () => {
    const item = Either.getOrThrow(decodeEventsApiItem(readGithubExemplar("events-api-push.json")))
    expect(eventsApiWorkItemOf(item)).toBeUndefined()
  })
})

describe("normalizeEventsApi", () => {
  it("uses the events_api channel, so its vocabulary cannot match a webhook rule", () => {
    const normalized = Either.getOrThrow(normalizeEventsApi(readGithubExemplar("events-api-pull_request-opened.json")))
    expect(normalized.trigger).toStrictEqual({ channel: "events_api", type: "PullRequestEvent", action: "opened" })
  })

  it("takes its instant from the item's own created_at", () => {
    const normalized = Either.getOrThrow(normalizeEventsApi(readGithubExemplar("events-api-push.json")))
    expect(normalized.timestamp).toBe("2026-07-19T19:14:52.000Z")
  })

  it("gives two items with different created_at values different instants — unlike the notifications inbox", () => {
    const first = Either.getOrThrow(normalizeEventsApi(readGithubExemplar("events-api-pull_request-opened.json")))
    const second = Either.getOrThrow(normalizeEventsApi(readGithubExemplar("events-api-push.json")))
    expect(first.timestamp).not.toBe(second.timestamp)
  })

  it("omits the action from an action-less push, in the name and the trigger alike", () => {
    const normalized = Either.getOrThrow(normalizeEventsApi(readGithubExemplar("events-api-push.json")))
    expect(normalized.name).toBe("PushEvent")
    expect(normalized.trigger).toStrictEqual({ channel: "events_api", type: "PushEvent" })
  })

  it("fails typed, naming the item id, when the item is malformed", () => {
    const failure = Either.getOrThrow(Either.flip(normalizeEventsApi(readGithubExemplar("invalid-events-api-missing-repo.json"))))
    expect(failure).toMatchObject({ channel: "events_api", itemId: "56138223444" })
  })
})

describe("the events_api mapping rules", () => {
  it.for([
    ["events-api-pull_request-opened.json", "notification", 5, "new-pull-request"],
    ["events-api-push.json", "notification", 7, "push"]
  ])("classifies %s to %s p%d %s", ([fileName, eventType, priority, name]) => {
    expect(Either.getOrThrow(toEvent(readGithubExemplar(fileName as string)))).toMatchObject({ eventType, priority, name })
  })

  it("classifies an unmapped activity type to the config default rather than dropping it", () => {
    expect(Either.getOrThrow(toEvent(readGithubExemplar("events-api-unmapped-watch.json")))).toMatchObject({
      eventType: "notification",
      priority: 3,
      name: "WatchEvent-started"
    })
  })

  it("gives a normalized item a key present in the compiled config", () => {
    const trigger = Either.getOrThrow(normalizeEventsApi(readGithubExemplar("events-api-pull_request-opened.json"))).trigger
    expect(compiled.lookup.has(matchKey(trigger))).toBe(true)
  })

  it("keeps the three channels' vocabularies apart even where they describe the same activity", () => {
    expect(classify(compiled, buildEventsApiTrigger("pull_request", "opened")).matched).toBe(false)
    expect(classify(compiled, buildEventsApiTrigger("PullRequestEvent", "opened")).matched).toBe(true)
  })

  it("covers every events_api type the poller subscribes to", () => {
    const covered = [
      ["PullRequestEvent", "opened"],
      ["PullRequestEvent", "closed"],
      ["PullRequestReviewEvent", "created"],
      ["IssuesEvent", "opened"],
      ["IssuesEvent", "closed"],
      ["ReleaseEvent", "published"]
    ] as const
    expect(covered.filter(([type, action]) => !classify(compiled, buildEventsApiTrigger(type, action)).matched)).toStrictEqual([])
    expect(classify(compiled, buildEventsApiTrigger("PushEvent", undefined)).matched).toBe(true)
  })
})
