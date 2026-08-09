import { createHash } from "node:crypto"
import { accessSync, constants as fsConstants, copyFileSync, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AppPaths } from "./paths"
import { getStoredGameInfo, setStoredGameInfo, type StoredGameInfo } from "./db"
import { isGamePlatform, type GamePlatform } from "../shared/game"

export type { GamePlatform } from "../shared/game"

export const UNKNOWN_GAME_PLATFORM_ERROR = "This game build is not recognised. Choose Steam, Epic, or Microsoft in Settings before deploying."
export const INVALID_GAME_PATH_ERROR = "No valid game folder is set - open Settings and pick your game's root folder first."

/**
 * md5 hashes of known game builds, keyed to which storefront they belong to. Ported from
 * `src/main.ts`'s `gameHashes` table (the CLI's own copy of the same detection) rather than
 * imported, to keep this app's path/platform detection self-contained the same way
 * `validateMod.ts` and (pre-LEI-133) `diskConfig.ts` already do - see settings.ts's doc comment.
 */
const GAME_HASHES: Record<string, GamePlatform> = {
	"b894cfa2f11b6db52db587a21de688b2": "epic", // base game
	"6ce4ebfdd9e22e179206281d818850f5": "epic", // ansel unlock
	"4f1b7753a40359bde5d4aa013257c5f1": "steam", // base game
	"406865e7486cbc3b77a5f22fd73fbe00": "steam", // ansel unlock

	// Gamepass/store protects the EXE from reading so we can't hash it, instead we hash the game config
	"cfdf300263b03d625099226882eafe84": "microsoft"
}

function md5File(path: string): string {
	return createHash("md5").update(readFileSync(path)).digest("hex")
}

export interface GamePathInfo {
	/** The install's normalized `Retail` folder, resolved to an absolute path. */
	retailPath: string
	/** Sibling `Runtime/` folder (Steam/Epic) or the nested `Retail/Runtime/` folder (Microsoft Store) - whichever this install actually has. */
	runtimePath: string
	/** The detected storefront, or the user's explicit selection for an unrecognised build. */
	platform?: GamePlatform
	/** True if the game build's hash was not recognised by this app's bundled hash table. */
	unrecognisedBuild: boolean
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
 * validate-and-derive step LEI-133 introduced) still does the real filesystem/hash work, but it's
 * now only ever actually invoked when `gamePath` is set or changed - not "every time
 * retailPath/runtimePath/platform are needed" as LEI-133 originally had it (deploy start, analyseMod,
 * the picker - all used to redundantly re-derive, and `deriveGamePathInfo`/`computeGameHash` in the
 * pre-LEI-141 version of this file both independently MD5-hashed the same exe every single deploy).
 *
 * The *result* is persisted to `cache.db`'s `game_info` row (`db.ts`) instead - `deriveGamePathInfo()`
 * below is the cached entry point everything else should call: it returns the stored result
 * immediately if one exists for the current `gamePath`, and only falls through to a real re-derive
 * (updating the stored row) if `gamePath` doesn't match what was last detected, or nothing's stored
 * yet. Once detected, a result is **never rechecked** just because time passed or the game updated
 * underneath it - the framework only cares about distributor (Steam/Epic/Microsoft), and mods only
 * ever declare `supportedPlatforms` in that sense, not a version. An unrecognised build is retained
 * as an incomplete detection until the user explicitly chooses its storefront; it is never silently
 * treated as Steam.
 */

export function deriveGamePathInfo(pickedPath: string, paths: AppPaths, selectedPlatform?: GamePlatform): GamePathDetection {
	const normalizedGamePath = resolve(pickedPath)
	const explicitPlatform = isGamePlatform(selectedPlatform) ? selectedPlatform : undefined
	const stored = getStoredGameInfo()
	if (stored && stored.gamePath === normalizedGamePath) {
		const platform = stored.platform ?? (stored.unrecognisedBuild ? explicitPlatform : undefined)
		if (platform !== stored.platform) {
			const info: GamePathInfo = { retailPath: stored.retailPath, runtimePath: stored.runtimePath, platform, unrecognisedBuild: stored.unrecognisedBuild }
			setStoredGameInfo(normalizedGamePath, info)
			return { ok: true, ...info }
		}

		return { ok: true, retailPath: stored.retailPath, runtimePath: stored.runtimePath, platform: stored.platform, unrecognisedBuild: stored.unrecognisedBuild }
	}

	const detection = deriveGamePathInfoUncached(normalizedGamePath, paths)
	if (detection.ok) {
		const { ok: _ok, ...detected } = detection
		const info: GamePathInfo = { ...detected, platform: detected.platform ?? (detected.unrecognisedBuild ? explicitPlatform : undefined) }
		setStoredGameInfo(normalizedGamePath, info)
		return { ok: true, ...info }
	}

	return detection
}

/** Whatever was last detected and persisted, with no attempt to re-derive or validate it's still current - for callers (e.g. a rebuild-from-scratch check) that just want to know "do we already have a game pick recorded" without paying for a re-derive. */
export function getCachedGameInfo(): StoredGameInfo | undefined {
	return getStoredGameInfo()
}

/**
 * The real validate-and-derive step (LEI-133's original `deriveGamePathInfo`, unchanged) - does the
 * actual filesystem checks and MD5 hash lookup. Called at most once per distinct `gamePath` (see
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

	let hash: string
	try {
		hash = isMicrosoftLayout ? md5File(join(retailPath, "..", "MicrosoftGame.Config")) : md5File(join(retailPath, "HITMAN3.exe"))
	} catch {
		return { ok: false, error: `The game build file couldn't be read under "${retailPath}".` }
	}
	const recognisedPlatform = GAME_HASHES[hash]

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

	return { ok: true, retailPath, runtimePath, platform: recognisedPlatform, unrecognisedBuild: !recognisedPlatform }
}
