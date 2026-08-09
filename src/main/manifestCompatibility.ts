import { major, valid, validRange } from "semver"
import type { DiskManifest, DiskManifestOption } from "./diskManifest"
import type { ModReference } from "../shared/manifest"
import { FRAMEWORK_VERSION } from "./frameworkVersion"
import { toHttpsUrl } from "../shared/urls"

export const MANIFEST_NORMALIZATION_VERSION = "1"

const LANGUAGES = [
  "english",
  "french",
  "italian",
  "german",
  "spanish",
  "russian",
  "chineseSimplified",
  "chineseTraditional",
  "japanese"
] as const

const LANGUAGE_SET = new Set<string>(LANGUAGES)
const REFERENCE_FIELDS = ["requirements", "incompatibilities", "loadBefore", "loadAfter"] as const
const LEGACY_PLATFORMS = ["steam", "epic", "microsoft"] as const
const LEGACY_PLATFORM_SET = new Set<string>(LEGACY_PLATFORMS)

type JsonObject = Record<string, unknown>

/** A compatibility failure tied to an exact manifest field. */
export class ManifestCompatibilityError extends Error {
  readonly name = "ManifestCompatibilityError"

  constructor(
    readonly path: string,
    readonly userMessage: string
  ) {
    super(`${path}: ${userMessage}`)
  }
}

function fail(path: string, message: string): never {
  throw new ManifestCompatibilityError(path, message)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function expectObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) fail(path, "must be an object")
  return value
}

function normalizeAliases(source: JsonObject): JsonObject {
  const normalized = { ...source }

  // New spellings are authoritative when both spellings occur in the same representation.
  if (Object.hasOwn(normalized, "blobFolders")) normalized.blobsFolders = normalized.blobFolders
  if (Object.hasOwn(normalized, "packageDefinition")) normalized.packagedefinition = normalized.packageDefinition
  delete normalized.blobFolders
  delete normalized.packageDefinition

  return normalized
}

/** Flatten a v3 `data` object over legacy fields while retaining unrelated legacy properties. */
function flattenData(value: unknown, path: string): JsonObject {
  const source = expectObject(value, path)
  const { data, ...outer } = source
  const legacy = normalizeAliases(outer)

  if (data === undefined) return legacy
  const modern = normalizeAliases(expectObject(data, `${path}.data`))
  return { ...legacy, ...modern }
}

function normalizeLocalisation(value: unknown, path: string): DiskManifest["localisation"] {
  const source = expectObject(value, path)
  const keys = Object.keys(source)
  if (keys.length === 0) return {}

  const languageKeys = keys.filter((key) => LANGUAGE_SET.has(key))
  if (languageKeys.length > 0 && languageKeys.length !== keys.length) {
    fail(path, "mixes language-first and string-first localisation")
  }

  const output: NonNullable<DiskManifest["localisation"]> = {}
  if (languageKeys.length === keys.length) {
    for (const language of keys) {
      const strings = expectObject(source[language], `${path}.${language}`)
      for (const [id, text] of Object.entries(strings)) {
        if (typeof text !== "string") fail(`${path}.${language}.${id}`, "must be a string")
      }
      output[language] = { ...strings } as Record<string, string>
    }
    return output
  }

  for (const [id, translationsValue] of Object.entries(source)) {
    const translations = expectObject(translationsValue, `${path}.${id}`)
    for (const [language, text] of Object.entries(translations)) {
      if (!LANGUAGE_SET.has(language)) fail(`${path}.${id}.${language}`, `uses unsupported language "${language}"`)
      if (typeof text !== "string") fail(`${path}.${id}.${language}`, "must be a string")
      output[language] ??= {}
      output[language]![id] = text
    }
  }

  return output
}

function canonicalRange(value: unknown, path: string): string {
  if (value === undefined || value === "") return "*"
  if (typeof value !== "string") fail(path, "must be a semantic-version range")

  const range = value.trim() || "*"
  if (!validRange(range)) fail(path, `contains invalid semantic-version range "${value}"`)
  return valid(range) ? `^${range}` : range
}

/** Accept legacy strings/tuples, v3 `Mod.ID@range`, and already-normalized references. */
export function normalizeModReference(value: unknown, path = "$.reference"): ModReference {
  let id: unknown
  let range: unknown

  if (typeof value === "string") {
    const separator = value.indexOf("@")
    if (separator === -1) {
      id = value
    } else {
      id = value.slice(0, separator)
      range = value.slice(separator + 1)
    }
  } else if (Array.isArray(value)) {
    if (value.length !== 2) fail(path, "legacy reference tuples must contain exactly an ID and range")
    ;[id, range] = value
  } else if (isObject(value)) {
    id = value.id
    range = value.range
  } else {
    fail(path, "must be a mod ID, Mod.ID@range, tuple, or reference object")
  }

  if (typeof id !== "string" || !id.trim()) fail(`${path}.id`, "must be a non-empty mod ID")
  return { id: id.trim(), range: canonicalRange(range, `${path}.range`) }
}

function normalizeReferences(value: unknown, path: string): ModReference[] {
  if (!Array.isArray(value)) fail(path, "must be an array")
  return value.map((reference, index) => normalizeModReference(reference, `${path}[${index}]`))
}

function normalizePlatforms(value: unknown, path: string): DiskManifest["supportedPlatforms"] {
  if (!Array.isArray(value)) fail(path, "must be an array")
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== "string") fail(`${path}[${index}]`, "must be a platform string")
    if (/^h[12](?:-|$)/.test(value[index] as string)) fail(`${path}[${index}]`, `targets unsupported HITMAN version "${value[index]}"`)
  }

  // Presence of a v3 platform makes that representation authoritative over legacy store names.
  const hasV3Platforms = value.some((platform) => typeof platform === "string" && /^h3(?:-|$)/.test(platform))
  const selected = hasV3Platforms ? value.filter((platform) => typeof platform === "string" && /^h3(?:-|$)/.test(platform)) : value
  const output: (typeof LEGACY_PLATFORMS)[number][] = []

  for (let index = 0; index < selected.length; index++) {
    const platform = selected[index] as string
    let mapped: readonly (typeof LEGACY_PLATFORMS)[number][]
    if (platform === "h3") mapped = LEGACY_PLATFORMS
    else if (platform.startsWith("h3-") && LEGACY_PLATFORM_SET.has(platform.slice(3))) mapped = [platform.slice(3) as (typeof LEGACY_PLATFORMS)[number]]
    else if (LEGACY_PLATFORM_SET.has(platform)) mapped = [platform as (typeof LEGACY_PLATFORMS)[number]]
    else fail(`${path}[${index}]`, `uses unsupported platform "${platform}"`)

    for (const item of mapped) if (!output.includes(item)) output.push(item)
  }

  return output
}

function normalizeScope(value: unknown, path: string): JsonObject {
  const normalized = flattenData(value, path)

  if (normalized.localisation !== undefined) normalized.localisation = normalizeLocalisation(normalized.localisation, `${path}.localisation`)
  if (normalized.supportedPlatforms !== undefined) normalized.supportedPlatforms = normalizePlatforms(normalized.supportedPlatforms, `${path}.supportedPlatforms`)
  for (const field of REFERENCE_FIELDS) {
    if (normalized[field] !== undefined) normalized[field] = normalizeReferences(normalized[field], `${path}.${field}`)
  }

  return normalized
}

function validateRequiredFields(manifest: JsonObject): void {
  for (const field of ["id", "name", "description", "version", "frameworkVersion"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) fail(`$.${field}`, "must be a non-empty string")
  }
  if (/[/\\]/.test(manifest.id as string) || manifest.id === "." || manifest.id === "..") {
    fail("$.id", "must be a single safe mod identifier without path separators")
  }
  if (!Array.isArray(manifest.authors) || manifest.authors.length === 0 || manifest.authors.some((author) => typeof author !== "string" || !author.trim())) {
    fail("$.authors", "must be a non-empty array of author names")
  }

  if (!valid(manifest.version as string)) fail("$.version", `must be a valid semantic version (received "${manifest.version}")`)
  if (!valid(manifest.frameworkVersion as string)) fail("$.frameworkVersion", `must be a valid semantic version (received "${manifest.frameworkVersion}")`)
  if (major(manifest.frameworkVersion as string) > major(FRAMEWORK_VERSION)) {
    fail("$.frameworkVersion", `targets framework ${manifest.frameworkVersion}, but this build supports framework major ${major(FRAMEWORK_VERSION)} (${FRAMEWORK_VERSION})`)
  }
}

/**
 * Converts accepted legacy/v3 manifest syntax into the v2.33.40 engine's canonical shape.
 * The input is never mutated and unrelated fields are preserved.
 */
export function normalizeManifest(raw: unknown): DiskManifest {
  const manifest = normalizeScope(raw, "$")
  validateRequiredFields(manifest)

  if (manifest.url !== undefined) {
    const url = toHttpsUrl(manifest.url)
    if (!url) fail("$.url", "must be an absolute HTTPS URL")
    manifest.url = url
  }

  if (manifest.options !== undefined) {
    if (!Array.isArray(manifest.options)) fail("$.options", "must be an array")
    manifest.options = manifest.options.map((option, index) => normalizeScope(option, `$.options[${index}]`) as unknown as DiskManifestOption)
  }

  return manifest as unknown as DiskManifest
}

/** Safe display metadata for a folder that contains a parsed-but-incompatible manifest. */
export function invalidManifestFallback(raw: unknown, folder: string): DiskManifest {
  const source = isObject(raw) ? raw : {}
  const stringOr = (field: string, fallback: string): string => (typeof source[field] === "string" && source[field].trim() ? source[field] : fallback)
  const authors = Array.isArray(source.authors) ? source.authors.filter((author): author is string => typeof author === "string") : []

  return {
    id: folder,
    name: stringOr("name", stringOr("id", folder)),
    description: stringOr("description", "This mod has an invalid manifest and cannot be enabled."),
    authors,
    version: stringOr("version", "0.0.0"),
    frameworkVersion: stringOr("frameworkVersion", "0.0.0")
  }
}
