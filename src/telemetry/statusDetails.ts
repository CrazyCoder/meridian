/** Serialized into the shared header; keep this function self-contained. */
export function bindStatusDetails(
  button: EventTarget & { disabled: boolean; setAttribute(name: string, value: string): void },
  panel: { textContent: string | null; hidden: boolean },
  region: EventTarget,
  keyboardRoot: EventTarget,
) {
  let pinned = false
  let hovered = false
  function render() {
    panel.hidden = !panel.textContent || !(pinned || hovered)
    button.setAttribute("aria-expanded", String(!panel.hidden))
  }
  // The region contains the trigger, the panel and its CSS hit-test bridge.
  // Trigger-to-panel movement never leaves this ancestor, so no guessed delay
  // is needed to keep unpinned details available while they are being read.
  region.addEventListener("mouseenter", () => { hovered = true; render() })
  region.addEventListener("mouseleave", () => { hovered = false; render() })
  button.addEventListener("click", () => {
    if (button.disabled) return
    pinned = !pinned
    render()
  })
  function dismissOnEscape(event: Event): void {
    if (!panel.hidden && "key" in event && event.key === "Escape") {
      pinned = false
      hovered = false
      render()
    }
  }
  // Hover does not move keyboard focus. Capture page Escape even when focus
  // stays on body/input; leave other controls' normal key handling untouched.
  keyboardRoot.addEventListener("keydown", dismissOnEscape, true)
  button.addEventListener("keydown", dismissOnEscape)
  button.addEventListener("blur", () => { pinned = false; hovered = false; render() })
  return {
    refresh(title: string): void {
      panel.textContent = title
      button.disabled = title.length === 0
      if (!title) { pinned = false; hovered = false }
      render()
    },
  }
}
