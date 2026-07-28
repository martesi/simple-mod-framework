import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { randomUUID } from "node:crypto"
import JSON5 from "json5"
import type { AppPaths } from "./paths"
import { extractArchive } from "./archive"
import { ModIndex, ensureModsDir } from "./modIndex"
import { validateModFolder } from "./validateMod"
import type { DiskManifest } from "./diskManifest"
import type { ModTaskStatus } from "../renderer/src/lib/ipc"

export interface TaskEmit {
  (update: { status: ModTaskStatus; message?: string; modId?: string }): void
}

const ARCHIVE_EXTENSIONS = new Set([".zip", ".7z", ".rar"])

function sanitizeFolderName(name: string): string {
  // Windows-illegal filename characters, including control characters, trimmed of trailing dots/spaces.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "mod"
}

function findRpkgFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...findRpkgFiles(full))
    else if (entry.name.toLowerCase().endsWith(".rpkg")) results.push(full)
  }
  return results
}

function chunkNameFor(filePath: string): string {
  const match = filePath.match(/chunk[0-9]*/i)
  return match ? match[0] : "chunk0"
}

/**
 * Runs one add-mod pipeline end to end (extract -> detect layout -> validate
 * -> copy into Mods/ -> index/config write-through), reporting progress via
 * `emit`. Ported from `Mod Manager/src/routes/modList/+page.svelte`'s
 * `addMod()`/`installRPKGMod()`, with two deliberate changes:
 *
 *   - runs against a per-task staging folder (`tmp/<taskId>/`) instead of a
 *     single shared `./staging` - the old app only ever had one add running
 *     at a time (a modal blocked a second), but this contract's `beginAdd`
 *     is explicitly non-blocking per file (see ipc.ts's doc comment), so two
 *     concurrent adds must not stomp on the same staging directory.
 *   - never shells out through a hand-built command string (see archive.ts).
 */
export async function runAddModTask(paths: AppPaths, modsDir: string, index: ModIndex, taskId: string, sourceFilePath: string, sourceFileName: string, emit: TaskEmit): Promise<void> {
  const staging = join(paths.dataRoot, "tmp", taskId)

  try {
    emit({ status: "queued" })

    ensureModsDir(modsDir)
    mkdirSync(staging, { recursive: true })

    const ext = extname(sourceFileName).toLowerCase()

    if (ext === ".rpkg") {
      await installRpkgMod(modsDir, index, sourceFilePath, sourceFileName, emit)
      return
    }

    if (!ARCHIVE_EXTENSIONS.has(ext)) {
      emit({ status: "error", message: "This doesn't look like a mod - expected a .zip, .7z, .rar, or .rpkg file." })
      return
    }

    emit({ status: "extracting" })
    await extractArchive(paths, sourceFilePath, staging)

    const topLevel = readdirSync(staging).filter((f) => statSync(join(staging, f)).isDirectory())

    if (topLevel.length > 0 && topLevel.every((f) => existsSync(join(staging, f, "manifest.json")))) {
      await installFrameworkMods(modsDir, index, staging, topLevel, emit)
      return
    }

    const rpkgFiles = findRpkgFiles(staging)
    if (rpkgFiles.length > 0) {
      await installExtractedRpkgFiles(modsDir, index, sourceFileName, rpkgFiles, emit)
      return
    }

    emit({ status: "error", message: "The archive doesn't contain a recognizable framework mod (folder with manifest.json) or any .rpkg files." })
  } catch (error) {
    emit({ status: "error", message: error instanceof Error ? error.message : String(error) })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function installFrameworkMods(modsDir: string, index: ModIndex, staging: string, folders: string[], emit: TaskEmit): Promise<void> {
  emit({ status: "validating" })

  const manifests: DiskManifest[] = []
  for (const folder of folders) {
    let manifest: DiskManifest
    try {
      manifest = JSON5.parse(readFileSync(join(staging, folder, "manifest.json"), "utf8"))
    } catch {
      emit({ status: "error", message: `"${folder}" has an invalid manifest.json (not valid JSON).` })
      return
    }

    if (index.has(manifest.id)) {
      emit({ status: "error", message: `"${manifest.name || manifest.id}" is already installed (same mod ID).` })
      return
    }

    const { valid, error } = validateModFolder(join(staging, folder), manifest)
    if (!valid) {
      emit({ status: "error", message: `"${manifest.name || folder}" failed validation: ${error}` })
      return
    }

    manifests.push(manifest)
  }

  emit({ status: "installing" })

  for (const folder of folders) {
    cpSync(join(staging, folder), join(modsDir, folder), { recursive: true })
  }

  index.addFolders(folders)

  emit({ status: "done", modId: manifests.length === 1 ? manifests[0].id : undefined })
}

async function installExtractedRpkgFiles(modsDir: string, index: ModIndex, sourceFileName: string, rpkgFiles: string[], emit: TaskEmit): Promise<void> {
  emit({ status: "validating" })

  const rpkgModName = sanitizeFolderName(basename(sourceFileName, extname(sourceFileName)))
  const destFolder = join(modsDir, rpkgModName)

  if (index.has(rpkgModName) || existsSync(destFolder)) {
    emit({ status: "error", message: `"${rpkgModName}" is already installed (same destination folder).` })
    return
  }

  emit({ status: "installing" })

  for (const file of rpkgFiles) {
    const chunk = chunkNameFor(file)
    const destDir = join(destFolder, chunk)
    mkdirSync(destDir, { recursive: true })
    cpSync(file, join(destDir, basename(file)))
  }

  index.addFolders([rpkgModName])
  emit({ status: "done", modId: rpkgModName })
}

async function installRpkgMod(modsDir: string, index: ModIndex, sourceFilePath: string, sourceFileName: string, emit: TaskEmit): Promise<void> {
  const rpkgModName = sanitizeFolderName(basename(sourceFileName, extname(sourceFileName)))
  const destFolder = join(modsDir, rpkgModName)

  if (index.has(rpkgModName) || existsSync(destFolder)) {
    emit({ status: "error", message: `"${rpkgModName}" is already installed (same destination folder).` })
    return
  }

  emit({ status: "validating" })
  const chunk = chunkNameFor(sourceFileName)

  emit({ status: "installing" })
  const destDir = join(destFolder, chunk)
  mkdirSync(destDir, { recursive: true })
  cpSync(sourceFilePath, join(destDir, basename(sourceFilePath)))

  index.addFolders([rpkgModName])
  emit({ status: "done", modId: rpkgModName })
}

export function newTaskId(): string {
  return randomUUID()
}

/**
 * Deletes a mod's folder from disk and its index entry. Rejecting this while
 * a deploy is active is enforced by the caller (ipcHandlers.ts, via the
 * DeployManager) - Deploy.exe reads mod folders throughout a run, not just
 * at the start, so deleting one mid-deploy can corrupt it (see ipc.ts's doc
 * comment).
 */
export function removeModFolder(modsDir: string, index: ModIndex, id: string): void {
  const folder = index.folderFor(id)
  if (folder && existsSync(folder)) {
    rmSync(folder, { recursive: true, force: true })
  }
  index.remove(id)
  void modsDir
}
