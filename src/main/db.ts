import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { DiskManifest } from "./diskManifest"
import type { GamePathInfo } from "./gameDetect"

/**
 * LEI-141's single consolidated cache store, replacing `cache/map.json`, `cache/analysis/<id>.json`,
 * `cache/rpkgHashCache.json`, `cache/modIndex.json`, and the loose per-mod content-file cache
 * (`cache/<mod>/<relativePath>`) with one SQLite database (`cache.db`, under the temp dir - see
 * `settings.ts`'s `resolveTempDir()`).
 *
 * Uses `node:sqlite` (Node's built-in synchronous SQLite driver, stable in the Node version this
 * Electron build bundles) rather than a third-party native module - no `npm install` needed, no
 * separate native-module rebuild step for Electron, nothing to vendor.
 *
 * Why one file instead of the previous five: build-status and blob content need to commit
 * atomically (a "ready" flag lying because the blobs didn't finish writing is worse than no cache
 * at all - see `mod_build`'s doc comment below), and point-lookup/partial-update/concurrent-access
 * all beat both live fs walks and flat JSON arrays at the scale a large mod collection reaches (one
 * suit-replacement mod alone puts ~7k loose files under the old per-mod content cache).
 *
 * Must be fully rebuildable from three untouched sources: the `Mods/` folder's actual contents, the
 * portable `Mods/config.json` (load order + options - see `modsConfig.ts`), and `AppSettings.gamePath`
 * (for one-shot game detection). Deleting this file and calling {@link rebuildFromScratch} is a real,
 * exercised recovery path, not an assumption - see `dbRebuild.ts`.
 */

let currentDb: DatabaseSync | undefined
let currentDbPath: string | undefined

const SCHEMA_VERSION = 1

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

		-- Replaces the loose cache/<mod>/<relativePath> tree. Every copyToCache() call in
		-- deploy.ts/utils.ts always caches a directory's worth of content (confirmed by inspection -
		-- every call site passes a directory, even when it logically holds a single file), so this
		-- flattens that tree into (modId, cachePath, relPath) rows - relPath is "" for a cached slot
		-- that turned out to hold exactly one file at its root, matching fs-extra's own
		-- copy(srcDir, destDir) "merge contents into dest" semantics on restore.
		CREATE TABLE IF NOT EXISTS content_blob_cache (
			modId TEXT NOT NULL,
			cachePath TEXT NOT NULL,
			relPath TEXT NOT NULL,
			data BLOB NOT NULL,
			PRIMARY KEY (modId, cachePath, relPath)
		);

		CREATE INDEX IF NOT EXISTS content_blob_cache_slot_idx ON content_blob_cache(modId, cachePath);
	`)

	const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as unknown as { value: string } | undefined
	if (!row) {
		db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION))
	}
}

/** Open (creating if needed) the cache.db at `dbPath` and cache the handle - safe to call repeatedly, only opens once per path per process. */
export function openDb(dbPath: string): DatabaseSync {
	if (currentDb && currentDbPath === dbPath) return currentDb

	if (currentDb) {
		currentDb.close()
	}

	mkdirSync(dirname(dbPath), { recursive: true })

	const db = new DatabaseSync(dbPath)
	db.exec("PRAGMA journal_mode = WAL")
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
 * modIndex.json's "overwrite the whole file" semantics). Deliberately doesn't touch `mod_build`/
 * `content_blob_cache` - those are keyed by mod id and outlive a mod dropping out of one particular
 * index snapshot for reasons unrelated to the mod itself being removed (e.g. a scan glitch); actual
 * mod removal goes through {@link deleteMod} instead, which does clear a specific mod's build/cache
 * rows.
 */
export function replaceModsIndex(rows: DbModRow[]): void {
	const db = getDb()
	db.exec("BEGIN")
	try {
		db.exec("DELETE FROM mods")
		for (const row of rows) {
			db.prepare(
				`INSERT INTO mods (id, folder, isFrameworkMod, manifestJson, valid, validationError, outdated, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
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
		db.exec("ROLLBACK")
		throw err
	}
}

export function deleteMod(id: string): void {
	const db = getDb()
	db.prepare("DELETE FROM mods WHERE id = ?").run(id)
	db.prepare("DELETE FROM mod_build WHERE modId = ?").run(id)
	db.prepare("DELETE FROM content_blob_cache WHERE modId = ?").run(id)
}

export function clearAllMods(): void {
	const db = getDb()
	db.exec("DELETE FROM mods")
	db.exec("DELETE FROM mod_build")
	db.exec("DELETE FROM content_blob_cache")
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
	getDb().prepare("UPDATE mod_build SET status = 'failed', error = ?, finishedAt = ? WHERE modId = ?").run(error, Date.now(), modId)
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
		db.exec("ROLLBACK")
		throw err
	}
}

/* ---------------------------------------------------------------------------------------------- */
/*                                     Content blob cache                                          */
/* ---------------------------------------------------------------------------------------------- */

function walkFilesSync(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...walkFilesSync(full))
		else if (entry.isFile()) out.push(full)
	}
	return out
}

/** True if this (modId, cachePath) slot has at least one cached blob - i.e. a cache hit is possible. */
export function hasContentCache(modId: string, cachePath: string): boolean {
	const row = getDb().prepare("SELECT 1 FROM content_blob_cache WHERE modId = ? AND cachePath = ? LIMIT 1").get(modId, cachePath)
	return row !== undefined
}

/** Restores a previously-cached directory tree to `outputDir` (created if missing) - mirrors fs-extra's old `copySync(cacheDir, outputDir)` "merge contents into dest" behaviour. Returns false (no-op) if nothing is cached at this slot. */
export function restoreContentCache(modId: string, cachePath: string, outputDir: string): boolean {
	const rows = getDb().prepare("SELECT relPath, data FROM content_blob_cache WHERE modId = ? AND cachePath = ?").all(modId, cachePath) as unknown as { relPath: string; data: Uint8Array }[]
	if (!rows.length) return false

	mkdirSync(outputDir, { recursive: true })
	for (const row of rows) {
		// relPath === "" means the cached slot's source was a single file at its own root (see
		// storeContentCache) - fs-extra's old copySync(file, existingDir) would place it *inside*
		// that directory keyed by the source's own basename, but every real caller here caches a
		// directory's worth of content (confirmed by inspection), so this branch is a defensive
		// fallback rather than something the real call sites hit.
		const finalPath = row.relPath ? join(outputDir, row.relPath) : join(outputDir, "content")
		mkdirSync(dirname(finalPath), { recursive: true })
		writeFileSync(finalPath, Buffer.from(row.data))
	}
	return true
}

/** Caches `sourceDir` (a directory - every real call site passes one, even for a logically-single-file slot) under (modId, cachePath), replacing whatever was cached there before (single-slot, matching the rest of this store's "no accumulation" model). */
export function storeContentCache(modId: string, cachePath: string, sourceDir: string): void {
	const db = getDb()

	db.exec("BEGIN")
	try {
		db.prepare("DELETE FROM content_blob_cache WHERE modId = ? AND cachePath = ?").run(modId, cachePath)

		const stat = statSync(sourceDir)
		const insert = db.prepare("INSERT INTO content_blob_cache (modId, cachePath, relPath, data) VALUES (?, ?, ?, ?)")

		if (stat.isDirectory()) {
			for (const file of walkFilesSync(sourceDir)) {
				const rel = relative(sourceDir, file).split("\\").join("/")
				insert.run(modId, cachePath, rel, readFileSync(file))
			}
		} else {
			insert.run(modId, cachePath, "", readFileSync(sourceDir))
		}

		db.exec("COMMIT")
	} catch (err) {
		db.exec("ROLLBACK")
		throw err
	}
}

export function clearContentCacheForMod(modId: string): void {
	getDb().prepare("DELETE FROM content_blob_cache WHERE modId = ?").run(modId)
}

/** Whether `dbPath` already exists and has data worth treating as "not a fresh install" - used by {@link resolveTempDirLegacyCheck}-style callers and diagnostics. Not the same check as `settings.ts`'s `legacyTempDirHasData()` (that one looks for the *pre-LEI-141* JSON cache files, this one is about cache.db itself). */
export function dbFileExists(dbPath: string): boolean {
	return existsSync(dbPath)
}
