/** Node validates NODE_OPTIONS before startup. Quoted words may contain spaces. */
export function nodeRejectionPolicy(execArgv: readonly string[], nodeOptions: string | undefined): string {
  const words: string[] = []
  let word = ""
  let quoted = false
  let escaped = false
  for (const char of nodeOptions ?? "") {
    if (escaped) { word += char; escaped = false }
    else if (char === "\\" && quoted) escaped = true
    else if (char === '"') quoted = !quoted
    else if (/\s/.test(char) && !quoted) { if (word) words.push(word); word = "" }
    else word += char
  }
  if (word) words.push(word)
  // Explicit command-line options override NODE_OPTIONS, including repeats.
  words.push(...execArgv)
  let policy = "throw"
  for (let index = 0; index < words.length; index++) {
    const option = words[index]!
    if (option.startsWith("--unhandled-rejections=")) policy = option.slice("--unhandled-rejections=".length)
    else if (option === "--unhandled-rejections") policy = words[++index] ?? policy
  }
  return policy
}
