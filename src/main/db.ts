import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DiskManifest } from "./diskManifest"
import type { GamePathInfo } from "./gameDetect"

/**
 * LEI-141's single consolidated cache store, replacing `cache/map.json`, `cache/analysis/<id>.json`,
 * `cache/rpkgHashCache.json`, and `cache/modIndex.json` with one SQLite database (`cache.db`, under
 * the temp dir - see `settings.ts`'s `resolveTempDir()`). Content artifacts (the expensive binary
 * output of per-mod tool invocations) live alongside it as content-addressed loose files under
 * `content_cache/` (see LEI-142) rather than in this DB.
 *
 * Uses `node:sqlite` (Node's built-in synchronous SQLite driver, stable in the Node version this
 * Electron build bundles) rather than a third-party native module - no `npm install` needed, no
 * separate native-module rebuild step for Electron, nothing to vendor.
 *
 * Must be fully rebuildable from three untouched sources: the `Mods/` folder's actual contents, the
 * portable `Mods/config.json` (load order + options - see `modsConfig.ts`), and `AppSettings.gamePath`
 * (for one-shot game detection). Deleting this file and running the `mods:rebuildCacheDb` handler
 * (see `ipcHandlers.ts`) is a real, exercised recovery path, not an assumption.
 */

let currentDb: DatabaseSync | undefined
let currentDbPath: string | undefined

/**
 * Root directory for content-addressed loose artifact files (LEI-142). Set by {@link openDb} to
 * `{dirname(dbPath)}/content_cache/`. Functions in `core/utils.ts` (`copyFromCache`/`copyToCache`)
 * derive the same path independently from `paths.dataRoot` via the core-singleton, so worker
 * threads that never call `openDb()` can still read/write cache slots. This copy is used only by
 * {@link clearContentCacheForMod} and {@link clearAllContentCache}, both of which are called
 * exclusively from main-process code where `openDb()` has already run.
 */
let contentCacheRoot: string | undefined

function migrate(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS game_info (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			gamePath TEXT NOT NULL,
			retailPath TEXT NOT NULL,
			runtimePath TEXT NOT NULL,
			platform TEXT NOT NULL,
			unrecognisedBuild INTEGER NOT NULL,
			detectedAt INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS mods (
			id TEXT PRIMARY KEY,
			folder TEXT NOT NULL,
			isFrameworkMod INTEGER NOT NULL,
			manifestJson TEXT,
			valid INTEGER,
			validationError TEXT,
			outdated INTEGER,
			updatedAt INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS mods_folder_idx ON mods(folder);

		-- Per-mod eager-build status/output - see design doc: "building/ready/failed exists purely
		-- for crash-safety (a build interrupted mid-write reads back as not-ready), not as a
		-- staleness signal." Replaces cache/analysis/<modId>.json. Single slot per mod: a rebuild
		-- (option change, explicit rebuild, mod update) overwrites this row wholesale rather than
		-- accumulating variants.
		CREATE TABLE IF NOT EXISTS mod_build (
			modId TEXT PRIMARY KEY,
			status TEXT NOT NULL, -- 'building' | 'ready' | 'failed'
			frameworkVersion TEXT,
			deployInstructionJson TEXT,
			error TEXT,
			startedAt INTEGER NOT NULL,
			finishedAt INTEGER
		);

		CREATE TABLE IF NOT EXISTS rpkg_hash_cache (
			hash TEXT PRIMARY KEY,
			rpkgName TEXT NOT NULL
		);
	`)

	// LEI-142: drop the old blob-cache table and its index if they're still present from a
	// LEI-141 database. Content artifacts now live as loose files under content_cache/ next to
	// cache.db (see core/utils.ts's copyFromCache/copyToCache). This runs on every openDb() call
	// but is a fast no-op once the table no longer exists.
	db.exec(`
		DROP INDEX IF EXISTS content_blob_cache_slot_idx;
		DROP TABLE IF EXISTS content_blob_cache;
	`)

}

/** Open (creating if needed) the cache.db at `dbPath` and cache the handle - safe to call repeatedly, only opens once per path per process. Also sets the content-cache root to `{dirname(dbPath)}/content_cache/`. */
export function openDb(dbPath: string): DatabaseSync {
	if (currentDb && currentDbPath === dbPath) return currentDb

	if (currentDb) {
		currentDb.close()
	}

	mkdirSync(dirname(dbPath), { recursive: true })
	contentCacheRoot = join(dirname(dbPath), "content_cache")

	const db = new DatabaseSync(dbPath)
	db.exec("PRAGMA journal_mode = WAL")
	// Eager per-mod builds run one DatabaseSync connection per worker thread, all against this same
	// file (see deployPipeline.ts's openDb() calls) - WAL lets readers and one writer overlap, but
	// concurrent writers still serialize on SQLite's write lock. Without a busy_timeout, a writer that
	// loses that race gets SQLITE_BUSY ("database is locked") immediately instead of waiting for its
	// turn, which is exactly the failure mode multiple simultaneous per-mod builds hit in practice.
	db.exec("PRAGMA busy_timeout = 5000")
	db.exec("PRAGMA foreign_keys = ON")
	migrate(db)

	currentDb = db
	currentDbPath = dbPath
	return db
}

export function getDb(): DatabaseSync {
	if (!currentDb) {
		throw new Error("cache.db not open - call openDb(dbPath) once at startup before using any db-backed helper (see main/index.ts).")
	}
	return currentDb
}

export function closeDb(): void {
	currentDb?.close()
	currentDb = undefined
	currentDbPath = undefined
	contentCacheRoot = undefined
}

/* ---------------------------------------------------------------------------------------------- */
/*                                        Misc meta flags                                          */
/* ---------------------------------------------------------------------------------------------- */

export function getMeta(key: string): string | undefined {
	const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as unknown as { value: string } | undefined
	return row?.value
}

export function setMeta(key: string, value: string): void {
	getDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
}

/* ---------------------------------------------------------------------------------------------- */
/*                                          Game info                                              */
/* ---------------------------------------------------------------------------------------------- */

export interface StoredGameInfo extends GamePathInfo {
	/** The `gamePath` this detection was run against - lets callers notice `gamePath` changed and re-detect, without ever re-hashing on a plain "is it still the same" check. */
	gamePath: string
	detectedAt: number
}

export function getStoredGameInfo(): StoredGameInfo | undefined {
	const row = getDb().prepare("SELECT * FROM game_info WHERE id = 1").get() as unknown as
		| { gamePath: string; retailPath: string; runtimePath: string; platform: string; unrecognisedBuild: number; detectedAt: number }
		| undefined

	if (!row) return undefined

	return {
		gamePath: row.gamePath,
		retailPath: row.retailPath,
		runtimePath: row.runtimePath,
		platform: row.platform as GamePathInfo["platform"],
		unrecognisedBuild: !!row.unrecognisedBuild,
		detectedAt: row.detectedAt
	}
}

export function setStoredGameInfo(gamePath: string, info: GamePathInfo): void {
	getDb()
		.prepare(
			`INSERT INTO game_info (id, gamePath, retailPath, runtimePath, platform, unrecognisedBuild, detectedAt)
			 VALUES (1, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET gamePath = excluded.gamePath, retailPath = excluded.retailPath, runtimePath = excluded.runtimePath,
				platform = excluded.platform, unrecognisedBuild = excluded.unrecognisedBuild, detectedAt = excluded.detectedAt`
		)
		.run(gamePath, info.retailPath, info.runtimePath, info.platform, info.unrecognisedBuild ? 1 : 0, Date.now())
}

export function clearStoredGameInfo(): void {
	getDb().exec("DELETE FROM game_info WHERE id = 1")
}

/* ---------------------------------------------------------------------------------------------- */
/*                                      Mod index (id/folder)                                      */
/* ---------------------------------------------------------------------------------------------- */

export interface DbModRow {
	id: string
	folder: string
	isFrameworkMod: boolean
	manifest?: DiskManifest
	valid?: boolean
	validationError?: string
	outdated?: boolean
}

function rowToMod(row: { id: string; folder: string; isFrameworkMod: number; manifestJson: string | null; valid: number | null; validationError: string | null; outdated: number | null }): DbModRow {
	return {
		id: row.id,
		folder: row.folder,
		isFrameworkMod: !!row.isFrameworkMod,
		manifest: row.manifestJson ? (JSON.parse(row.manifestJson) as DiskManifest) : undefined,
		valid: row.valid === null ? undefined : !!row.valid,
		validationError: row.validationError ?? undefined,
		outdated: row.outdated === null ? undefined : !!row.outdated
	}
}

export function listMods(): DbModRow[] {
	const rows = getDb().prepare("SELECT * FROM mods").all() as unknown as Parameters<typeof rowToMod>[0][]
	return rows.map(rowToMod)
}

export function getMod(id: string): DbModRow | undefined {
	const row = getDb().prepare("SELECT * FROM mods WHERE id = ?").get(id) as unknown as Parameters<typeof rowToMod>[0] | undefined
	return row ? rowToMod(row) : undefined
}

/** Folder-name lookup - used by the shared "resolve a load-order entry to a Mods/ folder" helper (`resolveModFolder.ts`) for RPKG-only mods, whose `id` in the load order is their folder name directly. */
export function getModByFolder(folder: string): DbModRow | undefined {
	const row = getDb().prepare("SELECT * FROM mods WHERE folder = ?").get(folder) as unknown as Parameters<typeof rowToMod>[0] | undefined
	return row ? rowToMod(row) : undefined
}

export function upsertMod(mod: DbModRow): void {
	getDb()
		.prepare(
			`INSERT INTO mods (id, folder, isFrameworkMod, manifestJson, valid, validationError, outdated, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET folder = excluded.folder, isFrameworkMod = excluded.isFrameworkMod, manifestJson = excluded.manifestJson,
				valid = excluded.valid, validationError = excluded.validationError, outdated = excluded.outdated, updatedAt = excluded.updatedAt`
		)
		.run(
			mod.id,
			mod.folder,
			mod.isFrameworkMod ? 1 : 0,
			mod.manifest ? JSON.stringify(mod.manifest) : null,
			mod.valid === undefined ? null : mod.valid ? 1 : 0,
			mod.validationError ?? null,
			mod.outdated === undefined ? null : mod.outdated ? 1 : 0,
			Date.now()
		)
}

/**
 * Wholesale replace of the `mods` table only - used by `ModIndex`'s write-through, which always has
 * the complete, current set of mods in memory at the moment it persists (mirrors the old
 * modIndex.json's "overwrite the whole file" semantics). Deliberately doesn't touch `mod_build` -
 * build rows are keyed by mod id and outlive a mod dropping out of one particular index snapshot for
 * reasons unrelated to the mod itself being removed (e.g. a scan glitch); actual mod removal goes
 * through {@link deleteMod} instead, which does clear a specific mod's build row and content cache.
 */
export function replaceModsIndex(rows: DbModRow[]): void {
	const db = getDb()
	db.exec("BEGIN")
	try {
		db.exec("DELETE FROM mods")
		// LEI-148: hoist prepare() outside the loop - re-preparing on every iteration is wasteful.
		const stmt = db.prepare(
			`INSERT INTO mods (id, folder, isFrameworkMod, manifestJson, valid, validationError, outdated, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		for (const row of rows) {
			stmt.run(
				row.id,
				row.folder,
				row.isFrameworkMod ? 1 : 0,
				row.manifest ? JSON.stringify(row.manifest) : null,
				row.valid === undefined ? null : row.valid ? 1 : 0,
				row.validationError ?? null,
				row.outdated === undefined ? null : row.outdated ? 1 : 0,
				Date.now()
			)
		}
		db.exec("COMMIT")
	} catch (err) {
		// LEI-147: guard against masking the original error when BEGIN itself threw (no active txn).
		if (db.isTransaction) db.exec("ROLLBACK")
		throw err
	}
}

export function deleteMod(id: string): void {
	const db = getDb()
	db.prepare("DELETE FROM mods WHERE id = ?").run(id)
	db.prepare("DELETE FROM mod_build WHERE modId = ?").run(id)
	clearContentCacheForMod(id)
}

export function clearAllMods(): void {
	const db = getDb()
	db.exec("DELETE FROM mods")
	db.exec("DELETE FROM mod_build")
	clearAllContentCache()
}

/* ---------------------------------------------------------------------------------------------- */
/*                                   Per-mod eager build status                                    */
/* ---------------------------------------------------------------------------------------------- */

export type ModBuildStatus = "building" | "ready" | "failed"

export interface ModBuildRow {
	modId: string
	status: ModBuildStatus
	frameworkVersion?: string
	deployInstructionJson?: string
	error?: string
	startedAt: number
	finishedAt?: number
}

export function getModBuild(modId: string): ModBuildRow | undefined {
	const row = getDb().prepare("SELECT * FROM mod_build WHERE modId = ?").get(modId) as unknown as RawModBuildRow | undefined
	return row ? rowToModBuild(row) : undefined
}

interface RawModBuildRow {
	modId: string
	status: string
	frameworkVersion: string | null
	deployInstructionJson: string | null
	error: string | null
	startedAt: number
	finishedAt: number | null
}

function rowToModBuild(row: RawModBuildRow): ModBuildRow {
	return {
		modId: row.modId,
		status: row.status as ModBuildStatus,
		frameworkVersion: row.frameworkVersion ?? undefined,
		deployInstructionJson: row.deployInstructionJson ?? undefined,
		error: row.error ?? undefined,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt ?? undefined
	}
}

export function listModBuilds(): ModBuildRow[] {
	const rows = getDb().prepare("SELECT * FROM mod_build").all() as unknown as RawModBuildRow[]
	return rows.map(rowToModBuild)
}

/** Marks a mod's build as started - wipes any previous ready/failed result for this mod first (single-slot: no accumulation across rebuilds). Read-back before this commits still sees the old row disappear, then nothing, matching "an interrupted build reads back as not-ready." */
export function beginModBuild(modId: string): void {
	getDb().prepare("INSERT INTO mod_build (modId, status, startedAt) VALUES (?, 'building', ?) ON CONFLICT(modId) DO UPDATE SET status = 'building', startedAt = excluded.startedAt, finishedAt = NULL, error = NULL").run(modId, Date.now())
}

export function finishModBuildReady(modId: string, frameworkVersion: string, deployInstructionJson: string): void {
	getDb()
		.prepare("UPDATE mod_build SET status = 'ready', frameworkVersion = ?, deployInstructionJson = ?, error = NULL, finishedAt = ? WHERE modId = ?")
		.run(frameworkVersion, deployInstructionJson, Date.now(), modId)
}

export function finishModBuildFailed(modId: string, error: string): void {
	// LEI-143: upsert so a worker that crashed before beginModBuild() (no existing row) still leaves a
	// 'failed' row - without this, the poll loop's DB check found nothing and kept retriggering.
	getDb()
		.prepare(
			`INSERT INTO mod_build (modId, status, error, startedAt, finishedAt) VALUES (?, 'failed', ?, ?, ?)
			 ON CONFLICT(modId) DO UPDATE SET status = 'failed', error = excluded.error, finishedAt = excluded.finishedAt`
		)
		.run(modId, error, Date.now(), Date.now())
}

export function deleteModBuild(modId: string): void {
	getDb().prepare("DELETE FROM mod_build WHERE modId = ?").run(modId)
}

/* ---------------------------------------------------------------------------------------------- */
/*                                       RPKG hash cache                                           */
/* ---------------------------------------------------------------------------------------------- */

export function getRpkgHashCacheEntries(): Record<string, string> {
	const rows = getDb().prepare("SELECT hash, rpkgName FROM rpkg_hash_cache").all() as unknown as { hash: string; rpkgName: string }[]
	return Object.fromEntries(rows.map((r) => [r.hash, r.rpkgName]))
}

export function setRpkgHashCacheEntry(hash: string, rpkgName: string): void {
	getDb().prepare("INSERT INTO rpkg_hash_cache (hash, rpkgName) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET rpkgName = excluded.rpkgName").run(hash, rpkgName)
}

export function setRpkgHashCacheEntries(entries: Record<string, string>): void {
	const db = getDb()
	const stmt = db.prepare("INSERT INTO rpkg_hash_cache (hash, rpkgName) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET rpkgName = excluded.rpkgName")
	db.exec("BEGIN")
	try {
		for (const [hash, rpkgName] of Object.entries(entries)) stmt.run(hash, rpkgName)
		db.exec("COMMIT")
	} catch (err) {
		// LEI-147: guard against masking the original error when BEGIN itself threw (no active txn).
		if (db.isTransaction) db.exec("ROLLBACK")
		throw err
	}
}

/* ---------------------------------------------------------------------------------------------- */
/*                                     Content cache (loose files)                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * LEI-142: content artifacts now live as content-addressed loose files next to cache.db rather than
 * as SQLite BLOBs. The primary cache read/write path (`copyFromCache`/`copyToCache` in
 * `core/utils.ts`) works directly from `paths.dataRoot` via the core-singleton, so patchWorker
 * threads never need to call `openDb()` just to access cached content. The functions below handle
 * the "clear a mod's content" side (called from `deleteMod` / `clearAllMods`), where the main
 * process always has `contentCacheRoot` set via `openDb()`.
 *
 * Path sanitization: `winPathEscape`-equivalent inline (not imported from `core/utils.ts` to avoid
 * a circular dep). The same sanitization must be used in `core/utils.ts`'s `contentCacheSlotDir()`.
 */

/** Removes all cached content artifacts for `modId`. No-op if `contentCacheRoot` hasn't been set (shouldn't happen in the main process, but safe to call from any context). */
export function clearContentCacheForMod(modId: string): void {
	if (!contentCacheRoot) return
	const safeModId = modId.replace(/[<>:"/\\|?*]/g, "")
	if (!safeModId) return
	rmSync(join(contentCacheRoot, safeModId), { recursive: true, force: true })
}

/** Removes the entire content cache directory (all mods). Called by `clearAllMods` and by `mods:rebuildCacheDb`. */
export function clearAllContentCache(): void {
	if (!contentCacheRoot) return
	rmSync(contentCacheRoot, { recursive: true, force: true })
}

/** Whether `dbPath` already exists and has data worth treating as "not a fresh install" - used by {@link resolveTempDirLegacyCheck}-style callers and diagnostics. Not the same check as `settings.ts`'s `legacyTempDirHasData()` (that one looks for the *pre-LEI-141* JSON cache files, this one is about cache.db itself). */
export function dbFileExists(dbPath: string): boolean {
	return existsSync(dbPath)
}
