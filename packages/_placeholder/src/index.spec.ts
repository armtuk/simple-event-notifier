import { describe, expect, it } from "vitest"
import { describeWorkspace, workspaceName } from "./index.ts"

describe("describeWorkspace", () => {
  it("names the workspace and its member count", () => {
    expect(describeWorkspace(1)).toBe("personal-events workspace with 1 member(s)")
  })

  it("exposes the workspace name as a literal constant", () => {
    expect(workspaceName).toBe("personal-events")
  })
})
