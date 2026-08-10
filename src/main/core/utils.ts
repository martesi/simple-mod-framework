import path from 'node:path'
import fs from 'fs-extra'
import md5 from 'md5'
import { config, logger, paths, rpkgInstance } from './core-singleton'
import * as quickentity21 from './quickentity'
import * as quickentity3 from './quickentity-3'
import * as quickentityRs from './quickentity-rs'
import * as quickentity20 from './quickentity20'
import * as quickentity1136 from './quickentity1136'
import { freeDiskSpace } from './smf-rust'

const QuickEntity = {
  '0.1': quickentity1136,
  '2.0': quickentity20,
  '2.1': quickentity21,
  '3.0': quickentity3,
  '3.1': quickentityRs,

  '999.999': quickentityRs,
} as unknown as {
  [k: string]: {
    convert: (
      game: string,
      TEMP: string,
      TEMPmeta: string,
      TBLU: string,
      TBLUmeta: string,
      output: string
    ) => Promise<void>
    generate: (
      game: string,
      input: string,
      TEMP: string,
      TEMPmeta: string,
      TBLU: string,
      TBLUmeta: string
    ) => Promise<void>
    applyPatchJSON: (original: string, patch: string, output: string) => Promise<void>
  }
}

const QuickEntityPatch = {
  '0': quickentity1136,
  '3': quickentity20,
  '4': quickentity21,
  '5': quickentity3,
  '6': quickentityRs,

  '999': quickentityRs,
} as unknown as {
  [k: string]: {
    convert: (
      game: string,
      TEMP: string,
      TEMPmeta: string,
      TBLU: string,
      TBLUmeta: string,
      output: string
    ) => Promise<void>
    generate: (
      game: string,
      input: string,
      TEMP: string,
      TEMPmeta: string,
      TBLU: string,
      TBLUmeta: string
    ) => Promise<void>
    applyPatchJSON: (original: string, patch: string, output: string) => Promise<void>
  }
}

// QuickEntity/QuickEntityPatch are static after module init, so their key lists never change -
// compute each once instead of twice per lookup call (Object.keys() + findIndex()'s Object.keys()).
const quickEntityVersionKeys = Object.keys(QuickEntity)
const quickEntityPatchVersionKeys = Object.keys(QuickEntityPatch)

export function getQuickEntityFromVersion(version: string) {
  void logger.verbose(`Getting QuickEntity version from entity version ${version}`)

  return QuickEntity[
    quickEntityVersionKeys[
      quickEntityVersionKeys.findIndex((a) => parseFloat(a) > Number(version)) - 1
    ]
  ]
}

export function getQuickEntityFromPatchVersion(version: string) {
  void logger.verbose(`Getting QuickEntity version from patch version ${version}`)

  return QuickEntityPatch[
    quickEntityPatchVersionKeys[
      quickEntityPatchVersionKeys.findIndex((a) => parseFloat(a) > Number(version)) - 1
    ]
  ]
}

export function hexflip(input: string) {
  let output = ''

  for (let i = input.length; i > 0 / 2; i = i - 2) {
    output += input.substr(i - 2, 2)
  }

  return output
}

/**
 * LEI-142: derives the directory path for a single content cache slot. Must use identical
 * sanitization to `db.ts`'s `clearContentCacheForMod` (which uses the same `replace(/[<>:"/\\|?*]/g, "")`).
 *
 * Layout: `{paths.dataRoot}/content_cache/{safeModId}/{...cachePath segments}/`
 *   - `safeModId`: modId with NTFS-unsafe chars stripped (same as `winPathEscape` but inline to
 *     avoid circular dep: this module is imported by patchWorker threads where `../db` isn't open).
 *   - `cachePath`: already path-safe at every real call site (xxhash3 hex values, alphanumeric
 *     ORES/REPO labels). Path separators (\ and /) become real directory levels via `path.join`.
 *
 * Using `paths.dataRoot` directly (rather than a module var set by `openDb()`) means patchWorker
 * threads pick up the correct root from the core-singleton that `ensureWorkerCore()` initializes -
 * no `openDb()` call needed in the worker.
 */
function contentCacheSlotDir(modId: string, cachePath: string): string {
  const safeModId = modId.replace(/[<>:"/\\|?*]/g, '')
  return path.join(paths.dataRoot, 'content_cache', safeModId, ...cachePath.split(/[/\\]/))
}

export async function extractOrCopyToTemp(
  rpkgOfFile: string,
  file: string,
  type: string,
  stagingChunk = 'chunk0'
) {
  await logger.verbose(`Extract or copy to temp: ${rpkgOfFile} ${file} ${type} ${stagingChunk}`)

  if (!fs.existsSync(path.join(paths.dataRoot, 'staging', stagingChunk, `${file}.${type}`))) {
    await rpkgInstance.callFunction(
      `-extract_from_rpkg "${path.join(config.runtimePath, `${rpkgOfFile}.rpkg`)}" -filter "${file}" -output_path "${path.join(paths.dataRoot, 'temp')}"`
    ) // Extract the file
  } else {
    fs.ensureDirSync(path.join(paths.dataRoot, 'temp', rpkgOfFile, type))
    fs.copyFileSync(
      path.join(paths.dataRoot, 'staging', stagingChunk, `${file}.${type}`),
      path.join(paths.dataRoot, 'temp', rpkgOfFile, type, `${file}.${type}`)
    ) // Use the staging one (for mod compat - one mod can extract, patch and build, then the next can patch that one instead)

    if (fs.existsSync(path.join(paths.dataRoot, 'staging', stagingChunk, `${file}.${type}.meta`))) {
      fs.copyFileSync(
        path.join(paths.dataRoot, 'staging', stagingChunk, `${file}.${type}.meta`),
        path.join(paths.dataRoot, 'temp', rpkgOfFile, type, `${file}.${type}.meta`)
      )
    }
  }
}

/**
 * LEI-142: content artifacts are stored as loose files under `{paths.dataRoot}/content_cache/`
 * (content-addressed by mod id + cache path) rather than as SQLite BLOBs. Restores the cached
 * directory tree to `outputPath` via `fs.copySync`, which creates `outputPath` if missing and
 * merges if it exists - same "merge contents into dest" semantics as the old SQLite restore.
 *
 * Works in patchWorker threads without `openDb()` because it reads `paths.dataRoot` from the
 * core-singleton (set by `ensureWorkerCore()`) rather than from a module-level var in `db.ts`.
 */
export async function copyFromCache(mod: string, cachePath: string, outputPath: string) {
  const slotDir = contentCacheSlotDir(mod, cachePath)
  if (await fs.pathExists(slotDir)) {
    await fs.copy(slotDir, outputPath)
    await logger.verbose(`Cache hit: ${mod} ${cachePath} ${outputPath}`)
    return true
  }

  await logger.verbose(`No cache hit: ${mod} ${cachePath} ${outputPath}`)

  return false
}

export async function copyToCache(mod: string, originalPath: string, cachePath: string) {
  if (
    (await fs.pathExists(originalPath)) &&
    (await freeDiskSpace(paths.dataRoot)) / 1024 / 1024 / 1024 > 5
  ) {
    await logger.verbose(`Copy to cache: ${mod} ${originalPath} ${cachePath}`)

    const slotDir = contentCacheSlotDir(mod, cachePath)
    await fs.remove(slotDir) // clear old slot before overwriting (single-slot, no accumulation)
    await fs.copy(originalPath, slotDir)
    return true
  }

  await logger.verbose(`Not enough space/nonexistent path: ${mod} ${originalPath} ${cachePath}`)

  return false
}

/** Whether {@link copyFromCache} would hit, without actually restoring anything. */
export async function contentCacheExists(mod: string, cachePath: string): Promise<boolean> {
  return fs.pathExists(contentCacheSlotDir(mod, cachePath))
}

/**
 * Copies `src` to `dest` via a same-directory temp file + rename (LEI-151), instead of a direct
 * overwrite - so a crash/kill mid-copy never leaves `dest` truncated. Concurrent readers (the
 * game, Steam's "verify integrity") only ever see either the fully-intact old `dest` or the
 * fully-written new one.
 *
 * The temp file is derived from `dest` itself (not some shared scratch dir) because
 * `fs.renameSync` is only atomic within a single volume, and `dest` here is always either a path
 * inside the game install or `dataRoot/Output` - both same-volume as themselves, but not
 * necessarily the same volume as this app's own dataRoot/staging.
 */
export function atomicCopyFileSync(src: string, dest: string): void {
  const tmpDest = `${dest}.tmp`

  try {
    fs.copyFileSync(src, tmpDest)
    fs.renameSync(tmpDest, dest)
  } catch (err) {
    try {
      fs.removeSync(tmpDest)
    } catch {
      // Best-effort cleanup of our own half-written temp file - don't mask the original error.
    }

    throw err
  }
}

export function winPathEscape(str: string) {
  return str
    .replace(/</gi, '')
    .replace(/>/gi, '')
    .replace(/:/gi, '')
    .replace(/"/gi, '')
    .replace(/\//gi, '')
    .replace(/\\/gi, '')
    .replace(/"/gi, '')
    .replace(/\|/gi, '')
    .replace(/\?/gi, '')
    .replace(/\*/gi, '')
}

export function isValidHash(hash: string) {
  return /\b[a-fA-F0-9]{16}$\b/g.test(hash)
}

export function normaliseToHash(hashOrPath: string) {
  return isValidHash(hashOrPath)
    ? hashOrPath
    : `00${md5(hashOrPath.toLowerCase()).slice(2, 16).toUpperCase()}`
}
