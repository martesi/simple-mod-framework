import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DiskManifest } from './diskManifest'

/**
 * Structural validation for a mod folder that already has a manifest.json -
 * "is this folder shaped like a real mod" (existing content/blobs folders
 * are non-empty, option groups make sense), not "will every file in it
 * deploy cleanly" (that's `analyseMod`'s/`deploy`'s job at deploy time, on
 * the framework core - see LEI-134's description for why this manager used
 * to duplicate a much heavier version of this check itself).
 *
 * Ported from `Mod Manager/src/lib/utils.ts`'s `validateModFolder`, trimmed:
 * the old version also ran the full manifest/entity/repository/unlockables/
 * contract/JSON-patch AJV schemas against every JSON file in the mod on every
 * single listing - that's real deploy-time correctness work the framework
 * core already does exhaustively (analyseMod.ts, deploy.ts), not something a
 * mod list needs to re-check on every render.
 */
export function validateModFolder(
  modFolder: string,
  manifest: DiskManifest
): { valid: boolean; error?: string } {
  for (const field of [
    'id',
    'name',
    'description',
    'authors',
    'version',
    'frameworkVersion',
  ] as const) {
    if (manifest[field] === undefined || manifest[field] === null) {
      return { valid: false, error: `Manifest is missing required field "${field}"` }
    }
  }

  const allContentFolders = [
    ...(manifest.contentFolders || []),
    ...(manifest.options || []).flatMap((a) => a.contentFolders || []),
  ]

  for (const contentFolder of allContentFolders) {
    const full = resolve(modFolder, contentFolder)
    if (!existsSync(full)) {
      return {
        valid: false,
        error: `Invalid content folder "${contentFolder}" due to nonexistent path`,
      }
    }

    const chunkFolders = readdirSync(full)
    if (chunkFolders.length === 0) {
      return { valid: false, error: `Empty content folder "${contentFolder}"` }
    }

    for (const chunkFolder of chunkFolders) {
      if (!chunkFolder.match(/chunk([0-9]*)/)) {
        return {
          valid: false,
          error: `Invalid chunk folder "${chunkFolder}" in "${contentFolder}"`,
        }
      }
    }
  }

  const allBlobsFolders = [
    ...(manifest.blobsFolders || []),
    ...(manifest.options || []).flatMap((a) => a.blobsFolders || []),
  ]

  for (const blobsFolder of allBlobsFolders) {
    const full = resolve(modFolder, blobsFolder)
    if (!existsSync(full)) {
      return {
        valid: false,
        error: `Invalid blobs folder "${blobsFolder}" due to nonexistent path`,
      }
    }

    if (readdirSync(full).length === 0) {
      return { valid: false, error: `Empty blobs folder "${blobsFolder}"` }
    }
  }

  const groups: Record<string, { members: number; enabledByDefault: number }> = {}
  for (const option of manifest.options || []) {
    if (option.type === 'select' && option.group) {
      groups[option.group] ??= { members: 0, enabledByDefault: 0 }
      groups[option.group].members++
      if (option.enabledByDefault) groups[option.group].enabledByDefault++
    }
  }

  for (const [group, { members, enabledByDefault }] of Object.entries(groups)) {
    if (members === 1) return { valid: false, error: `Option group "${group}" has only one member` }
    if (enabledByDefault > 1)
      return {
        valid: false,
        error: `Option group "${group}" has more than one member enabled by default`,
      }
  }

  return { valid: true }
}

/** An RPKG-only mod: the folder exists, has no manifest.json, and contains at least one *.rpkg file somewhere under it. */
export function isRpkgOnlyModFolder(modFolder: string): boolean {
  if (!existsSync(modFolder) || existsSync(join(modFolder, 'manifest.json'))) return false
  return walkHasRpkg(modFolder)
}

function walkHasRpkg(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (walkHasRpkg(full)) return true
    } else if (entry.name.toLowerCase().endsWith('.rpkg')) {
      return true
    }
  }
  return false
}
