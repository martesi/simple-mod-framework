// Keep renderer callers on the `@/lib` import boundary while sharing the exact validation used by
// Electron's window-open handler.
export { type HttpsUrl, toHttpsUrl } from '../../../shared/urls'
