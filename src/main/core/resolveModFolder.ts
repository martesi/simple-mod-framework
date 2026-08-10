import { getMod } from '../db'
import type { DiskManifest } from '../diskManifest'

export interface ResolvedMod {
  /** The real on-disk folder name under Mods/ - may differ from `mod` if `mod` was an id, not a folder name. */
  folder: string
  isFrameworkMod: boolean
  manifest?: DiskManifest
}

/**
 * Resolves a load-order entry (a manifest `id` for framework mods, or a folder name directly for
 * RPKG-only mods - `ModIndex.indexFolder()` always indexes RPKG-only/malformed mods with `id ===
 * folder`, so a single id-keyed lookup covers both cases) to its actual `Mods/` folder and parsed
 * manifest, straight from `cache.db`'s `mods` table.
 *
 * LEI-141: replaces three independent, byte-for-byte-duplicated implementations of this same
 * resolution that used to live in `discover.ts`, `analyseMod.ts`, and `deploy.ts` - each one doing
 * its own `fs.readdirSync(config.modsPath)` + re-`json5.parse`-every-manifest.json search, once per
 * mod in the load order, every single deploy (O(mods²) manifest reads across the load order, redone
 * independently by all three). `cache.db`'s `mods` table is populated once by `ModIndex` (on launch,
 * on add/remove/update, on an explicit "Rebuild cache") instead of live-walked here - a point lookup
 * against an already-built index rather than a fresh directory scan every time.
 *
 * Returns `undefined` if `mod` isn't in the index at all - this is now a real error condition (a
 * load-order entry cache.db doesn't know about), not "let me go check the filesystem myself"; the
 * fix is an explicit index rebuild (`mods:rebuildIndex`), not a silent live-scan fallback baked into
 * every deploy.
 */
export function resolveModFolder(mod: string): ResolvedMod | undefined {
  const row = getMod(mod)
  if (!row) return undefined

  return { folder: row.folder, isFrameworkMod: row.isFrameworkMod, manifest: row.manifest }
}
