export const GAME_PLATFORMS = ['steam', 'epic', 'microsoft'] as const

export type GamePlatform = (typeof GAME_PLATFORMS)[number]

export function isGamePlatform(value: unknown): value is GamePlatform {
  return typeof value === 'string' && GAME_PLATFORMS.includes(value as GamePlatform)
}
