/** A URL that has been parsed and restricted to the HTTPS scheme. */
export type HttpsUrl = `https://${string}`

/**
 * Parses an untrusted URL and returns its canonical HTTPS form. Manifest data is user-controlled,
 * and Electron's `shell.openExternal` accepts more schemes than the manager should ever open.
 */
export function toHttpsUrl(value: unknown): HttpsUrl | undefined {
  if (typeof value !== "string") return undefined

  try {
    const url = new URL(value)
    return url.protocol === "https:" ? (url.href as HttpsUrl) : undefined
  } catch {
    return undefined
  }
}
