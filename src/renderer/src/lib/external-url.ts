// Keep renderer callers on the `@/lib` import boundary while sharing the exact validation used by
// Electron's window-open handler.
export { toHttpsUrl, type HttpsUrl } from "../../../shared/urls"
