import type { HttpsUrl } from "../../../shared/urls"

export type { HttpsUrl } from "../../../shared/urls"

/**
 * Mirrors the shapes in `src/types.ts` at the repo root (the framework core's
 * Manifest/Config types) that the Mod Manager UI actually needs to render.
 *
 * This is intentionally a subset - the UI only reads/writes these fields, it
 * never runs the deploy pipeline. Kept in its own file (rather than importing
 * the root `src/types.ts` directly) so this package can be built and typechecked
 * fully standalone, independent of the framework core project.
 */

export enum OptionType {
  checkbox = "checkbox",
  select = "select",
  conditional = "conditional"
}

export type ManifestOption = {
  name: string
  tooltip?: string
  /** Relative path to a thumbnail image inside the mod folder. */
  image?: string
} & (
  | { type: OptionType.checkbox; enabledByDefault?: boolean }
  | { type: OptionType.select; group: string; enabledByDefault?: boolean }
  | { type: OptionType.conditional; condition: string }
)

export interface Manifest {
  id: string
  name: string
  description: string
  authors: string[]
  version: string
  frameworkVersion: string
  /** HTTPS page published by the mod author. Opened only in the system browser. */
  url?: HttpsUrl
  options?: ManifestOption[]
}

/** A mod entry as the Mod Manager sees it - either a framework mod (has a manifest) or a bare RPKG-only mod. */
export interface ModEntry {
  /** Folder name inside Mods/ - doubles as the mod ID for framework mods. */
  id: string
  isFrameworkMod: boolean
  manifest?: Manifest
  /** Set only for RPKG-only mods (isFrameworkMod === false). */
  rpkgModName?: string
  /** True if this mod is built against an old major framework version and needs a one-click upgrade. */
  outdated?: boolean
  /** False if validateModFolder-equivalent checks would fail (missing files, bad manifest, etc). */
  valid?: boolean
  validationError?: string
}

export interface Config {
  /** IDs of enabled mods only, in deploy order - this is the shape the real deploy pipeline cares about. */
  loadOrder: string[]
  /**
   * Display/drag order for *every* known mod, enabled or not (UI-only concept -
   * lets a disabled mod keep the shelf position it was dragged to, so it slots
   * back into the same spot in `loadOrder` if re-enabled later).
   */
  modOrder: string[]
  knownMods: string[]
  /** modId -> list of enabled option names ("optionName" for checkboxes, "group:optionName" for selects). */
  modOptions: Record<string, string[]>
  developerMode: boolean
  reportErrors?: boolean
  themeMode: "light" | "dark" | "system"
  accent: "neutral" | "blue" | "violet" | "green" | "red"
  /** Folder containing the game's Retail executable. */
  gamePath: string
  /** Where extracted RPKG data and intermediate build files are stored. */
  cachePath: string
  /** The folder the manager scans for mods to load. */
  modPath: string
  /** In-game text language code (e.g. "en-US") mods should target. */
  language: string
}

/**
 * Example paths the UI shows as placeholder text (Settings' Paths card, the setup wizard) -
 * computed on the main side (`settings.ts`'s `resolveDefaultUiPaths()`) rather than hardcoded here,
 * since `cachePath`/`modPath` are real paths under this app's actual `dataRoot` (and so already
 * carry the real logged-in username) - a plain string literal in the renderer couldn't do that.
 */
export interface DefaultPaths {
  gamePath: string
  cachePath: string
  modPath: string
}
