export const workspaceName = "personal-events" as const

export const describeWorkspace = (memberCount: number): string => `${workspaceName} workspace with ${memberCount} member(s)`
