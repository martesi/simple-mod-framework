import { accessSync, constants as fsConstants, copyFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AppPaths } from "./paths"
import { getStoredGameInfo, setStoredGameInfo, type StoredGameInfo } from "./db"
import { isGamePlatform, type GamePlatform } from "../shared/game"

export type { GamePlatform } from "../shared/game"

export const UNKNOWN_GAME_PLATFORM_ERROR = "The game's storefront could not be inferred. Choose Steam, Epic, or Microsoft in Settings before deploying."
export const INVALID_GAME_PATH_ERROR = "No valid game folder is set - open Settings and pick your game's root folder first."

const STEAM_MARKERS = ["steam_api64.dll", "steam_api.dll"]
const EPIC_MARKERS = ["EOSSDK-Win64-Shipping.dll", "EOSSDK-Win32-Shipping.dll"]

export interface GamePathInfo {
	/** The install's normalized `Retail` folder, resolved to an absolute path. */
	retailPath: string
	/** Sibling `Runtime/` folder (Steam/Epic) or the nested `Retail/Runtime/` folder (Microsoft Store) - whichever this install actually has. */
	runtimePath: string
	/** The inferred storefront, or the user's explicit selection. */
	platform?: GamePlatform
}

export type GamePathDetection = ({ ok: true } & GamePathInfo) | { ok: false; error: string }

export type KnownGamePathInfo = GamePathInfo & { platform: GamePlatform }

export function hasKnownGamePlatform(detection: GamePathDetection): detection is { ok: true } & KnownGamePathInfo {
	return detection.ok && detection.platform !== undefined
}

export function gamePathDetectionError(detection: GamePathDetection): string {
	return detection.ok ? UNKNOWN_GAME_PLATFORM_ERROR : detection.error || INVALID_GAME_PATH_ERROR
}

/**
 * LEI-141: game/distributor detection is now one-shot. `deriveGamePathInfoUncached()` below (the
 * validate-and-derive step LEI-133 introduced) still does the real filesystem/layout work, but it's
 * now only ever actually invoked when `gamePath` is set or changed - not "every time
 * retailPath/runtimePath/platform are needed" as LEI-133 originally had it (deploy start, analyseMod,
 * the picker - all used to redundantly re-derive the same install layout on every deploy).
 *
 * The *result* is persisted to `cache.db`'s `game_info` row (`db.ts`) instead - `deriveGamePathInfo()`
 * below is the cached entry point everything else should call: it returns the stored result
 * immediately if one exists for the current `gamePath`, and only falls through to a real re-derive
 * (updating the stored row) if `gamePath` doesn't match what was last detected, or nothing's stored
 * yet. Once detected, a result is **never rechecked** just because time passed or the game updated
 * underneath it - the framework only cares about distributor (Steam/Epic/Microsoft), and mods only
 * ever declare `supportedPlatforms` in that sense, not a version. The user-selected platform always
 * takes precedence over the best-effort filesystem hint.
 */

export function deriveGamePathInfo(pickedPath: string, paths: AppPaths, selectedPlatform?: GamePlatform): GamePathDetection {
	const normalizedGamePath = resolve(pickedPath)
	const explicitPlatform = isGamePlatform(selectedPlatform) ? selectedPlatform : undefined
	const stored = getStoredGameInfo()
	if (stored && stored.gamePath === normalizedGamePath) {
		const platform = explicitPlatform ?? stored.platform
		if (platform !== stored.platform) {
			const info: GamePathInfo = { retailPath: stored.retailPath, runtimePath: stored.runtimePath, platform }
			setStoredGameInfo(normalizedGamePath, info)
			return { ok: true, ...info }
		}

		return { ok: true, retailPath: stored.retailPath, runtimePath: stored.runtimePath, platform: stored.platform }
	}

	const detection = deriveGamePathInfoUncached(normalizedGamePath, paths)
	if (detection.ok) {
		const { ok: _ok, ...detected } = detection
		const info: GamePathInfo = { ...detected, platform: explicitPlatform ?? detected.platform }
		setStoredGameInfo(normalizedGamePath, info)
		return { ok: true, ...info }
	}

	return detection
}

/** Whatever was last detected and persisted, with no attempt to re-derive or validate it's still current. */
export function getCachedGameInfo(): StoredGameInfo | undefined {
	return getStoredGameInfo()
}

/**
 * The real validate-and-derive step (LEI-133's original `deriveGamePathInfo`, unchanged) - does the
 * actual filesystem checks and storefront hints. Called at most once per distinct `gamePath` (see
 * {@link deriveGamePathInfo} above) instead of on every deploy/analyseMod/picker call.
 */
export function deriveGamePathInfoUncached(pickedPath: string, paths: AppPaths, options: { prepareMicrosoftThumbs?: boolean } = {}): GamePathDetection {
	let retailPath = resolve(pickedPath)

	// Easy mistake: picking the game's root folder (e.g. ".../common/HITMAN3") instead of the
	// "Retail" folder inside it. For Steam/Epic, that root folder also happens to have a sibling
	// "Runtime/chunk0.rpkg" sitting right next to "Retail/" - which the Microsoft Store layout check
	// below would otherwise misread as "Runtime nested inside the picked folder", sending it looking
	// for a MicrosoftGame.Config that was never going to exist. Quietly step down into "Retail" first,
	// same self-heal spirit as the old core.ts's post-hoc runtimePath fix.
	if (
		!existsSync(join(retailPath, "HITMAN3.exe")) &&
		(existsSync(join(retailPath, "Retail", "HITMAN3.exe")) || existsSync(join(retailPath, "Retail", "Runtime", "chunk0.rpkg")))
	) {
		retailPath = join(retailPath, "Retail")
	}

	const siblingRuntimePath = resolve(retailPath, "..", "Runtime")
	const nestedRuntimePath = join(retailPath, "Runtime")

	const hasNestedRuntime = existsSync(join(nestedRuntimePath, "chunk0.rpkg"))
	const microsoftConfigPath = join(retailPath, "..", "MicrosoftGame.Config")
	const isMicrosoftLayout = hasNestedRuntime && existsSync(microsoftConfigPath)
	const runtimePath = isMicrosoftLayout ? nestedRuntimePath : siblingRuntimePath

	if (hasNestedRuntime && !existsSync(microsoftConfigPath) && !existsSync(join(retailPath, "HITMAN3.exe"))) {
		return { ok: false, error: `MicrosoftGame.Config couldn't be found at "${microsoftConfigPath}".` }
	}

	if (!isMicrosoftLayout && !existsSync(join(retailPath, "HITMAN3.exe"))) {
		return {
			ok: false,
			error: `HITMAN3.exe couldn't be found under "${retailPath}" - pick your game's root folder (or its Retail subfolder directly).`
		}
	}

	if (!existsSync(runtimePath)) {
		return { ok: false, error: `The Runtime folder couldn't be found at "${runtimePath}".` }
	}

	// Only the Microsoft Store layout needs this check (matches src/main.ts:118-124) - thumbs.dat
	// there has to be read/re-encrypted from a bundled clean copy rather than the game's own file
	// (see the cleanMicrosoftThumbs.dat copy below), so it needs to actually be accessible.
	if (isMicrosoftLayout) {
		try {
			accessSync(join(retailPath, "thumbs.dat"), fsConstants.R_OK | fsConstants.W_OK)
		} catch {
			return {
				ok: false,
				error: `thumbs.dat couldn't be accessed at "${join(retailPath, "thumbs.dat")}" - try running the Mod Manager as administrator.`
			}
		}
	}

	if (isMicrosoftLayout && options.prepareMicrosoftThumbs !== false) {
		const cleanThumbsSrc = join(paths.toolsRoot, "cleanMicrosoftThumbs.dat")
		const cleanThumbsDest = join(paths.dataRoot, "cleanThumbs.dat")
		if (!existsSync(cleanThumbsDest) && existsSync(cleanThumbsSrc)) {
			try {
				copyFileSync(cleanThumbsSrc, cleanThumbsDest)
			} catch {
				return { ok: false, error: `The manager couldn't prepare a clean thumbs.dat copy at "${cleanThumbsDest}".` }
			}
		}
	}

	return { ok: true, retailPath, runtimePath, platform: inferPlatform(pickedPath, retailPath, isMicrosoftLayout) }
}

/**
 * Returns a best-effort storefront hint. These markers are deliberately advisory: the wizard and
 * Settings always let the user override them, and no game-build/version table needs maintenance.
 */
function inferPlatform(pickedPath: string, retailPath: string, isMicrosoftLayout: boolean): GamePlatform | undefined {
	if (isMicrosoftLayout) return "microsoft"

	const hasSteamMarker = STEAM_MARKERS.some((marker) => existsSync(join(retailPath, marker)))
	const hasEpicMarker = EPIC_MARKERS.some((marker) => existsSync(join(retailPath, marker)))
	if (hasSteamMarker !== hasEpicMarker) return hasSteamMarker ? "steam" : "epic"
	if (hasSteamMarker && hasEpicMarker) return undefined

	const paths = [pickedPath, retailPath].map((value) => value.toLowerCase().replaceAll("\\", "/"))
	const hasSteamPath = paths.some((value) => /(^|\/)steamapps(\/|$)/.test(value))
	const hasEpicPath = paths.some((value) => /(^|\/)epic games(\/|$)/.test(value))
	if (hasSteamPath !== hasEpicPath) return hasSteamPath ? "steam" : "epic"

	return undefined
}
