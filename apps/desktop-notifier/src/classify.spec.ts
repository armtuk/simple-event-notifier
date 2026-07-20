import { describe, expect, it } from "vitest"
import { classifyObjects, parsedObjects, rejectedObjects } from "./classify.ts"
import type { PolledObject } from "./poller.ts"
import { readExemplarText, readLocalExemplarText } from "./testing/exemplars.ts"

const objectFor = (fileName: string, key: string): PolledObject => ({ key, body: readExemplarText(fileName) })

const goodObject = objectFor("valid-github-pull-request.json", "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json")

const badSchemaObject = objectFor("invalid-priority-out-of-range.json", "2026-06-28T18:44:31.000Z.alert.p9.github.new-pull-request.json")

const notJsonObject: PolledObject = { key: "2026-06-28T18:44:32.000Z.alert.p1.junk.junk.json", body: readLocalExemplarText("not-json.txt") }

describe("classifyObjects", () => {
  it("parses a well-formed object into an event carrying its key", () => {
    const [classified] = classifyObjects([goodObject])
    expect(classified?._tag).toBe("ParsedObject")
    expect(parsedObjects(classifyObjects([goodObject]))[0]?.event.source).toBe("github")
  })

  it("rejects an object whose body is not an event, naming the key and the reason", () => {
    const [rejected] = rejectedObjects(classifyObjects([badSchemaObject]))
    expect(rejected?.key).toBe(badSchemaObject.key)
    expect(rejected?.reason).toContain("priority")
  })

  it("rejects an object whose body is not JSON at all", () => {
    const [rejected] = rejectedObjects(classifyObjects([notJsonObject]))
    expect(rejected?.reason).toContain("not valid JSON")
  })

  it("lets good objects through even when a bad one sits in front of them", () => {
    const classified = classifyObjects([notJsonObject, badSchemaObject, goodObject])
    expect(parsedObjects(classified)).toHaveLength(1)
    expect(rejectedObjects(classified)).toHaveLength(2)
  })

  it("preserves order so notifications are raised chronologically", () => {
    const classified = classifyObjects([goodObject, badSchemaObject, notJsonObject])
    expect(classified.map(object => object.key)).toStrictEqual([goodObject.key, badSchemaObject.key, notJsonObject.key])
  })

  it("returns nothing for an empty poll", () => {
    expect(classifyObjects([])).toStrictEqual([])
  })
})
