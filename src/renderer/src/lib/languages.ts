/** In-game text languages a mod's assets can target, matching new-ui/Mod Manager.dc.html's LANGUAGES list. */
export interface LanguageOption {
  code: string
  label: string
}

export const LANGUAGES: LanguageOption[] = [
  { code: "en-US", label: "English" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "es-ES", label: "Spanish" },
  { code: "it-IT", label: "Italian" },
  { code: "ja-JP", label: "Japanese" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "ru-RU", label: "Russian" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "ko-KR", label: "Korean" },
  { code: "pl-PL", label: "Polish" }
]
