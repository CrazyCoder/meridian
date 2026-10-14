import { describe, expect, it } from "bun:test"
import { isGenerationSubmission, onGenerationResponseSettled } from "../proxy/generationAdmission"

describe("combined generation admission", () => {
  it("holds only supported exact generation POSTs", () => {
    for (const path of ["/v1/messages", "/messages", "/v1/chat/completions", "/v1/responses"]) {
      expect(isGenerationSubmission("POST", path)).toBe(true)
      for (const method of ["GET", "DELETE", "PUT"]) expect(isGenerationSubmission(method, path)).toBe(false)
    }
    for (const path of ["/v1/messages/count_tokens", "/v1/responses/input_tokens", "/v1/responses/resp_agy_123/cancel", "/v1/sessions/key/cancel", "/v1/responses/resp_agy_123", "/v1/responses/", "/other"]) {
      expect(isGenerationSubmission("POST", path)).toBe(false)
    }
  })

  it("retains private response ownership until actual cancellation joins", async () => {
    let join = () => {}
    const joined = new Promise<void>(resolve => { join = resolve })
    let settled = 0, cancelStarted = false
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelStarted = true; return joined } })
    const response = onGenerationResponseSettled(new Response(source), () => { settled++ })
    const cancelling = response.body!.cancel()
    await Bun.sleep(5)
    expect(cancelStarted).toBe(true)
    expect(settled).toBe(0)
    join()
    await cancelling
    expect(settled).toBe(1)
  })

  it("settles actual completion, failure and empty responses exactly once", async () => {
    let settled = 0
    const response = onGenerationResponseSettled(new Response("ok", { status: 201, headers: { "x-fixture": "yes" } }), () => { settled++ })
    expect(response.status).toBe(201)
    expect(response.headers.get("x-fixture")).toBe("yes")
    expect(await response.text()).toBe("ok")
    expect(settled).toBe(1)
    onGenerationResponseSettled(new Response(null), () => { settled++ })
    expect(settled).toBe(2)
    const failed = onGenerationResponseSettled(new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture read failure")) } })), () => { settled++ })
    await expect(failed.text()).rejects.toThrow("fixture read failure")
    expect(settled).toBe(3)
  })
})
