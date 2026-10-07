/**
 * Child process for error-reporting.test.ts: a process shaped like Meridian's,
 * with the reporter installed, that then fails the way the test asks.
 *
 *   REPORTER_DSN       DSN to report to; unset = reporting off
 *   REPORTER_SPOOL     spool directory
 *   REPORTER_RECOVER   "1" installs the CLI's recovering handlers, as bin/cli.ts does
 *   REPORTER_FAIL      comma list of: throw, reject, reject-undefined
 *   REPORTER_LINGER_MS how long a surviving process stays up for delivery
 */
import { installErrorReporter } from "../../errorReporting"
import { installProxyProcessErrorHandlers } from "../../proxy/server"

const dsn = process.env.REPORTER_DSN
installErrorReporter({
  ...(dsn ? { dsn } : {}),
  spoolDir: process.env.REPORTER_SPOOL!,
  version: "0.0.0-test",
  startupFlushDelayMs: 0,
})
if (process.env.REPORTER_RECOVER === "1") installProxyProcessErrorHandlers()

const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlc2lnbmF0dXJl"].join(".")
const SECRETS = `Bearer bearermarkerbearermarker sk-ant-oat01-OATMARKEROATMARKER ${JWT} `
  + "https://user:hunter2@example.com/path?access_token=QUERYMARKER refresh_token=REFRESHMARKER"

for (const failure of (process.env.REPORTER_FAIL ?? "").split(",").filter(Boolean)) {
  if (failure === "throw") setTimeout(() => { throw new Error(`thrown ${SECRETS}`) }, 10)
  if (failure === "reject") {
    const error = new Error(`rejected ${SECRETS}`)
    if (process.env.REPORTER_NAME) error.name = process.env.REPORTER_NAME
    void Promise.reject(error)
  }
  if (failure === "reject-undefined") void Promise.reject(undefined)
}

const lingerMs = Number(process.env.REPORTER_LINGER_MS ?? "0")
if (lingerMs > 0) setTimeout(() => {
  if (process.env.REPORTER_NATURAL_EXIT === "1") console.error("Reporter probe survived")
  else process.exit(0)
}, lingerMs)
