import { createHash } from "node:crypto"
import { accessSync, constants as fsConstants, copyFileSync, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AppPaths } from "./paths"

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
 * Validate a game path (normally the "Retail" folder itself, though a one-level-too-high pick
 * self-heals - see below) and derive `runtimePath`/`platform` from it.
 *
 * This relocates two pieces of logic that used to run reactively, after the fact, once a deploy
 * was already underway:
 *   - `src/core.ts`'s post-hoc `runtimePath` self-heal (detects a Microsoft-Store-shaped layout,
 *     rewrites config.json on disk, copies a different clean-thumbs file)
 *   - `src/main.ts`'s MD5-hash platform detection (hashes `MicrosoftGame.Config`/`HITMAN3.exe`
 *     against a table of known Steam/Epic/Microsoft hashes)
 *
 * into a single validate-and-derive step - see LEI-133's description. Unlike that first version,
 * though, this is *not* a "compute once at pick-time" step: only `gamePath` itself is persisted
 * (see settings.ts), so this runs fresh every time `retailPath`/`runtimePath`/`platform` are
 * actually needed (the directory picker, for immediate feedback; `config:merge`, implicitly, by
 * virtue of nothing being cached; deploy start and analyseMod, to build the embedded `Config` -
 * see ipcHandlers.ts/deployManager.ts/deployPipeline.ts) rather than once, reused, and left to go
 * stale if the game updates or moves.
 */
export function deriveGamePathInfo(pickedPath: string, paths: AppPaths): GamePathDetection {
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
			error: `HITMAN3.exe couldn't be found in "${retailPath}" - pick the game's Retail folder (the one directly containing HITMAN3.exe).`
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

/**
 * The same "which game build is this" hash `deriveGamePathInfo` computes, recomputed at deploy
 * time purely to invalidate the discover/difference cache when the game updates underneath an
 * already-picked, already-valid `retailPath`/`runtimePath` (mirrors `src/main.ts`'s cache-version
 * check) - not for platform detection, which only ever happens once, at pick-time, above.
 */
export function computeGameHash(retailPath: string, runtimePath: string): string {
	return existsSync(join(retailPath, "Runtime", "chunk0.rpkg")) ? md5File(join(retailPath, "..", "MicrosoftGame.Config")) : md5File(join(runtimePath, "..", "Retail", "HITMAN3.exe"))
}
