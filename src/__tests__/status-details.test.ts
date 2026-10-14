import { describe, expect, it } from "bun:test"
import { bindStatusDetails } from "../telemetry/statusDetails"

class Button extends EventTarget {
  disabled = false
  attributes = new Map<string, string>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
}
function fixture(bind = bindStatusDetails) {
  const button = new Button()
  const panel = Object.assign(new EventTarget(), { hidden: true, textContent: "" })
  const region = new EventTarget()
  const keyboardRoot = new EventTarget()
  const control = bind(button, panel, region, keyboardRoot)
  const event = (type: string, key?: string, target: EventTarget = button) => {
    const value = new Event(type)
    if (key !== undefined) Object.defineProperty(value, "key", { value: key })
    target.dispatchEvent(value)
  }
  const pageKey = (key: string, focused: EventTarget) => {
    // Native DOM capture is a browser gate. Deliver the document capture path
    // and then the focused target explicitly, without inventing button focus.
    event("keydown", key, keyboardRoot)
    event("keydown", key, focused)
  }
  return { button, panel, region, keyboardRoot, control, event, pageKey }
}

describe("shared header status details", () => {
  it("opens on a button activation and stays available through hover departure", () => {
    const f = fixture()
    f.control.refresh("Connection details")
    expect(f.button.disabled).toBe(false)
    f.event("click")
    expect(f.panel.hidden).toBe(false)
    expect(f.button.attributes.get("aria-expanded")).toBe("true")
    f.event("mouseleave")
    expect(f.panel.hidden).toBe(false)
    f.event("click")
    expect(f.panel.hidden).toBe(true)
  })
  it("offers hover details and allows Escape or blur to close", () => {
    const f = fixture()
    f.control.refresh("Connection details")
    f.event("mouseenter", undefined, f.region)
    expect(f.panel.hidden).toBe(false)
    f.event("keydown", "Escape")
    expect(f.panel.hidden).toBe(true)
    f.event("click")
    f.event("blur")
    expect(f.panel.hidden).toBe(true)
    expect(f.button.attributes.get("aria-expanded")).toBe("false")
  })
  it.each(["body", "page input"])("dismisses hover-open details on document Escape while focus stays on %s", () => {
    const f = fixture(), focused = new EventTarget()
    let buttonKeyEvents = 0
    f.button.addEventListener("keydown", () => { buttonKeyEvents++ })
    f.control.refresh("Connection details")
    f.event("mouseenter", undefined, f.region)
    expect(f.panel.hidden).toBe(false)
    f.pageKey("ArrowDown", focused)
    expect(f.panel.hidden).toBe(false)
    f.pageKey("Escape", focused)
    expect(buttonKeyEvents).toBe(0)
    expect(f.panel.hidden).toBe(true)
    expect(f.button.attributes.get("aria-expanded")).toBe("false")
    f.control.refresh("Updated details")
    expect(f.panel.hidden).toBe(true)
  })
  it("dismisses a keyboard-activated pinned read through the document route after polling", () => {
    const f = fixture()
    f.control.refresh("Connection details")
    // A native button delivers click for keyboard activation. EventTarget
    // does not implement that browser default action; dispatch its delivery.
    f.event("click")
    expect(f.panel.hidden).toBe(false)
    f.control.refresh("Current observation")
    expect(f.panel.hidden).toBe(false)
    f.pageKey("Escape", f.button)
    expect(f.panel.hidden).toBe(true)
    f.control.refresh("Later observation")
    expect(f.panel.hidden).toBe(true)
  })
  it("does not consume unrelated page keys or Escape when the disclosure is closed", () => {
    const f = fixture()
    f.control.refresh("Connection details")
    const escape = new Event("keydown", { cancelable: true })
    Object.defineProperty(escape, "key", { value: "Escape" })
    f.keyboardRoot.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
    expect(f.panel.hidden).toBe(true)
    f.event("mouseenter", undefined, f.region)
    f.event("keydown", "Enter", f.keyboardRoot)
    expect(f.panel.hidden).toBe(false)
  })
  it("retains unpinned details across the trigger, gap and panel within the shared region", () => {
    const f = fixture()
    f.control.refresh("Connection details")
    f.event("mouseenter", undefined, f.region)
    f.event("mouseenter")
    expect(f.panel.hidden).toBe(false)
    // Leaving the trigger for the region's gap or panel is not leaving the
    // containing region. DOM hit testing of the gap remains a browser gate.
    f.event("mouseleave")
    expect(f.panel.hidden).toBe(false)
    f.event("mouseenter", undefined, f.panel)
    f.control.refresh("Current recovery detail")
    expect(f.panel.hidden).toBe(false)
    expect(f.panel.textContent).toBe("Current recovery detail")
    f.event("mouseleave", undefined, f.panel)
    expect(f.panel.hidden).toBe(false)
    f.event("mouseleave", undefined, f.region)
    expect(f.panel.hidden).toBe(true)
    expect(f.button.attributes.get("aria-expanded")).toBe("false")
  })
  it("dismisses region hover with Escape, blur or stale details without resurrecting it on refresh", () => {
    const f = fixture()
    for (const reason of ["Escape", "blur", "stale"]) {
      f.control.refresh("Connection details")
      f.event("mouseenter", undefined, f.region)
      expect(f.panel.hidden).toBe(false)
      if (reason === "Escape") f.event("keydown", "Escape")
      else if (reason === "blur") f.event("blur")
      else f.control.refresh("")
      expect(f.panel.hidden).toBe(true)
      f.control.refresh("Updated details")
      expect(f.panel.hidden).toBe(true)
      f.event("mouseleave", undefined, f.region)
    }
  })
  it("updates details without collapsing a pinned reading and clears obsolete details", () => {
    const f = fixture()
    f.control.refresh("First failure")
    f.event("click")
    f.control.refresh("Recovery observation")
    expect(f.panel.textContent).toBe("Recovery observation")
    expect(f.panel.hidden).toBe(false)
    f.control.refresh("")
    expect(f.panel.hidden).toBe(true)
    expect(f.button.disabled).toBe(true)
    f.event("click")
    expect(f.panel.hidden).toBe(true)
    f.control.refresh("New failure")
    expect(f.panel.hidden).toBe(true)
  })
  it("does not require module closure state when inlined into the browser", () => {
    const rebuilt = new Function(`return (${bindStatusDetails.toString()})`)() as typeof bindStatusDetails
    const f = fixture(rebuilt)
    f.control.refresh("Readable detail")
    f.event("click")
    expect(f.panel.hidden).toBe(false)
  })
})
