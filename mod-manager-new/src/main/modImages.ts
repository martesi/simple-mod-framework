import { access } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { net, protocol } from "electron"
import type { Manifest } from "../renderer/src/lib/manifest-types"

/**
 * Manifest option thumbnails (`ManifestOption.image`) are relative paths
 * *inside a mod's own folder on disk* - with `webSecurity: true` and no
 * direct filesystem access in the renderer (that's the whole point of
 * LEI-134), the renderer can't just do `<img src="C:\...\Mods\...\thumb.png">`
 * the way the old Svelte app effectively could.
 *
 * Instead, this registers a custom `smf-mod://` scheme that serves exactly
 * one file per request. The URL is an opaque token (an absolute path,
 * base64url-encoded so it survives being a single URL path segment
 * untouched - unlike a URL's *host*, its *path* is not case-normalized) that
 * `mods:list` mints only for paths it has already bounds-checked against the
 * mod's own folder (see {@link rewriteManifestImages}); the request handler
 * bounds-checks again against the live Mods root before ever touching disk,
 * so a stale/forged token from a previous session (e.g. Mods root changed in
 * Settings) can't be used to read arbitrary files. The component tree
 * (ModSettingsDrawer.tsx) needs no changes for any of this: it's still just
 * a string in an `<img src>`.
 */
const SCHEME = "smf-mod"

let currentModsRoot: () => string = () => ""

/** Wire in the live "where is Mods/ right now" getter - called once from main/index.ts. */
export function setModImageRoot(getModsDir: () => string): void {
  currentModsRoot = getModsDir
}

/** Call before `app.whenReady()` - registering a scheme's privileges only works pre-ready. */
export function registerModImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: false, secure: true, supportFetchAPI: true, corsEnabled: false, bypassCSP: false } }])
}

/** Call after `app.whenReady()`. */
export function registerModImageProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    // Non-standard scheme URLs look like "smf-mod:<token>" (no authority) -
    // everything after the colon, stripped of any accidental leading slashes.
    const token = request.url.slice(`${SCHEME}:`.length).replace(/^\/+/, "")
    const filePath = decodeToken(token)
    if (!filePath) return new Response(null, { status: 400 })

    const modsRoot = resolve(currentModsRoot())
    const resolvedFile = resolve(filePath)

    if (resolvedFile !== modsRoot && !resolvedFile.startsWith(modsRoot + sep)) {
      return new Response(null, { status: 403 })
    }

    // Async on purpose, not `existsSync` - this handler already runs once per <img>, and a settings
    // drawer with a few dozen option thumbnails fires that many requests back-to-back. A sync stat
    // here would block the main process (the same thread that pumps Electron's window/input
    // messages) once per thumbnail; `await`ing the async check instead lets everything else -
    // other image requests, other IPC, the window itself - interleave in the gaps rather than
    // queuing up behind it.
    try {
      await access(resolvedFile)
    } catch {
      return new Response(null, { status: 404 })
    }

    return net.fetch(pathToFileURL(resolvedFile).href)
  })
}

function encodeToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function decodeToken(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8")
  } catch {
    return undefined
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".apng", ".gif", ".webp", ".svg", ".jfif"])

function looksLikeLocalImagePath(value: string): boolean {
  // Manifest option images are historically sometimes authored as remote
  // URLs too (the mock data uses picsum.photos) - only rewrite genuine
  // relative on-disk paths, and only recognized image extensions.
  return !/^[a-z]+:\/\//i.test(value) && IMAGE_EXTENSIONS.has(extname(value).toLowerCase())
}

/** Rewrite every `options[].image` in a manifest to a `smf-mod://` URL, bounds-checked against `modFolder`. Anything that isn't a local relative image path (a remote URL, an unrecognized extension) is left untouched. */
export function rewriteManifestImages(manifest: Manifest, _modId: string, modFolder: string): Manifest {
  if (!manifest.options?.length) return manifest

  const resolvedFolder = resolve(modFolder)

  return {
    ...manifest,
    options: manifest.options.map((option) => {
      if (!option.image || !looksLikeLocalImagePath(option.image)) return option

      const resolvedImage = resolve(resolvedFolder, option.image)
      if (resolvedImage !== resolvedFolder && !resolvedImage.startsWith(resolvedFolder + sep)) {
        // A manifest whose image path escapes its own mod folder - drop it
        // rather than mint a token that would just 403 on request.
        return { ...option, image: undefined }
      }

      return { ...option, image: `${SCHEME}:${encodeToken(resolvedImage)}` }
    }) as Manifest["options"]
  }
}
