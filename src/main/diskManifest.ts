/**
 * The parts of a mod's manifest.json this manager's main process needs to
 * read off disk - a superset of the UI's trimmed `Manifest`
 * (`renderer/src/lib/manifest-types.ts`, LEI-137) that also carries the
 * fields `validateModFolder`-equivalent checks need (contentFolders,
 * blobsFolders, per-option folders) but the renderer never displays.
 *
 * Mirrors `src/types.ts`'s real `Manifest`/`ManifestOptionData` at the repo
 * root, trimmed to what this manager reads. Not imported directly for the
 * same "build standalone" reason as manifest-types.ts.
 */

import type { ModReference } from '../shared/manifest'
import type { HttpsUrl } from '../shared/urls'

export type { ModReference } from '../shared/manifest'

export type DiskModReference = ModReference

export type DiskLanguage =
  | 'english'
  | 'french'
  | 'italian'
  | 'german'
  | 'spanish'
  | 'russian'
  | 'chineseSimplified'
  | 'chineseTraditional'
  | 'japanese'

export interface DiskCompatibilityData {
  supportedPlatforms?: ('steam' | 'epic' | 'microsoft')[]
  requirements?: DiskModReference[]
  incompatibilities?: DiskModReference[]
  loadBefore?: DiskModReference[]
  loadAfter?: DiskModReference[]
}

export interface DiskManifestOption extends DiskCompatibilityData {
  [field: string]: unknown
  name: string
  type: 'checkbox' | 'select' | 'conditional'
  group?: string
  enabledByDefault?: boolean
  tooltip?: string
  image?: string
  condition?: string
  contentFolders?: string[]
  blobsFolders?: string[]
  localisation?: Partial<Record<DiskLanguage, Record<string, string>>>
  localisationOverrides?: Record<string, Partial<Record<DiskLanguage, Record<string, string>>>>
  localisedLines?: Record<string, string>
  packagedefinition?: unknown[]
  thumbs?: string[]
  dependencies?: unknown[]
  peacockPlugins?: string[]
  scripts?: string[]
}

export interface DiskManifest extends DiskCompatibilityData {
  [field: string]: unknown
  id: string
  name: string
  description: string
  authors: string[]
  version: string
  frameworkVersion: string
  updateCheck?: string
  url?: HttpsUrl
  contentFolders?: string[]
  blobsFolders?: string[]
  localisation?: Partial<Record<DiskLanguage, Record<string, string>>>
  localisationOverrides?: Record<string, Partial<Record<DiskLanguage, Record<string, string>>>>
  localisedLines?: Record<string, string>
  packagedefinition?: unknown[]
  thumbs?: string[]
  dependencies?: unknown[]
  peacockPlugins?: string[]
  scripts?: string[]
  options?: DiskManifestOption[]
}
