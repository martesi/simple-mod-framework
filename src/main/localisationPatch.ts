import type { ManifestOptionData } from "./core/types"

const LANGUAGES = new Set(["english", "french", "italian", "german", "spanish", "russian", "chineseSimplified", "chineseTraditional", "japanese"])

export class LocalisationPatchError extends Error {}

/** Convert a validated localisation.patch.json payload into the engine's override shape. */
export function parseLocalisationPatch(raw: unknown, source = "localisation.patch.json"): NonNullable<ManifestOptionData["localisationOverrides"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LocalisationPatchError(`${source}: expected an object`)
  const input = raw as Record<string, unknown>
  const resourceId = input.resourceId ?? input.resource ?? input.locr
  if (typeof resourceId !== "string" || !/^(?:0x)?[0-9a-f]{16}$/i.test(resourceId)) {
    throw new LocalisationPatchError(`${source}: resourceId must be a 16-digit hexadecimal resource ID`)
  }
  const lines = input.lines
  if (!lines || typeof lines !== "object" || Array.isArray(lines)) throw new LocalisationPatchError(`${source}: lines must be an object`)
  const output: Record<string, Record<string, Record<string, string>>> = { [resourceId.replace(/^0x/i, "").toUpperCase()]: {} }
  const target = output[resourceId.replace(/^0x/i, "").toUpperCase()]!
  for (const [lineId, languagesValue] of Object.entries(lines as Record<string, unknown>)) {
    if (!/^(?:0x)?[0-9a-f]{16}$/i.test(lineId)) throw new LocalisationPatchError(`${source}: invalid line ID "${lineId}"`)
    if (!languagesValue || typeof languagesValue !== "object" || Array.isArray(languagesValue)) throw new LocalisationPatchError(`${source}: line ${lineId} must contain language text values`)
    for (const [language, text] of Object.entries(languagesValue as Record<string, unknown>)) {
      if (!LANGUAGES.has(language)) throw new LocalisationPatchError(`${source}: unsupported language "${language}"`)
      if (typeof text !== "string") throw new LocalisationPatchError(`${source}: ${lineId}.${language} must be text`)
      target[language] ??= {}
      target[language]![lineId.replace(/^0x/i, "").toUpperCase()] = text
    }
  }
  return output as unknown as NonNullable<ManifestOptionData["localisationOverrides"]>
}

export function mergeLocalisationOverrides(target: NonNullable<ManifestOptionData["localisationOverrides"]>, addition: NonNullable<ManifestOptionData["localisationOverrides"]>): void {
  const mutableTarget = target as unknown as Record<string, Record<string, Record<string, string>>>
  const mutableAddition = addition as unknown as Record<string, Record<string, Record<string, string>>>
  for (const [resource, languages] of Object.entries(mutableAddition)) {
    mutableTarget[resource] ??= {}
    for (const [language, lines] of Object.entries(languages)) {
      mutableTarget[resource]![language] ??= {}
      Object.assign(mutableTarget[resource]![language]!, lines)
    }
  }
}
