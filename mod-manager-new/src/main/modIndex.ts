import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import JSON5 from "json5"
import type { ModEntry, Manifest } from "../renderer/src/lib/manifest-types"
import type { DiskManifest } from "./diskManifest"
import { isRpkgOnlyModFolder, validateModFolder } from "./validateMod"
import { rewriteManifestImages } from "./modImages"

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

interface IndexedMod {
  /** Folder name under Mods/. */
  folder: string
  id: string
  isFrameworkMod: boolean
  manifest?: DiskManifest
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
 * Holds the mod list in memory for the lifetime of the main process, rebuilt
 * from disk on `rebuild()` and kept in sync afterwards by `addFolders()` /
 * `remove()` write-throughs - no disk-persisted cache file (unlike the old
 * `Mod Manager/src/lib/utils.ts`'s MOD_INDEX_CACHE_FILE).
 *
 * That cache existed (LEI-96) because the old renderer re-derived everything
 * from scratch on every single navigation reload. That problem doesn't exist
 * here: this index lives in the long-lived main process instead of the
 * renderer, so it's naturally built once per app launch and pushed to
 * whichever screens need it over IPC - see LEI-134's description ("Main can
 * hold the mod index in memory once ... instead of each reload re-deriving
 * it from disk").
 */
export class ModIndex {
  private byId = new Map<string, IndexedMod>()
  private built = false

  constructor(private getModsDir: () => string) {}

  private ensureBuilt(): void {
    if (!this.built) this.rebuild()
  }

  rebuild(): void {
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
  }

  private indexFolder(modsDir: string, folder: string): void {
    const full = join(modsDir, folder)
    const manifestPath = join(full, "manifest.json")

    if (existsSync(manifestPath)) {
      try {
        const manifest: DiskManifest = JSON5.parse(readFileSync(manifestPath, "utf8"))
        this.byId.set(manifest.id, { folder, id: manifest.id, isFrameworkMod: true, manifest })
        return
      } catch {
        // malformed manifest - fall through to treat it as a bare/broken folder below
      }
    }

    this.byId.set(folder, { folder, id: folder, isFrameworkMod: false })
  }

  /** Write-through for folders this manager just extracted into Mods/ itself - avoids re-walking the whole directory. */
  addFolders(folderNames: string[]): void {
    this.ensureBuilt()
    const modsDir = this.getModsDir()
    for (const folder of folderNames) {
      this.indexFolder(modsDir, folder)
    }
  }

  remove(id: string): void {
    this.ensureBuilt()
    this.byId.delete(id)
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
    if (entry) entry.manifest = manifest
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
      const { valid, error } = validateModFolder(folder, manifest)
      const outdated = majorOf(manifest.frameworkVersion) < majorOf(CURRENT_FRAMEWORK_VERSION)

      return {
        id: entry.id,
        isFrameworkMod: true,
        manifest: rewriteManifestImages(toUiManifest(manifest), entry.id, folder),
        outdated,
        valid,
        validationError: error
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
