/** Exact combined-provider submissions; estimates and control POSTs bypass. */
export function isGenerationSubmission(method: string, path: string): boolean {
  return method === "POST" && ["/v1/messages", "/messages", "/v1/chat/completions", "/v1/responses"].includes(path)
}

/** Private close ownership waits for the actual response reader/cancel join. */
export function onGenerationResponseSettled(response: Response, settle: () => void): Response {
  if (!response.body) {
    settle()
    return response
  }
  const reader = response.body.getReader()
  let finished = false
  let cancelling = false
  const finish = () => {
    if (finished) return
    finished = true
    settle()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (cancelling) return
        if (result.done) {
          finish()
          controller.close()
        } else controller.enqueue(result.value)
      } catch (error) {
        if (cancelling) return
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelling = true
      try { await reader.cancel(reason) }
      finally { finish() }
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
