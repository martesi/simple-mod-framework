import fs from "fs-extra"
import path from "node:path"

// The framework core itself - see LEI-129/LEI-130 (embeddable, no import-time singleton, no
// process.exit(), no process.cwd()). This is the one place in this app that imports it: everyone
// else (deployManager.ts, ipcHandlers.ts) goes through the functions below instead of touching
// createCore()/core-singleton directly.
//
// Every *runtime* import of it below is a dynamic `await import(...)` inside the functions that
// actually run a deploy/analyse, not a static top-of-file import - `discover.ts`/`deploy.ts`/
// `analyseMod.ts` all pull in the full `typescript` compiler package to compile mod scripts, which
// bundles to several MB (see electron.vite.config.ts's doc comment on why main's build forces CJS
// output). A static import here meant Node had to fully parse and evaluate that entire module
// graph - typescript compiler included - as part of loading main/index.cjs, before
// `app.whenReady()` even fired, i.e. before the window could be created at all. That's several
// extra seconds on *every* launch, even the many sessions where the user never actually runs a
// deploy. Dynamic imports mean that cost is only ever paid the first time a deploy or analyseMod
// actually runs. `import type` for the type-only names below is unaffected either way - those are
// erased at compile time and never bundled regardless of how the value is imported.
import type { Core, Logger } from "./core/core"
import type { Config } from "./core/types"
import type { Span } from "./core/deploy"

import type { AppPaths } from "./paths"
import type { AppSettings } from "./settings"
import { resolveModsDir, resolveTempDir } from "./settings"
import type { GamePathInfo } from "./gameDetect"
import type { ModsConfig } from "./modsConfig"
import { openDb } from "./db"

export interface DeployPipelineLogLine {
	level: "verbose" | "debug" | "info" | "warn" | "error"
	text: string
	mod?: string
}

export type DeployPipelineResult = { ok: true } | { ok: false; error: string; cancelled?: boolean }

/**
 * Builds the framework core's real `Config` object in memory from this app's persisted
 * `AppSettings` + `ModsConfig` (LEI-141's config split - load order/options live in `Mods/config.json`
 * now, not `settings.json`) plus a one-shot-detected `GamePathInfo` - no `config.json` on disk
 * involved (LEI-133's "no on-disk config.json required for normal operation"). `retailPath`/
 * `runtimePath`/`platform` come from `game` (the caller's `gameDetect.ts`'s `deriveGamePathInfo()`
 * call, cached in `cache.db` and only ever re-derived when `gamePath` changes - see
 * deployManager.ts/ipcHandlers.ts) rather than from `settings` directly, since only `gamePath`
 * itself is persisted - `createCore()` still runs them through `path.resolve(dataRoot, ...)`
 * internally, but since they're already absolute that's a no-op (see `src/core.ts`).
 */
export function buildFrameworkConfig(paths: AppPaths, settings: AppSettings, modsConfig: ModsConfig, game: GamePathInfo): Config {
	return {
		retailPath: game.retailPath,
		runtimePath: game.runtimePath,
		modsPath: resolveModsDir(paths, settings),
		skipIntro: settings.skipIntro,
		outputToSeparateDirectory: settings.outputToSeparateDirectory,
		outputConfigToAppDataOnDeploy: settings.outputConfigToAppDataOnDeploy,
		// Error-reporting wiring for the embedded app is out of LEI-133's scope - this app has no
		// Sentry dependency at all (the last remaining trace, a type-only import in core/deploy.ts,
		// was dropped once nothing was left actually reporting to it - see Span's doc comment), so
		// always report as off regardless of the persisted preference rather than silently
		// pretending to honour it.
		reportErrors: false,
		errorReportingID: null,
		developerMode: settings.developerMode,
		// `knownMods` is gone from both config files (LEI-141 - cache.db's `mods` table is the real
		// membership list) - the framework core's `Config` type still declares the field but nothing
		// in `analyseMod.ts`/`deploy.ts` actually reads it anymore, so `modOrder` (every known mod,
		// same as the UI-facing mapping in `configMapping.ts`) is a harmless stand-in.
		knownMods: modsConfig.modOrder,
		loadOrder: modsConfig.loadOrder,
		modOptions: modsConfig.modOptions,
		platform: game.platform as Config["platform"]
	}
}

/** Wraps a Core's logger so every log call also reaches `onLog` (for `deploy:progress`), while still delegating to the real logger underneath (Deploy.log, fatal-error/cleanup behaviour, etc. all still happen exactly as `core.ts` implements them). */
function withProgress(core: Core, onLog: (line: DeployPipelineLogLine) => void): Logger {
	const base = core.logger
	return {
		async verbose(text, mod) {
			onLog({ level: "verbose", text, mod })
			return base.verbose(text, mod)
		},
		async debug(text, mod) {
			onLog({ level: "debug", text, mod })
			return base.debug(text, mod)
		},
		async info(text, mod) {
			onLog({ level: "info", text, mod })
			return base.info(text, mod)
		},
		async warn(text, mod) {
			onLog({ level: "warn", text, mod })
			return base.warn(text, mod)
		},
		async error(text, exitAfter, mod) {
			onLog({ level: "error", text, mod })
			return base.error(text, exitAfter, mod)
		}
	}
}

/**
 * `tempDir` (LEI-141's `resolveTempDir()` - see settings.ts) becomes the Core's own `paths.dataRoot`
 * here - deliberately *not* the app's `AppPaths.dataRoot` (which now holds only settings.json).
 * `core.ts`'s `CoreOptions.paths.dataRoot` was always meant to be an independently-injectable
 * "where staging/temp/cache/Deploy.log live" root (its own doc comment already described exactly
 * this folder's contents); before this change it just happened to be pointed at the same folder as
 * the app's userData dataRoot. Everything under `core/*.ts` that reads `paths.dataRoot` via
 * `core-singleton` picks up the new location automatically - no other core file needed to change.
 */
async function createEmbeddedCore(tempDir: string, toolsRoot: string, config: Config, onLog: (line: DeployPipelineLogLine) => void): Promise<Core> {
	const [{ createCore }, { setCurrentCore }] = await Promise.all([import("./core/core"), import("./core/core-singleton")])

	const core = createCore(config, {
		paths: { dataRoot: tempDir, toolsRoot }
	})

	const withProgressCore: Core = { ...core, logger: withProgress(core, onLog) }
	setCurrentCore(withProgressCore)
	return withProgressCore
}

/**
 * A no-op {@link Span} stub - error reporting itself is out of scope (see `buildFrameworkConfig`'s
 * `reportErrors: false`), but `deploy()`'s signature still requires something span-tree-shaped to
 * call `.startChild()`/`.finish()` on throughout the pipeline. This shape used to be Sentry's own
 * `Transaction` type (see `Span`'s own doc comment in `core/deploy.ts` for why that dependency is
 * gone now) - copied verbatim from `src/main.ts`'s own CLI bootstrap, back when this really was a
 * Sentry stub rather than a fully local one.
 */
function noopSpan(): Span {
	const stub: Span = {
		startChild(..._args: unknown[]) {
			return stub
		},
		finish(..._args: unknown[]) {}
	}
	return stub
}

/**
 * The embedded equivalent of `src/main.ts`'s `doTheThing()`, replacing the old
 * `spawn('Deploy.exe --doNotPause --colors', ...)` IPC handler (LEI-133). Runs entirely in this
 * process (well, this worker thread - see deployWorker.ts); progress/log lines are streamed out via
 * `onLog` instead of being printed to a console that doesn't exist here.
 *
 * LEI-141 dropped the discover -> difference -> deploy pipeline entirely: there's no per-file
 * content hash, no size/mtime fingerprint, no `cache/map.json`, no game-build hash gating a wholesale
 * cache wipe. Every mod's `DeployInstruction` already lives in `cache.db`, kept correct by eager
 * per-mod builds triggered at the moment something actually changed (mod added/updated, options
 * changed, explicit rebuild - see `ipcHandlers.ts`) rather than recomputed-and-compared here. By the
 * time this function runs at all, the queue-aware deploy gate (`deployManager.ts`) has already
 * confirmed every mod in the load order has a `ready` build - `deploy()` itself just reads them.
 */
export async function runFullDeploy(paths: AppPaths, settings: AppSettings, modsConfig: ModsConfig, game: GamePathInfo, onLog: (line: DeployPipelineLogLine) => void): Promise<DeployPipelineResult> {
	const tempDir = resolveTempDir(paths, settings)
	openDb(path.join(tempDir, "cache.db"))

	const { CoreFatalError } = await import("./core/core")
	const config = buildFrameworkConfig(paths, settings, modsConfig, game)
	const core = await createEmbeddedCore(tempDir, paths.toolsRoot, config, onLog)

	try {
		await core.logger.verbose("Initialising RPKG instance")
		await core.rpkgInstance.waitForInitialised()

		await core.logger.verbose("Removing existing patch files")
		for (const chunkPatchFile of fs.readdirSync(config.runtimePath)) {
			try {
				if (chunkPatchFile.includes("patch")) {
					const match = chunkPatchFile.match(/^chunk[0-9]+patch([0-9]+)\.rpkg$/)
					if (match) {
						const patchNumber = parseInt(match[1])
						if (patchNumber >= 200 && patchNumber <= 300) {
							// The mod framework manages patch files between 200 (inc) and 300 (inc), allowing mods to place runtime files in those ranges
							fs.rmSync(path.join(config.runtimePath, chunkPatchFile))
						}
					} else {
						await core.logger.warn(`${chunkPatchFile} in your Runtime folder is not from the vanilla game. This might cause issues with SMF - move it elsewhere!`)
					}
				} else if (chunkPatchFile.match(/^chunk[0-9]+\.rpkg$/)) {
					if (parseInt(chunkPatchFile.split(".")[0].slice(5)) > 30) {
						fs.rmSync(path.join(config.runtimePath, chunkPatchFile))
					}
				} else if (chunkPatchFile !== "packagedefinition.txt") {
					await core.logger.warn(`${chunkPatchFile} in your Runtime folder is not from the vanilla game. This might cause issues with SMF - move it elsewhere!`)
				}
			} catch {
				// Best-effort cleanup of a single stray Runtime file shouldn't abort the whole deploy - mirrors src/main.ts's own empty catch here.
			}
		}

		await core.logger.verbose("Emptying folders")
		fs.emptyDirSync(path.join(core.paths.dataRoot, "staging"))
		fs.emptyDirSync(path.join(core.paths.dataRoot, "temp"))

		await core.logger.verbose("Beginning deploy")
		const { default: deploy } = await import("./core/deploy")
		await deploy(noopSpan(), () => {})

		await core.logger.verbose("Finishing")
		await core.cleanExit()

		return { ok: true }
	} catch (err) {
		const { DeployCancelledError } = await import("./core/cancel")
		if (err instanceof DeployCancelledError) {
			await core.cleanExit().catch(() => {})
			return { ok: false, error: "Deploy cancelled", cancelled: true }
		}

		if (err instanceof CoreFatalError) {
			return { ok: false, error: err.message }
		}

		await core.cleanExit().catch(() => {})
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * The embedded equivalent of `src/main.ts`'s `doAnalyseModThing()` / `Deploy --analyseMod <id>` -
 * analyses a single mod and (re)populates its analysis cache entry, without running the full
 * discover/difference/deploy pipeline. This is what LEI-108's "background analyseMod, off the
 * deploy critical path" is meant to call whenever a mod is added/updated or its selected options
 * change - LEI-133's job is just to make sure the handler exists and runs in-process.
 */
export async function runAnalyseMod(paths: AppPaths, settings: AppSettings, modsConfig: ModsConfig, game: GamePathInfo, modId: string, onLog: (line: DeployPipelineLogLine) => void): Promise<DeployPipelineResult> {
	const tempDir = resolveTempDir(paths, settings)
	openDb(path.join(tempDir, "cache.db"))

	const { CoreFatalError } = await import("./core/core")
	const config = buildFrameworkConfig(paths, settings, modsConfig, game)
	const core = await createEmbeddedCore(tempDir, paths.toolsRoot, config, onLog)

	try {
		await core.logger.verbose("Initialising RPKG instance")
		await core.rpkgInstance.waitForInitialised()

		const { default: analyseMod, loadRPKGHashCache, saveRPKGHashCache } = await import("./core/analyseMod")
		loadRPKGHashCache()

		await core.logger.info(`Analysing ${modId}`)
		await analyseMod(modId)

		saveRPKGHashCache()
		await core.cleanExit()

		return { ok: true }
	} catch (err) {
		if (err instanceof CoreFatalError) {
			return { ok: false, error: err.message }
		}

		await core.cleanExit().catch(() => {})
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}
