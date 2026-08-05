/** In-game text languages a mod's assets can target, matching new-ui/Mod Manager.dc.html's LANGUAGES list. */
export interface LanguageOption {
  code: string
  label: string
}

// Trimmed to the one locale this app's own Lingui catalog actually ships (see lingui.config.js)
// - the full LANGUAGES list above (fr-FR/de-DE/es-ES/...) predates the i18n work and was never
// wired into deploy.ts anyway (see configMapping.ts's toUiConfig()/fromUiPatch() - `language` is a
// pure UI preference, round-tripped to settings.json and nothing else). Re-add entries here once
// their catalogs actually exist under src/renderer/src/locales.
export const LANGUAGES: LanguageOption[] = [{ code: "en-US", label: "English (US)" }]
