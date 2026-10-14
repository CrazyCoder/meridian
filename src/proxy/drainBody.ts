/** Private resource bounds for the tiny local operator options body. */
export const DRAIN_BODY_MAX_BYTES = 1024
export const DRAIN_BODY_DEADLINE_MS = 2000

export class DrainBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 499 | 503) {
    super(message)
    this.name = "DrainBodyError"
  }
}

/**
 * Own the original reader until it settles and its cancellation joins. A
 * timeout revokes authority before cancelling; it never forgets a raced read.
 */
export async function readDrainBody(request: Request, shutdown: AbortSignal): Promise<string> {
  const signal = AbortSignal.any([request.signal, shutdown])
  const cancelled = () => shutdown.aborted
    ? new DrainBodyError("Meridian is shutting down", 503)
    : new DrainBodyError("The request was cancelled", 499)
  if (signal.aborted) throw cancelled()
  const length = request.headers.get("content-length")
  const declaredOversize = length !== null && /^\d+$/.test(length) && Number(length) > DRAIN_BODY_MAX_BYTES
  if (!request.body) {
    if (declaredOversize) throw new DrainBodyError("Drain options body exceeds 1024 bytes", 413)
    return ""
  }
  const reader = request.body.getReader()
  let failure: DrainBodyError | undefined
  let cancellation: Promise<void> | undefined
  const revoke = (error: DrainBodyError) => {
    failure ??= error
    cancellation ??= reader.cancel(error)
    // The finally block awaits this exact promise. Attach a handler now so
    // rejection while read() is still pending is never unhandled.
    void cancellation.catch(() => undefined)
  }
  const onAbort = () => revoke(cancelled())
  signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => revoke(new DrainBodyError("Drain options body read timed out", 400)), DRAIN_BODY_DEADLINE_MS)
  timer.unref?.()
  if (declaredOversize) revoke(new DrainBodyError("Drain options body exceeds 1024 bytes", 413))
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      // This original read is always awaited, including when cancellation
      // makes it settle. No Promise.race leaves an unowned parser behind.
      const result = await reader.read()
      if (failure) throw failure
      if (signal.aborted) throw cancelled()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > DRAIN_BODY_MAX_BYTES) {
        revoke(new DrainBodyError("Drain options body exceeds 1024 bytes", 413))
        throw failure
      }
      chunks.push(result.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(body)
  } catch (error) {
    if (failure) throw failure
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    try {
      if (cancellation) {
        try { await cancellation }
        catch (error) { if (!failure) throw error }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
