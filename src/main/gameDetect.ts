import { createHash } from "node:crypto"
import { accessSync, constants as fsConstants, copyFileSync, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AppPaths } from "./paths"
import { getStoredGameInfo, setStoredGameInfo, type StoredGameInfo } from "./db"

export type GamePlatform = "steam" | "epic" | "microsoft"

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
	/** The picked "Retail" folder itself, resolved to an absolute path. */
	retailPath: string
	/** Sibling `Runtime/` folder (Steam/Epic) or the nested `Retail/Runtime/` folder (Microsoft Store) - whichever this install actually has. */
	runtimePath: string
	platform: GamePlatform
	/** True if the game build's hash wasn't recognised and `platform` is the patched Steam fallback - mirrors `src/main.ts`'s own "Unknown game version" handling. */
	unrecognisedBuild: boolean
}

export type GamePathDetection = ({ ok: true } & GamePathInfo) | { ok: false; error: string }

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
 * ever declare `supportedPlatforms` in that sense, not a version. (Caveat, unconfirmed and out of
 * scope for this change: some mods may in practice not be as distributor-agnostic as the manifest
 * schema assumes. Also unconfirmed/out of scope: an unrecognised-hash pick silently defaults to
 * `"steam"` - see `GAME_HASHES` below - and with detection now one-shot, a wrong guess at pick-time
 * persists for the life of this cache.db instead of being re-derived fresh next deploy.)
 */
export function deriveGamePathInfo(pickedPath: string, paths: AppPaths): GamePathDetection {
	const stored = getStoredGameInfo()
	if (stored && stored.gamePath === pickedPath) {
		return { ok: true, retailPath: stored.retailPath, runtimePath: stored.runtimePath, platform: stored.platform, unrecognisedBuild: stored.unrecognisedBuild }
	}

	const detection = deriveGamePathInfoUncached(pickedPath, paths)
	if (detection.ok) {
		const { ok: _ok, ...info } = detection
		setStoredGameInfo(pickedPath, info)
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
export function deriveGamePathInfoUncached(pickedPath: string, paths: AppPaths): GamePathDetection {
	let retailPath = resolve(pickedPath)

	// Easy mistake: picking the game's root folder (e.g. ".../common/HITMAN3") instead of the
	// "Retail" folder inside it. For Steam/Epic, that root folder also happens to have a sibling
	// "Runtime/chunk0.rpkg" sitting right next to "Retail/" - which the Microsoft Store layout check
	// below would otherwise misread as "Runtime nested inside the picked folder", sending it looking
	// for a MicrosoftGame.Config that was never going to exist. Quietly step down into "Retail" first,
	// same self-heal spirit as the old core.ts's post-hoc runtimePath fix.
	if (!existsSync(join(retailPath, "HITMAN3.exe")) && existsSync(join(retailPath, "Retail", "HITMAN3.exe"))) {
		retailPath = join(retailPath, "Retail")
	}

	const siblingRuntimePath = resolve(retailPath, "..", "Runtime")
	const nestedRuntimePath = join(retailPath, "Runtime")

	const isMicrosoftLayout = existsSync(join(nestedRuntimePath, "chunk0.rpkg"))
	const runtimePath = isMicrosoftLayout ? nestedRuntimePath : siblingRuntimePath

	if (!isMicrosoftLayout && !existsSync(join(retailPath, "HITMAN3.exe"))) {
		return {
			ok: false,
			error: `HITMAN3.exe couldn't be found under "${retailPath}" - pick your game's root folder (or its Retail subfolder directly).`
		}
	}

	if (!existsSync(runtimePath)) {
		return { ok: false, error: `The Runtime folder couldn't be found at "${runtimePath}".` }
	}

	if (isMicrosoftLayout && !existsSync(join(retailPath, "..", "MicrosoftGame.Config"))) {
		return { ok: false, error: `MicrosoftGame.Config couldn't be found at "${join(retailPath, "..", "MicrosoftGame.Config")}".` }
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

	const hash = isMicrosoftLayout ? md5File(join(retailPath, "..", "MicrosoftGame.Config")) : md5File(join(retailPath, "HITMAN3.exe"))
	const recognisedPlatform = GAME_HASHES[hash]
	// An unrecognised hash (e.g. after a game update) falls back to Steam instead of failing the
	// pick outright, matching src/main.ts's own patched fallback - see PATCH_NOTICE.md there.
	const platform = recognisedPlatform ?? "steam"

	if (isMicrosoftLayout) {
		const cleanThumbsSrc = join(paths.toolsRoot, "cleanMicrosoftThumbs.dat")
		const cleanThumbsDest = join(paths.dataRoot, "cleanThumbs.dat")
		if (!existsSync(cleanThumbsDest) && existsSync(cleanThumbsSrc)) {
			copyFileSync(cleanThumbsSrc, cleanThumbsDest)
		}
	}

	return { ok: true, retailPath, runtimePath, platform, unrecognisedBuild: !recognisedPlatform }
}
