import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { Worker } from "node:worker_threads"
import JSON5 from "json5"
import type { ModEntry, Manifest } from "../renderer/src/lib/manifest-types"
import type { DiskManifest } from "./diskManifest"
import { isRpkgOnlyModFolder, validateModFolder } from "./validateMod"
import { rewriteManifestImages } from "./modImages"
import type { IndexWorkerMessage, IndexWorkerRequest, SerializedIndexEntry } from "./indexWorker"

/**
 * Resolves the on-disk path to indexWorker.cjs bundled next to this file - mirrors
 * DeployManager's own resolveDeployWorkerPath() (see deployManager.ts).
 */
function resolveIndexWorkerPath(): string {
  let currentDir = __dirname
  while (true) {
    for (const name of ["indexWorker.cjs", "indexWorker.js"]) {
      const candidate = resolve(currentDir, name)
      try {
        require.resolve(candidate)
        return candidate
      } catch {
        // Try next candidate
      }
    }
    const parentDir = resolve(currentDir, "..")
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }
  return resolve(__dirname, "indexWorker.cjs")
}

/**
 * The major version this build of the manager targets - mods whose
 * manifest declares an older major `frameworkVersion` are flagged
 * `outdated` (one-click-upgrade candidates in the UI). Intentionally a
 * small local constant rather than importing `src/core.ts`'s
 * `FrameworkVersion` - that module has CLI-only side effects (Sentry init,
 * reading argv) that have no place in an Electron main process, and this
 * package is meant to build standalone (see manifest-types.ts).
 */
export const CURRENT_FRAMEWORK_VERSION = "3.0.0"

const MANAGED_FOLDER = "Managed by SMF, do not touch"

/** Exported so indexWorker.ts can use the same shape and main can load the result directly. */
export interface IndexedMod {
  /** Folder name under Mods/. */
  folder: string
  id: string
  isFrameworkMod: boolean
  manifest?: DiskManifest
  /**
   * Cached `validateModFolder()`/outdated results for framework mods - computed once when the
   * folder is (re)indexed (`indexFolder()`, `writeManifest()`) rather than recomputed on every
   * `list()` call. `validateModFolder()` walks the mod's content/blobs folders on disk
   * (readdirSync per folder) - with "many mods" installed, redoing that on every single `list()`
   * (which happens after every add/remove/toggle-driven refresh, not just at cold start) was real,
   * repeated, avoidable disk I/O. None of it can change without the folder itself changing, which
   * only happens through indexFolder()/writeManifest() - both recompute this eagerly.
   */
  valid?: boolean
  validationError?: string
  outdated?: boolean
}

function majorOf(version: string): number {
  const n = Number.parseInt(version.split(".")[0], 10)
  return Number.isFinite(n) ? n : 0
}

function toUiManifest(m: DiskManifest): Manifest {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    authors: m.authors,
    version: m.version,
    frameworkVersion: m.frameworkVersion,
    updateCheck: m.updateCheck,
    options: m.options?.map((o) => ({
      name: o.name,
      tooltip: o.tooltip,
      image: o.image,
      ...(o.type === "select" ? { type: "select" as const, group: o.group!, enabledByDefault: o.enabledByDefault } : {}),
      ...(o.type === "checkbox" ? { type: "checkbox" as const, enabledByDefault: o.enabledByDefault } : {}),
      ...(o.type === "conditional" ? { type: "conditional" as const, condition: o.condition! } : {})
    })) as Manifest["options"]
  }
}

/**
 * Holds the mod list in memory for the lifetime of the main process, and now also mirrors it to a
 * single JSON file on disk (`<dataRoot>/cache/modIndex.json`) so a normal launch doesn't have to
 * re-walk `Mods/` at all.
 *
 * The old `Mod Manager/src/lib/utils.ts` MOD_INDEX_CACHE_FILE was removed (LEI-96/LEI-134) because
 * the renderer back then had no way to keep it in sync - it just re-derived everything from disk
 * on every navigation reload, so a stale cache file could silently diverge from reality with no
 * path back to correctness short of deleting it by hand. That risk doesn't apply the same way here:
 * every mutation this app makes to `Mods/` already goes through one of a small number of write-through
 * methods on this class (`addFolders()`, `remove()`, `writeManifest()`, `reindexOne()`, plus a full
 * `rebuildChunked()`/`rebuildInWorker()`), and every one of them now re-persists the cache file as
 * part of the same call. The only way the on-disk index can drift from reality is a change made to
 * `Mods/` from *outside* this app entirely (hand-copying a folder in, editing a manifest with a text
 * editor) - which is exactly what the explicit "Rebuild cache" action (`mods:rebuildIndex`) exists
 * to fix, same as it always did.
 *
 * `loadOrRebuild()` is what a normal launch calls: read the persisted file (a handful of
 * milliseconds, no directory walk) and only fall back to a full `rebuildInWorker()` scan if there
 * isn't one yet (first-ever launch) or it fails to parse.
 */
export class ModIndex {
  private byId = new Map<string, IndexedMod>()
  private built = false

  constructor(
    private getModsDir: () => string,
    private dataRoot: string
  ) {}

  private cachePath(): string {
    return join(this.dataRoot, "cache", "modIndex.json")
  }

  /** Best-effort load of the persisted index - returns false (and leaves `byId` untouched) if there's no cache file yet or it's unreadable/malformed. */
  private tryLoadPersistedCache(): boolean {
    try {
      const raw = readFileSync(this.cachePath(), "utf8")
      const entries = JSON.parse(raw) as SerializedIndexEntry[]
      if (!Array.isArray(entries)) return false
      this.loadFromEntries(entries)
      return true
    } catch {
      return false
    }
  }

  /**
   * Write-through: mirrors the current in-memory index to disk. Called at the end of every method
   * that mutates `byId`, so the persisted cache is never more than one IPC call stale. Best-effort -
   * a failed write (e.g. disk full) shouldn't take down mod management; worst case the next launch
   * just falls back to a full rescan.
   */
  private persistCache(): void {
    try {
      mkdirSync(dirname(this.cachePath()), { recursive: true })
      writeFileSync(this.cachePath(), JSON.stringify([...this.byId.values()]))
    } catch {
      // Best-effort - see doc comment above.
    }
  }

  /** True once a scan (sync or chunked) has populated the index at least once this launch. */
  get isBuilt(): boolean {
    return this.built
  }

  private ensureBuilt(): void {
    if (!this.built) this.scanSync()
  }

  /**
   * Synchronous fallback for callers that need the index built *right now* and can't await
   * anything (folderFor()/manifestFor()/has()/addFolders()/remove(), all via ensureBuilt() above).
   * Tries the persisted cache first (cheap); only does a real synchronous disk walk if there isn't
   * one yet. In normal operation neither path actually runs here: the app always calls mods:list on
   * launch first, which awaits loadOrRebuild() below before anything else touches the index, so
   * `built` is already true by the time any of those run.
   */
  private scanSync(): void {
    if (this.tryLoadPersistedCache()) return

    this.byId.clear()

    const modsDir = this.getModsDir()
    if (!existsSync(modsDir)) {
      this.built = true
      return
    }

    const folders = readdirSync(modsDir).filter((f) => f !== MANAGED_FOLDER && statSync(join(modsDir, f)).isDirectory())

    for (const folder of folders) {
      this.indexFolder(modsDir, folder)
    }

    this.built = true
    this.persistCache()
  }

  /**
   * The normal launch path (mods:list's first call this session - see ipcHandlers.ts): read the
   * persisted cache written by a previous launch/action instead of walking `Mods/` at all. Falls
   * back to a full `rebuildInWorker()` scan only when there's no cache yet (first-ever launch) or it
   * fails to parse - that scan persists its own result, so this is a one-time cost, not a
   * per-launch one.
   */
  async loadOrRebuild(onProgress?: (scanned: number, total: number) => void): Promise<void> {
    if (this.tryLoadPersistedCache()) {
      this.built = true
      return
    }

    await this.rebuildInWorker(onProgress)
  }

  /**
   * Same full disk walk as scanSync(), but chunked with periodic event-loop yields and an optional
   * progress callback. The main process is single-threaded - a synchronous walk of a Mods/ folder
   * with hundreds of entries (each a readdirSync + statSync + a manifest.json read/JSON5.parse)
   * would otherwise freeze every other IPC channel (config:get, system:pickDirectory, all of it) for
   * as long as the scan takes, which is exactly what used to make the whole renderer look hung
   * behind App.tsx's "Loading Mod Manager..." screen while a cache rebuild ran. Always does a fresh
   * scan regardless of `built`, so it doubles as both the cold-start build (mods:list, first call)
   * and the explicit "Rebuild cache" action (mods:rebuildIndex) - see ipcHandlers.ts.
   */
  async rebuildChunked(onProgress?: (scanned: number, total: number) => void): Promise<void> {
    this.byId.clear()

    const modsDir = this.getModsDir()
    if (!existsSync(modsDir)) {
      this.built = true
      return
    }

    const folders = readdirSync(modsDir).filter((f) => f !== MANAGED_FOLDER && statSync(join(modsDir, f)).isDirectory())
    const total = folders.length

    for (let i = 0; i < folders.length; i++) {
      this.indexFolder(modsDir, folders[i])
      onProgress?.(i + 1, total)

      // Yield to the event loop every 20 folders - frequent enough that other IPC handlers (and the
      // progress broadcast itself) actually get a turn during a big scan, infrequent enough that it
      // doesn't meaningfully slow the scan down with scheduling overhead.
      if ((i + 1) % 20 === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    this.built = true
    this.persistCache()
  }

  /**
   * Same full scan as rebuildChunked(), but runs the entire Mods/ directory walk in a
   * `node:worker_threads` Worker thread so the Electron main process event loop is completely free
   * for other IPC (config:get, deploy:start, etc.) while a large collection is being scanned.
   * Progress messages are forwarded from the worker to `onProgress` on the main thread as they
   * arrive, so the renderer still gets live "scanned N of M" updates via the mods:cacheProgress
   * broadcast (see ipcHandlers.ts).
   *
   * Falls back to rebuildChunked() if the worker file can't be located at runtime (e.g. in tests
   * or when running from source without a build step).
   */
  async rebuildInWorker(onProgress?: (scanned: number, total: number) => void): Promise<void> {
    const modsDir = this.getModsDir()

    return new Promise<void>((resolve, reject) => {
      let worker: Worker
      try {
        worker = new Worker(resolveIndexWorkerPath())
      } catch {
        // Worker file missing (e.g. running tests directly from source) - fall back gracefully.
        void this.rebuildChunked(onProgress).then(resolve, reject)
        return
      }

      worker.on("message", (msg: IndexWorkerMessage) => {
        if (msg.type === "progress") {
          onProgress?.(msg.scanned, msg.total)
        } else if (msg.type === "done") {
          this.loadFromEntries(msg.entries)
          this.persistCache()
          void worker.terminate()
          resolve()
        } else if (msg.type === "error") {
          void worker.terminate()
          reject(new Error(msg.message))
        }
      })

      worker.on("error", (err) => {
        void worker.terminate()
        reject(err)
      })

      const req: IndexWorkerRequest = { modsDir }
      worker.postMessage(req)
    })
  }

  /**
   * Populates the in-memory map directly from pre-computed entries returned by the index worker,
   * avoiding any further disk I/O on the main thread. Equivalent to running indexFolder() for each
   * entry but without re-reading any files.
   */
  private loadFromEntries(entries: SerializedIndexEntry[]): void {
    this.byId.clear()
    for (const entry of entries) {
      this.byId.set(entry.id, entry as IndexedMod)
    }
    this.built = true
  }

  private indexFolder(modsDir: string, folder: string): void {
    const full = join(modsDir, folder)
    const manifestPath = join(full, "manifest.json")

    if (existsSync(manifestPath)) {
      try {
        const manifest: DiskManifest = JSON5.parse(readFileSync(manifestPath, "utf8"))
        this.byId.set(manifest.id, { folder, id: manifest.id, isFrameworkMod: true, manifest, ...this.validate(full, manifest) })
        return
      } catch {
        // malformed manifest - fall through to treat it as a bare/broken folder below
      }
    }

    this.byId.set(folder, { folder, id: folder, isFrameworkMod: false })
  }

  /** Runs the disk-touching validity/outdated checks once - see IndexedMod's doc comment for why this is cached rather than called from list(). */
  private validate(folder: string, manifest: DiskManifest): { valid: boolean; validationError?: string; outdated: boolean } {
    const { valid, error } = validateModFolder(folder, manifest)
    const outdated = majorOf(manifest.frameworkVersion) < majorOf(CURRENT_FRAMEWORK_VERSION)
    return { valid, validationError: error, outdated }
  }

  /** Write-through for folders this manager just extracted into Mods/ itself - avoids re-walking the whole directory. */
  addFolders(folderNames: string[]): void {
    this.ensureBuilt()
    const modsDir = this.getModsDir()
    for (const folder of folderNames) {
      this.indexFolder(modsDir, folder)
    }
    this.persistCache()
  }

  /**
   * Re-reads one already-known mod's manifest.json fresh from disk and updates just that entry -
   * `mods:updateOutdated`'s narrow case (LEI-98 stopgap: no real auto-updater yet, this just
   * reflects whatever's on disk right now). A mod's outdated/validation status can only ever change
   * by editing *that mod's own* manifest.json, so there's no reason clicking "Update" on one mod
   * should pay for a full `rebuildChunked()` walk of every other mod too - with a large collection,
   * that full rebuild is exactly what made clicking the outdated badge feel like it froze the app,
   * for a re-check that only ever needed one folder's worth of disk I/O. Returns `undefined` if the
   * id isn't (or is no longer) in the index at all.
   */
  reindexOne(id: string): ModEntry | undefined {
    this.ensureBuilt()
    const entry = this.byId.get(id)
    if (!entry) return undefined

    this.indexFolder(this.getModsDir(), entry.folder)
    this.persistCache()
    return this.list().find((m) => m.id === id)
  }

  remove(id: string): void {
    this.ensureBuilt()
    this.byId.delete(id)
    this.persistCache()
  }

  folderFor(id: string): string | undefined {
    this.ensureBuilt()
    const entry = this.byId.get(id)
    return entry ? resolve(this.getModsDir(), entry.folder) : undefined
  }

  manifestFor(id: string): DiskManifest | undefined {
    this.ensureBuilt()
    return this.byId.get(id)?.manifest
  }

  /** Persist a manifest edit (e.g. option image path from the option editor) back to disk and the in-memory index. */
  writeManifest(id: string, manifest: DiskManifest): void {
    this.ensureBuilt()
    const folder = this.folderFor(id)
    if (!folder) throw new Error(`Couldn't find mod ${id}`)
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest, undefined, "\t"))
    const entry = this.byId.get(id)
    if (entry) {
      entry.manifest = manifest
      Object.assign(entry, this.validate(folder, manifest))
    }
    this.persistCache()
  }

  list(): ModEntry[] {
    this.ensureBuilt()
    const modsDir = this.getModsDir()

    return [...this.byId.values()].map((entry): ModEntry => {
      if (!entry.isFrameworkMod) {
        return { id: entry.id, isFrameworkMod: false, rpkgModName: entry.folder }
      }

      const manifest = entry.manifest!
      const folder = resolve(modsDir, entry.folder)

      return {
        id: entry.id,
        isFrameworkMod: true,
        manifest: rewriteManifestImages(toUiManifest(manifest), entry.id, folder),
        outdated: entry.outdated,
        valid: entry.valid,
        validationError: entry.validationError
      }
    })
  }

  has(id: string): boolean {
    this.ensureBuilt()
    return this.byId.has(id)
  }
}

/** Used by the RPKG-only-mod detection path when a folder hasn't been indexed yet (e.g. right after an extract, before addFolders() runs). */
export function looksLikeRpkgMod(folder: string): boolean {
  return isRpkgOnlyModFolder(folder)
}

export function ensureModsDir(modsDir: string): void {
  if (!existsSync(modsDir)) mkdirSync(modsDir, { recursive: true })
}

export function removeModFolderFromDisk(folder: string): void {
  rmSync(folder, { recursive: true, force: true })
}

export function folderNameOf(path: string): string {
  return basename(path)
}
