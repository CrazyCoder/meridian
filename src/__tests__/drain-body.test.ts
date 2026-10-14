import { describe, expect, it } from "bun:test"
import { DrainBodyError, DRAIN_BODY_MAX_BYTES, readDrainBody } from "../proxy/drainBody"

type RequestOptions = NonNullable<ConstructorParameters<typeof Request>[1]>

function request(body?: RequestOptions["body"], headers?: RequestOptions["headers"], signal?: AbortSignal): Request {
  return new Request("http://localhost/drain", { method: "POST", body, headers, signal })
}

describe("bounded drain operator body", () => {
  it("reads omitted and exact byte-boundary bodies", async () => {
    const shutdown = new AbortController()
    expect(await readDrainBody(request(), shutdown.signal)).toBe("")
    expect(await readDrainBody(request("x".repeat(DRAIN_BODY_MAX_BYTES)), shutdown.signal)).toHaveLength(DRAIN_BODY_MAX_BYTES)
  })

  it("bounds actual bytes including UTF-8 and streamed chunks", async () => {
    const shutdown = new AbortController()
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("é".repeat(300)))
      controller.enqueue(new Uint8Array(500))
    } })
    await expect(readDrainBody(request(stream), shutdown.signal)).rejects.toMatchObject({ status: 413 })
    await expect(readDrainBody(request("x".repeat(DRAIN_BODY_MAX_BYTES + 1)), shutdown.signal)).rejects.toBeInstanceOf(DrainBodyError)
  })

  it("joins declared oversize producer cancellation before settling", async () => {
    let cancelStarted = false
    let join = () => {}
    const joined = new Promise<void>(resolve => { join = resolve })
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelStarted = true; return joined } })
    let settled = false
    const reading = readDrainBody(request(stream, { "content-length": "1025" }), new AbortController().signal)
      .finally(() => { settled = true })
    await Bun.sleep(5)
    expect(cancelStarted).toBe(true)
    expect(settled).toBe(false)
    join()
    await expect(reading).rejects.toMatchObject({ status: 413 })
    expect(settled).toBe(true)
  })

  it("revokes a never-completed read at its finite deadline and cancels it", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    await expect(readDrainBody(request(stream), new AbortController().signal)).rejects.toMatchObject({ status: 400, message: "Drain options body read timed out" })
    expect(cancelled).toBe(true)
  }, 4000)

  it("joins the original read and cancellation after shutdown or socket abort", async () => {
    for (const source of ["shutdown", "socket"] as const) {
      const shutdown = new AbortController(), socket = new AbortController()
      let join = () => {}
      const joined = new Promise<void>(resolve => { join = resolve })
      let cancelled = false, settled = false
      const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return joined } })
      const reading = readDrainBody(request(stream, undefined, socket.signal), shutdown.signal).finally(() => { settled = true })
      if (source === "shutdown") shutdown.abort()
      else socket.abort()
      await Bun.sleep(5)
      expect(cancelled).toBe(true)
      expect(settled).toBe(false)
      join()
      await expect(reading).rejects.toMatchObject({ status: source === "shutdown" ? 503 : 499 })
    }
  })
})
