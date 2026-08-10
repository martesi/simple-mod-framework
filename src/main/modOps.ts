import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import JSON5 from 'json5'
import type { ModTaskStatus } from '../renderer/src/lib/ipc'
import { extractArchive } from './archive'
import type { DiskManifest } from './diskManifest'
import { ManifestCompatibilityError, normalizeManifest } from './manifestCompatibility'
import { ensureModsDir, type ModIndex } from './modIndex'
import { addNewlyKnownMods } from './modsConfig'
import type { AppPaths } from './paths'
import { validateModFolder } from './validateMod'

export type TaskEmit = (update: { status: ModTaskStatus; message?: string; modId?: string }) => void

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar'])

function sanitizeFolderName(name: string): string {
  // Windows-illegal filename characters, including control characters, trimmed of trailing dots/spaces.
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'mod'
}

function findRpkgFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...findRpkgFiles(full))
    else if (entry.name.toLowerCase().endsWith('.rpkg')) results.push(full)
  }
  return results
}

function chunkNameFor(filePath: string): string {
  const match = filePath.match(/chunk[0-9]*/i)
  return match ? match[0] : 'chunk0'
}

/**
 * Runs one add-mod pipeline end to end (extract -> detect layout -> validate
 * -> copy into Mods/ -> index/config write-through), reporting progress via
 * `emit`. Ported from `Mod Manager/src/routes/modList/+page.svelte`'s
 * `addMod()`/`installRPKGMod()`, with two deliberate changes:
 *
 *   - runs against a per-task staging folder (`<tempDir>/tmp/<taskId>/`) instead of a
 *     single shared `./staging` - the old app only ever had one add running
 *     at a time (a modal blocked a second), but this contract's `beginAdd`
 *     is explicitly non-blocking per file (see ipc.ts's doc comment), so two
 *     concurrent adds must not stomp on the same staging directory.
 *   - never shells out through a hand-built command string (see archive.ts).
 */
export async function runAddModTask(
  paths: AppPaths,
  tempDir: string,
  modsDir: string,
  index: ModIndex,
  taskId: string,
  sourceFilePath: string,
  sourceFileName: string,
  emit: TaskEmit
): Promise<void> {
  const staging = join(tempDir, 'tmp', taskId)

  try {
    emit({ status: 'queued' })

    ensureModsDir(modsDir)
    mkdirSync(staging, { recursive: true })

    const ext = extname(sourceFileName).toLowerCase()

    if (ext === '.rpkg') {
      await installRpkgMod(modsDir, index, sourceFilePath, sourceFileName, emit)
      return
    }

    if (!ARCHIVE_EXTENSIONS.has(ext)) {
      emit({
        status: 'error',
        message: "This doesn't look like a mod - expected a .zip, .7z, .rar, or .rpkg file.",
      })
      return
    }

    emit({ status: 'extracting' })
    await extractArchive(paths, sourceFilePath, staging)

    const topLevel = readdirSync(staging).filter((f) => statSync(join(staging, f)).isDirectory())

    // v3-style archives may place manifest.json at the archive root. Install the archive contents
    // into the canonical manifest ID folder, after validating the destination and manifest before
    // copying anything. Wrapper-folder archives continue through the legacy multi-mod path below.
    if (existsSync(join(staging, 'manifest.json'))) {
      await installRootManifest(modsDir, index, staging, emit)
      return
    }

    if (
      topLevel.length > 0 &&
      topLevel.every((f) => existsSync(join(staging, f, 'manifest.json')))
    ) {
      await installFrameworkMods(modsDir, index, staging, topLevel, emit)
      return
    }

    const rpkgFiles = findRpkgFiles(staging)
    if (rpkgFiles.length > 0) {
      await installExtractedRpkgFiles(modsDir, index, sourceFileName, rpkgFiles, emit)
      return
    }

    emit({
      status: 'error',
      message:
        "The archive doesn't contain a recognizable framework mod (folder with manifest.json) or any .rpkg files.",
    })
  } catch (error) {
    emit({ status: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function installRootManifest(
  modsDir: string,
  index: ModIndex,
  staging: string,
  emit: TaskEmit
): Promise<void> {
  emit({ status: 'validating' })
  let manifest: DiskManifest
  try {
    manifest = normalizeManifest(JSON5.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')))
  } catch (error) {
    const message =
      error instanceof ManifestCompatibilityError
        ? `${error.path}: ${error.userMessage}`
        : 'manifest.json is not valid JSON.'
    emit({ status: 'error', message })
    return
  }

  const destination = join(modsDir, manifest.id)
  if (index.has(manifest.id) || existsSync(destination)) {
    emit({
      status: 'error',
      message: `"${manifest.name || manifest.id}" is already installed (same mod ID or destination folder).`,
    })
    return
  }
  const { valid, error } = validateModFolder(staging, manifest)
  if (!valid) {
    emit({
      status: 'error',
      message: `"${manifest.name || manifest.id}" failed validation: ${error}`,
    })
    return
  }

  emit({ status: 'installing' })
  cpSync(staging, destination, { recursive: true })
  index.addFolders([manifest.id])
  addNewlyKnownMods(modsDir, [{ id: manifest.id, manifest }])
  emit({ status: 'done', modId: manifest.id })
}

async function installFrameworkMods(
  modsDir: string,
  index: ModIndex,
  staging: string,
  folders: string[],
  emit: TaskEmit
): Promise<void> {
  emit({ status: 'validating' })

  const manifests: DiskManifest[] = []
  const seenIds = new Set<string>()
  for (const folder of folders) {
    let manifest: DiskManifest
    try {
      manifest = normalizeManifest(
        JSON5.parse(readFileSync(join(staging, folder, 'manifest.json'), 'utf8'))
      )
    } catch {
      emit({
        status: 'error',
        message: `"${folder}" has an invalid manifest.json (not valid JSON).`,
      })
      return
    }

    if (index.has(manifest.id) || seenIds.has(manifest.id) || existsSync(join(modsDir, folder))) {
      emit({
        status: 'error',
        message: `"${manifest.name || manifest.id}" is already installed (same mod ID).`,
      })
      return
    }

    const { valid, error } = validateModFolder(join(staging, folder), manifest)
    if (!valid) {
      emit({ status: 'error', message: `"${manifest.name || folder}" failed validation: ${error}` })
      return
    }

    manifests.push(manifest)
    seenIds.add(manifest.id)
  }

  emit({ status: 'installing' })

  for (const folder of folders) {
    cpSync(join(staging, folder), join(modsDir, folder), { recursive: true })
  }

  index.addFolders(folders)
  // Register every installed ID (not just the single-mod case the "done" emit's modId covers) -
  // see modsConfig.ts's addNewlyKnownMods() doc comment for why this has to happen here and not be left
  // implicit in the index write-through above. Passing each manifest along (not just its id) is what
  // lets addNewlyKnownMods() seed a sane default modOptions entry for mods that ship options, instead of
  // leaving them silently unselected until someone opens the options drawer.
  addNewlyKnownMods(
    modsDir,
    manifests.map((m) => ({ id: m.id, manifest: m }))
  )

  emit({ status: 'done', modId: manifests.length === 1 ? manifests[0].id : undefined })
}

async function installExtractedRpkgFiles(
  modsDir: string,
  index: ModIndex,
  sourceFileName: string,
  rpkgFiles: string[],
  emit: TaskEmit
): Promise<void> {
  emit({ status: 'validating' })

  const rpkgModName = sanitizeFolderName(basename(sourceFileName, extname(sourceFileName)))
  const destFolder = join(modsDir, rpkgModName)

  if (index.has(rpkgModName) || existsSync(destFolder)) {
    emit({
      status: 'error',
      message: `"${rpkgModName}" is already installed (same destination folder).`,
    })
    return
  }

  emit({ status: 'installing' })

  for (const file of rpkgFiles) {
    const chunk = chunkNameFor(file)
    const destDir = join(destFolder, chunk)
    mkdirSync(destDir, { recursive: true })
    cpSync(file, join(destDir, basename(file)))
  }

  index.addFolders([rpkgModName])
  addNewlyKnownMods(modsDir, [{ id: rpkgModName }])
  emit({ status: 'done', modId: rpkgModName })
}

async function installRpkgMod(
  modsDir: string,
  index: ModIndex,
  sourceFilePath: string,
  sourceFileName: string,
  emit: TaskEmit
): Promise<void> {
  const rpkgModName = sanitizeFolderName(basename(sourceFileName, extname(sourceFileName)))
  const destFolder = join(modsDir, rpkgModName)

  if (index.has(rpkgModName) || existsSync(destFolder)) {
    emit({
      status: 'error',
      message: `"${rpkgModName}" is already installed (same destination folder).`,
    })
    return
  }

  emit({ status: 'validating' })
  const chunk = chunkNameFor(sourceFileName)

  emit({ status: 'installing' })
  const destDir = join(destFolder, chunk)
  mkdirSync(destDir, { recursive: true })
  cpSync(sourceFilePath, join(destDir, basename(sourceFilePath)))

  index.addFolders([rpkgModName])
  addNewlyKnownMods(modsDir, [{ id: rpkgModName }])
  emit({ status: 'done', modId: rpkgModName })
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
