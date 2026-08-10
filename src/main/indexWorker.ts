import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import JSON5 from 'json5'
import type { DiskManifest } from './diskManifest'
import { FRAMEWORK_VERSION } from './frameworkVersion'
import { invalidManifestFallback, normalizeManifest } from './manifestCompatibility'
import { MANAGED_FOLDER, majorVersion } from './modIndexConstants'
import { validateModFolder } from './validateMod'

/**
 * Worker-thread counterpart to ModIndex.rebuildChunked(). Runs the full Mods/ directory walk
 * entirely off the Electron main thread so the IPC event loop (config:get, system:pickDirectory,
 * deploy:start, etc.) is never blocked while a large collection is being scanned.
 *
 * Protocol:
 *   main → worker  { modsDir: string }
 *   worker → main  { type: "progress", scanned: number, total: number }   (per folder)
 *   worker → main  { type: "done", entries: SerializedIndexEntry[] }       (on success)
 *   worker → main  { type: "error", message: string }                      (on failure)
 *
 * The returned entries match the `IndexedMod` shape ModIndex uses internally so the main process
 * can load them directly into its in-memory map without re-reading any files.
 */

export interface SerializedIndexEntry {
  folder: string
  id: string
  isFrameworkMod: boolean
  manifest?: DiskManifest
  valid?: boolean
  validationError?: string
  outdated?: boolean
}

export type IndexWorkerRequest = { modsDir: string }

export type IndexWorkerMessage =
  | { type: 'progress'; scanned: number; total: number }
  | { type: 'done'; entries: SerializedIndexEntry[] }
  | { type: 'error'; message: string }

if (!parentPort) {
  throw new Error('indexWorker.ts must be run inside a worker thread')
}

const port = parentPort

port.on('message', ({ modsDir }: IndexWorkerRequest) => {
  try {
    const entries: SerializedIndexEntry[] = []

    if (!existsSync(modsDir)) {
      port.postMessage({ type: 'done', entries } satisfies IndexWorkerMessage)
      return
    }

    const folders = readdirSync(modsDir).filter(
      (f) => f !== MANAGED_FOLDER && statSync(join(modsDir, f)).isDirectory()
    )
    const total = folders.length

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i]
      const full = join(modsDir, folder)
      const manifestPath = join(full, 'manifest.json')

      if (existsSync(manifestPath)) {
        try {
          const manifest: DiskManifest = normalizeManifest(
            JSON5.parse(readFileSync(manifestPath, 'utf8'))
          )
          const { valid, error } = validateModFolder(full, manifest)
          const outdated = majorVersion(manifest.frameworkVersion) < majorVersion(FRAMEWORK_VERSION)
          entries.push({
            folder,
            id: manifest.id,
            isFrameworkMod: true,
            manifest,
            valid,
            validationError: error,
            outdated,
          })
        } catch {
          try {
            const fallback = invalidManifestFallback(
              JSON5.parse(readFileSync(manifestPath, 'utf8')),
              folder
            )
            entries.push({
              folder,
              id: folder,
              isFrameworkMod: true,
              manifest: fallback,
              valid: false,
              validationError:
                'Manifest is incompatible with this framework version or has invalid fields.',
            })
          } catch {
            entries.push({ folder, id: folder, isFrameworkMod: false })
          }
        }
      } else {
        entries.push({ folder, id: folder, isFrameworkMod: false })
      }

      port.postMessage({ type: 'progress', scanned: i + 1, total } satisfies IndexWorkerMessage)
    }

    port.postMessage({ type: 'done', entries } satisfies IndexWorkerMessage)
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies IndexWorkerMessage)
  }
})
