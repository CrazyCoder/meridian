/**
 * Unit tests for profileFind.ts.
 *
 * The module ships browser source, so the tests evaluate that exact text —
 * what is asserted here is what /profiles and the landing page run.
 */
import { describe, test, expect } from "bun:test"
import { profileFindJs } from "../telemetry/profileFind"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

type Profile = Record<string, unknown> & { id: string }

const find = new Function(
  profileFindJs + `
return {
  profileAnchorElementId: profileAnchorElementId,
  profileHref: profileHref,
  profileIdFromHash: profileIdFromHash,
  resolveProfileAnchor: resolveProfileAnchor,
  profileMatchesQuery: profileMatchesQuery,
  profileQueryTerms: profileQueryTerms,
};`,
)() as {
  profileAnchorElementId: (id: string) => string
  profileHref: (id: string) => string
  profileIdFromHash: (hash: string | null | undefined) => string
  resolveProfileAnchor: (hash: string, profiles: Profile[]) => string | null
  profileMatchesQuery: (p: Profile | undefined, query: string) => boolean
  profileQueryTerms: (query: string) => string[]
}

const personal: Profile = {
  id: "enrique-personal",
  type: "claude-max",
  email: "enrique@example.com",
  organizationName: "Enrique's Individual Org",
  accountType: "Personal",
  planName: "Max",
  planLabel: "Max 5x",
  subscriptionType: "max",
  allowance: "5x",
  rateLimitTier: "default_claude_max_5x",
  aliases: ["enrique", "old-personal"],
}
const work: Profile = {
  id: "work",
  type: "claude-max",
  email: "ops@acme.test",
  organizationName: "Acme Corp",
  accountType: "Team",
  planName: "Team Premium",
  subscriptionType: "team",
  allowance: "20x",
}
const apiKey: Profile = { id: "api", type: "api" }
const profiles = [personal, work, apiKey]

describe("profile anchors", () => {
  test("links carry the bare profile id, so the URL reads as the name", () => {
    expect(find.profileHref("enrique-personal")).toBe("/profiles#enrique-personal")
  })

  test("the element is namespaced so a profile cannot collide with page ids", () => {
    expect(find.profileAnchorElementId("content")).toBe("profile-content")
  })

  test("the hash is read with or without its #, and decoded", () => {
    expect(find.profileIdFromHash("#enrique-personal")).toBe("enrique-personal")
    expect(find.profileIdFromHash("work")).toBe("work")
    expect(find.profileIdFromHash("#a%20b")).toBe("a b")
    expect(find.profileIdFromHash("")).toBe("")
    expect(find.profileIdFromHash(null)).toBe("")
  })

  test("a malformed escape is taken literally rather than thrown", () => {
    expect(find.profileIdFromHash("#bad%E0")).toBe("bad%E0")
  })

  test("an exact id resolves to itself", () => {
    expect(find.resolveProfileAnchor("#work", profiles)).toBe("work")
  })

  test("a former name resolves to the renamed profile", () => {
    expect(find.resolveProfileAnchor("#old-personal", profiles)).toBe("enrique-personal")
  })

  test("casing does not matter for an id or a former name", () => {
    expect(find.resolveProfileAnchor("#WORK", profiles)).toBe("work")
    expect(find.resolveProfileAnchor("#Enrique", profiles)).toBe("enrique-personal")
  })

  test("an id beats a former name, as request routing does", () => {
    const retaken: Profile = { id: "enrique" }
    expect(find.resolveProfileAnchor("#enrique", [personal, retaken])).toBe("enrique")
  })

  test("an unknown or empty hash resolves to nothing", () => {
    expect(find.resolveProfileAnchor("#nobody", profiles)).toBeNull()
    expect(find.resolveProfileAnchor("", profiles)).toBeNull()
    expect(find.resolveProfileAnchor("#work", [])).toBeNull()
  })
})

describe("profile search", () => {
  function matching(query: string): string[] {
    return profiles.filter(p => find.profileMatchesQuery(p, query)).map(p => p.id)
  }

  test("an empty or blank query matches everything", () => {
    expect(matching("")).toEqual(["enrique-personal", "work", "api"])
    expect(matching("   ")).toEqual(["enrique-personal", "work", "api"])
  })

  test("matches the profile name, case-insensitively and by substring", () => {
    expect(matching("ENRIQUE")).toEqual(["enrique-personal"])
    expect(matching("wor")).toEqual(["work"])
  })

  test("matches the allowance tier", () => {
    expect(matching("5x")).toEqual(["enrique-personal"])
    expect(matching("20x")).toEqual(["work"])
  })

  test("matches the plan family and plan name", () => {
    expect(matching("max")).toEqual(["enrique-personal"])
    expect(matching("premium")).toEqual(["work"])
  })

  test("matches email and organization", () => {
    expect(matching("acme.test")).toEqual(["work"])
    expect(matching("individual org")).toEqual(["enrique-personal"])
  })

  test("matches a former name", () => {
    expect(matching("old-personal")).toEqual(["enrique-personal"])
  })

  test("matches the profile type", () => {
    expect(matching("api")).toEqual(["api"])
  })

  test("every term must match, each anywhere", () => {
    expect(matching("max acme")).toEqual([])
    expect(matching("team acme")).toEqual(["work"])
  })

  test("a query nothing matches hides every profile", () => {
    expect(matching("zzz")).toEqual([])
  })

  test("a card with no profile data behind it never matches a real query", () => {
    expect(find.profileMatchesQuery(undefined, "work")).toBe(false)
    expect(find.profileMatchesQuery(undefined, "")).toBe(true)
  })

  test("terms split on any whitespace", () => {
    expect(find.profileQueryTerms("  Max\t5x \n")).toEqual(["max", "5x"])
  })
})

describe("page wiring", () => {
  test("/profiles ships the resolver and a search box outside the redrawn list", () => {
    expect(profilePageHtml).toContain(profileFindJs)
    const search = profilePageHtml.indexOf('id="profiles-filter"')
    const content = profilePageHtml.indexOf('<div id="content">')
    expect(search).toBeGreaterThan(-1)
    expect(content).toBeGreaterThan(search)
    expect(profilePageHtml.indexOf("Configured Profiles")).toBeLessThan(search)
  })

  test("/profiles gives every card its anchor id", () => {
    expect(profilePageHtml).toContain("id=\"' + esc(profileAnchorElementId(p.id)) + '\"")
  })

  test("/profiles listens for the hash changing while the page is open", () => {
    expect(profilePageHtml).toContain("addEventListener('hashchange'")
  })

  test("/profiles re-aligns the card when the header grows after the jump", () => {
    expect(profilePageHtml).toContain("new ResizeObserver(")
    expect(profilePageHtml).toContain("anchorHold = { card: card, until:")
  })

  test("the landing page links a card's account to its /profiles anchor", () => {
    expect(landingHtml).toContain(profileFindJs)
    expect(landingHtml).toContain("profileHref(entry.id)")
    expect(landingHtml).toContain("profileHref(p.id)")
  })
})
