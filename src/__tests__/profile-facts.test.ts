/**
 * Unit tests for profileFacts.ts.
 *
 * The module ships browser source, so the tests evaluate that exact text
 * rather than a TypeScript copy of it — what is asserted here is what both
 * pages actually run.
 */
import { describe, test, expect } from "bun:test"
import { profileFactsJs } from "../telemetry/profileFacts"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

interface Fact { label: string; value: string; tone: string; title?: string; cached?: boolean }

const evaluated = new Function(
  profileFactsJs + "\nreturn { profileFacts: profileFacts, timeAgo: timeAgo };",
)() as {
  profileFacts: (p: Record<string, unknown>) => Fact[]
  timeAgo: (ts: number | null | undefined) => string
}

const { profileFacts, timeAgo } = evaluated

function labels(p: Record<string, unknown>): string[] {
  return profileFacts(p).map(f => f.label)
}

function valueOf(p: Record<string, unknown>, label: string): string | undefined {
  return profileFacts(p).find(f => f.label === label)?.value
}

describe("profileFacts", () => {
  test("status is always stated, even for a profile with nothing else known", () => {
    expect(labels({})).toEqual(["Status"])
  })

  test("a logged-in account reads as authenticated, in the affirmative tone", () => {
    const status = profileFacts({ loggedIn: true })[0]!
    expect(status.value).toBe("✓ Authenticated")
    expect(status.tone).toBe("ok")
  })

  test("a logged-out account reads as not logged in, in the error tone", () => {
    const status = profileFacts({ loggedIn: false })[0]!
    expect(status.value).toBe("✗ Not logged in")
    expect(status.tone).toBe("err")
  })

  test("the organization is stated when known", () => {
    expect(valueOf({ organizationName: "Acme Inc" }, "Organization")).toBe("Acme Inc")
  })

  test("an unknown organization is omitted rather than rendered as a placeholder", () => {
    expect(labels({ organizationName: null })).not.toContain("Organization")
    expect(labels({ organizationName: "" })).not.toContain("Organization")
    expect(labels({})).not.toContain("Organization")
  })

  test("the organization sits between the email and the plan", () => {
    const rows = labels({ email: "a@b.c", organizationName: "Acme Inc", subscriptionType: "max" })
    expect(rows).toEqual(["Status", "Email", "Organization", "Plan"])
  })

  test("email and plan are stated when known and omitted when not", () => {
    expect(valueOf({ email: "a@b.c" }, "Email")).toBe("a@b.c")
    expect(valueOf({ subscriptionType: "max" }, "Plan")).toBe("max")
    expect(labels({ email: null, subscriptionType: null })).toEqual(["Status"])
  })

  test("last verified is stated in the affirmative tone", () => {
    const fact = profileFacts({ lastSuccessAt: Date.now() }).find(f => f.label === "Last Verified")!
    expect(fact.value).toBe("just now")
    expect(fact.tone).toBe("ok")
  })

  test("last checked is omitted when it merely repeats last verified", () => {
    const at = Date.now()
    expect(labels({ lastSuccessAt: at, lastCheckedAt: at })).not.toContain("Last Checked")
  })

  test("last checked is stated when it differs from last verified", () => {
    const at = Date.now()
    expect(labels({ lastSuccessAt: at - 60_000, lastCheckedAt: at })).toContain("Last Checked")
  })

  test("last checked is stated when nothing ever verified", () => {
    expect(labels({ loggedIn: false, lastCheckedAt: Date.now() })).toEqual(["Status", "Last Checked"])
  })

  test("the full set reads in card order", () => {
    const at = Date.now()
    expect(labels({
      loggedIn: true,
      email: "a@b.c",
      organizationName: "Acme Inc",
      subscriptionType: "max",
      lastSuccessAt: at - 60_000,
      lastCheckedAt: at,
    })).toEqual(["Status", "Email", "Organization", "Plan", "Last Verified", "Last Checked"])
  })
})

describe("timeAgo", () => {
  test("an absent timestamp reads as a dash", () => {
    expect(timeAgo(null)).toBe("—")
    expect(timeAgo(0)).toBe("—")
    expect(timeAgo(undefined)).toBe("—")
  })

  test("recent timestamps read in the coarsest unit that fits", () => {
    const now = Date.now()
    expect(timeAgo(now)).toBe("just now")
    expect(timeAgo(now - 30_000)).toBe("30s ago")
    expect(timeAgo(now - 5 * 60_000)).toBe("5m ago")
    expect(timeAgo(now - 3 * 3_600_000)).toBe("3h ago")
  })
})

describe("qualified current credential expiry facts", () => {
  const now = 1_790_000_000_000
  const hour = 3_600_000
  const day = 24 * hour
  const currentFacts = new Function("Date", profileFactsJs + "\nreturn profileFacts;")(
    class extends Date { static override now() { return now } },
  ) as (p: Record<string, unknown>) => Fact[]

  test("future deadlines are actionable and explicitly separate from authentication", () => {
    const facts = currentFacts({ loggedIn: true, refreshTokenExpiresAt: now + 2 * day + 4 * hour,
      accessTokenExpiresAt: now + 3 * hour, renewalRequiredSoon: true })
    expect(facts[0]!.value).toBe("✓ Authenticated")
    expect(facts[1]).toMatchObject({ label: "Refresh deadline", value: "in 2d 4h", tone: "warn" })
    expect(facts[1]!.title).toContain("Reported by the stored credential")
    expect(facts[1]!.title).toContain("Authentication is checked separately")
    expect(facts[2]).toMatchObject({ label: "Stored access token", value: "expires in 3h 0m" })
    expect(facts[2]!.title).toContain("may be estimated")
  })

  test("a passed refresh deadline retains future access expiry and never invents logout or login age", () => {
    const facts = currentFacts({ loggedIn: true, refreshTokenExpiresAt: now - hour,
      accessTokenExpiresAt: now + 3 * hour, firstUnauthedAt: now - hour,
      unauthedReason: "refresh_rejected", authObtainedAt: now - day })
    expect(facts[0]!.value).toBe("✓ Authenticated")
    expect(facts[1]!.value).toBe("passed — login may need renewal")
    expect(facts[1]!.tone).toBe("warn")
    expect(facts[2]!.value).toBe("expires in 3h 0m")
    expect(facts.map(f => f.label)).not.toContain("Logged out")
    expect(facts.map(f => f.label)).not.toContain("Logged in")
    expect(facts.some(f => /stops in|can no longer|cannot renew/.test(f.value))).toBe(false)
  })

  test("past access metadata stays advisory and cached auth remains qualified", () => {
    const facts = currentFacts({ loggedIn: true, authProvenance: "cached", accessTokenExpiresAt: now - hour })
    expect(facts[0]).toMatchObject({ value: "✓ Authenticated", cached: true })
    expect(facts[1]).toMatchObject({ label: "Stored access token", value: "expiry passed", tone: "warn" })
    expect(facts[1]!.title).toContain("Authentication is checked separately")
  })

  test("unknown metadata omits countdowns and never supplies authentication proof", () => {
    expect(currentFacts({ loggedIn: false, authProvenance: "never", refreshTokenExpiresAt: null,
      accessTokenExpiresAt: null, renewalRequiredSoon: false })).toEqual([
      { label: "Status", value: "never read", tone: "err", cached: false },
    ])
  })

  test("both actual row renderers preserve escaped qualifiers, focus names and warning tone", () => {
    const escape = (s: unknown) => String(s).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]!)
    const source = landingHtml.slice(landingHtml.indexOf("function infoIcon(entry,type)"),
      landingHtml.indexOf("function infoPopOpen"))
    const infoIcon = new Function("profileFacts", "esc", "profileHref", source + "\nreturn infoIcon;")(
      () => [{ label: "Refresh deadline", value: "in 2d", tone: "warn", title: 'Stored "expiry" <only>', cached: true }],
      escape, (id: string) => "/profiles#" + id,
    ) as (p: { id: string }) => string
    const home = infoIcon({ id: "owned-fixture" })
    expect(home).toContain('title="Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(home).toContain('tabindex="0" aria-label="Refresh deadline: in 2d. Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(home).toContain("status-warn")
    expect(home).toContain("(cached)")
    expect(home).toContain('<span class="fact-explanation" aria-hidden="true">Stored &quot;expiry&quot; &lt;only&gt;</span>')
    expect(landingHtml).toContain(".prof-pop-value:focus > .fact-explanation { display: block; }")

    const profileSource = profilePageHtml.slice(profilePageHtml.indexOf("function factRows(facts)"),
      profilePageHtml.indexOf("// Mirrors src/telemetry/cachedFacts.ts"))
    // The profile page's text escape does not escape quotes. Its title and
    // accessible-name attributes must handle those independently.
    const textEscape = (s: unknown) => String(s).replace(/[&<>]/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
    })[ch]!)
    const rows = new Function("esc", profileSource + "\nreturn factRows;")(textEscape) as (facts: Fact[]) => string
    const profile = rows([{ label: "Refresh deadline", value: "in 2d", tone: "warn", title: 'Stored "expiry" <only>' }])
    expect(profile).toContain('title="Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(profile).toContain('tabindex="0" aria-label="Refresh deadline: in 2d. Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(profile).toContain("status-warn")
    expect(profile).toContain('<span class="fact-explanation" aria-hidden="true">Stored "expiry" &lt;only&gt;</span>')
    expect(profilePageHtml).toContain(".detail-value:focus > .fact-explanation { display: block; }")
  })
})

describe("expiry fact focus survives automatic refresh", () => {
  for (const page of ["profiles", "home"] as const) {
    function fixture(initialFocus = false, windowFocused = true) {
      let focused = initialFocus
      let hovered = false
      let requests = 0
      let renders = 0
      const content = { innerHTML: "original focused facts" }
      const response = { ok: true, json: async () => ({ profiles: [] }) }
      let resolve!: (value: typeof response) => void
      let reject!: (reason: Error) => void
      const pending = new Promise<typeof response>((yes, no) => { resolve = yes; reject = no })
      const fetch = () => {
        requests++
        return requests === 1 ? pending : Promise.resolve(response)
      }
      const factElement = {
        matches: (selector: string) => selector === ".detail-value[tabindex]",
        closest: (selector: string): object | null => selector === ".prof-info" ? factElement : null,
      }
      const bodyElement = { matches: () => false, closest: () => null }
      const document = {
        get activeElement() { return focused ? factElement : bodyElement },
        hasFocus: () => windowFocused,
        querySelector: (selector: string) => (
          (selector.includes(":hover") && hovered) || (selector.includes(":focus") && windowFocused && focused)
        ) ? factElement : null,
        getElementById: () => content,
      }
      const source = page === "profiles"
        ? "var editingProfile = null, lastQuota = null, lastProfiles = null;\n"
          + profilePageHtml.slice(profilePageHtml.indexOf("function detailFactFocused()"), profilePageHtml.indexOf("function esc(s)"))
        : landingHtml.slice(landingHtml.indexOf("function infoPopOpen(){"), landingHtml.indexOf("function profileSection(q,s,pl,h)"))
          + landingHtml.slice(landingHtml.indexOf("async function refresh(){"), landingHtml.indexOf("function tokens(v)"))
      const refresh = new Function("document", "fetch", "render", "meridianReorder",
        source + "\nreturn refresh;")(document, fetch, () => { renders++ }, { adopt: () => {} }) as () => Promise<void>
      return {
        refresh, resolve: () => resolve(response), reject: () => reject(new Error("fixture unavailable")),
        focus: () => { focused = true }, blur: () => { focused = false }, hover: () => { hovered = true }, content, document,
        requests: () => requests, renders: () => renders,
      }
    }

    test(`${page}: focused facts prevent a new poll`, async () => {
      const f = fixture(true)
      await f.refresh()
      expect(f.requests()).toBe(0)
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: focus acquired during a poll prevents a successful redraw`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.focus()
      f.resolve()
      await poll
      expect(f.requests()).toBeGreaterThan(0)
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: focus acquired during a failing poll prevents error replacement`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.focus()
      f.reject()
      await poll
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: an unfocused poll still updates the page`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.resolve()
      await poll
      expect(f.requests()).toBeGreaterThan(0)
      expect(f.renders()).toBe(1)
    })

    test(`${page}: polling resumes after focus leaves the retained facts`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.focus()
      f.resolve()
      await poll
      expect(f.renders()).toBe(0)
      f.blur()
      await f.refresh()
      expect(f.renders()).toBe(1)
    })

    test(`${page}: a retained active fact prevents polling even in an inactive document`, async () => {
      const f = fixture(true, false)
      expect(f.document.hasFocus()).toBe(false)
      expect(f.document.querySelector(":focus")).toBeNull()
      f.resolve()
      await f.refresh()
      expect(f.requests()).toBe(0)
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: an inactive document retains a fact selected during a successful poll until blur`, async () => {
      const f = fixture(false, false)
      const poll = f.refresh()
      f.focus()
      f.resolve()
      await poll
      expect(f.document.querySelector(":focus")).toBeNull()
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
      f.blur()
      await f.refresh()
      expect(f.renders()).toBe(1)
    })

    test(`${page}: an inactive document retains a selected fact during a failing poll`, async () => {
      const f = fixture(false, false)
      const poll = f.refresh()
      f.focus()
      f.reject()
      await poll
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    if (page === "home") test("home: hover still prevents polling without an active fact", async () => {
      const f = fixture(false, false)
      f.hover()
      await f.refresh()
      expect(f.document.hasFocus()).toBe(false)
      expect(f.requests()).toBe(0)
      expect(f.renders()).toBe(0)
    })
  }
})

describe("both pages render from this one builder", () => {
  test("the landing page carries the shared source", () => {
    expect(landingHtml).toContain("function profileFacts(p)")
  })

  test("the profiles page carries the shared source", () => {
    expect(profilePageHtml).toContain("function profileFacts(p)")
  })

  test("neither page defines a second row list of its own", () => {
    // The drift this module exists to prevent: a page that stops calling the
    // builder and starts hand-writing rows again.
    expect(landingHtml).toContain("profileFacts(entry)")
    expect(profilePageHtml).toContain("profileFacts(p)")
    expect(profilePageHtml).not.toContain("Last Verified<")
  })

  test("the shared source is emitted exactly once per page", () => {
    expect(landingHtml.split("function profileFacts(p)").length - 1).toBe(1)
    expect(profilePageHtml.split("function profileFacts(p)").length - 1).toBe(1)
  })
})
