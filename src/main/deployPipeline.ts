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
import { resolveModsDir } from "./settings"
import { computeGameHash, type GamePathInfo } from "./gameDetect"

export interface DeployPipelineLogLine {
	level: "verbose" | "debug" | "info" | "warn" | "error"
	text: string
	mod?: string
}

export type DeployPipelineResult = { ok: true } | { ok: false; error: string }

/**
 * Builds the framework core's real `Config` object in memory from this app's persisted
 * `AppSettings` plus a fresh `GamePathInfo` - no `config.json` on disk involved (LEI-133's "no
 * on-disk config.json required for normal operation"). `retailPath`/`runtimePath`/`platform` come
 * from `game` (the caller's own `gameDetect.ts`'s `deriveGamePathInfo()` call against the
 * persisted `gamePath` - see deployManager.ts/ipcHandlers.ts) rather than from `settings` directly,
 * since only `gamePath` itself is persisted (see settings.ts's doc comment) - `createCore()` still
 * runs them through `path.resolve(dataRoot, ...)` internally, but since they're already absolute
 * that's a no-op (see `src/core.ts`).
 */
export function buildFrameworkConfig(paths: AppPaths, settings: AppSettings, game: GamePathInfo): Config {
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
		knownMods: settings.knownMods,
		loadOrder: settings.loadOrder,
		modOptions: settings.modOptions,
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

async function createEmbeddedCore(paths: AppPaths, config: Config, onLog: (line: DeployPipelineLogLine) => void): Promise<Core> {
	const [{ createCore }, { setCurrentCore }] = await Promise.all([import("./core/core"), import("./core/core-singleton")])

	const core = createCore(config, {
		paths: { dataRoot: paths.dataRoot, toolsRoot: paths.toolsRoot }
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
 * The embedded equivalent of `src/main.ts`'s `doTheThing()` - discover -> diff/cache -> deploy,
 * replacing the old `spawn('Deploy.exe --doNotPause --colors', ...)` IPC handler (LEI-133). Runs
 * entirely in this process; progress/log lines are streamed out via `onLog` instead of being
 * printed to a console that doesn't exist here.
 */
export async function runFullDeploy(paths: AppPaths, settings: AppSettings, game: GamePathInfo, onLog: (line: DeployPipelineLogLine) => void): Promise<DeployPipelineResult> {
	const { CoreFatalError } = await import("./core/core")
	const config = buildFrameworkConfig(paths, settings, game)
	const core = await createEmbeddedCore(paths, config, onLog)

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
		fs.emptyDirSync(path.join(paths.dataRoot, "staging"))
		fs.emptyDirSync(path.join(paths.dataRoot, "temp"))

		fs.ensureDirSync(path.join(paths.dataRoot, "cache"))

		const gameHash = computeGameHash(config.retailPath, config.runtimePath)
		const mapPath = path.join(paths.dataRoot, "cache", "map.json")

		// Checked *before* discovery now (rather than after) so its result - specifically, whether the
		// previous run's file map is even still valid - can be handed to discover() below. A framework
		// or game update invalidates every fingerprint in one shot (new game files, possibly new
		// discovery logic), so in that case discover() gets an empty map and does a full uncached walk,
		// same as it always used to unconditionally.
		await core.logger.verbose("Checking cache versions")
		let previousFiles: Record<string, { hash: string; dependencies: string[]; affected: string[]; size?: number; mtimeMs?: number }> = {}
		if (fs.existsSync(mapPath)) {
			const cached = fs.readJSONSync(mapPath)
			if (cached.frameworkVersion < core.FrameworkVersion || cached.game !== gameHash) {
				fs.emptyDirSync(path.join(paths.dataRoot, "cache")) // Empty the cache when the framework or game updates
			} else {
				previousFiles = cached.files ?? {}
			}
		}

		// discover() uses previousFiles' per-file size/mtime fingerprints to skip re-hashing (and, for
		// RPKG-only mods, re-extracting) anything that hasn't changed since the last deploy - see its
		// own doc comment. This used to unconditionally re-walk and re-hash every single file in every
		// mod on every deploy regardless of whether anything had changed; now that only happens for
		// files that are actually new or modified.
		await core.logger.verbose("Beginning discovery")
		const { default: discover } = await import("./core/discover")
		const fileMap = await discover(previousFiles)

		await core.logger.verbose("Beginning difference")
		const { default: difference } = await import("./core/difference")
		const { invalidData } = await difference(previousFiles, fileMap)

		await core.logger.verbose("Writing cache")
		fs.writeJSONSync(mapPath, {
			files: fileMap,
			frameworkVersion: core.FrameworkVersion,
			game: gameHash
		})

		await core.logger.verbose("Beginning deploy")
		const { default: deploy } = await import("./core/deploy")
		await deploy(noopSpan(), () => {}, invalidData)

		await core.logger.verbose("Finishing")
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

/**
 * The embedded equivalent of `src/main.ts`'s `doAnalyseModThing()` / `Deploy --analyseMod <id>` -
 * analyses a single mod and (re)populates its analysis cache entry, without running the full
 * discover/difference/deploy pipeline. This is what LEI-108's "background analyseMod, off the
 * deploy critical path" is meant to call whenever a mod is added/updated or its selected options
 * change - LEI-133's job is just to make sure the handler exists and runs in-process.
 */
export async function runAnalyseMod(paths: AppPaths, settings: AppSettings, game: GamePathInfo, modId: string, onLog: (line: DeployPipelineLogLine) => void): Promise<DeployPipelineResult> {
	const { CoreFatalError } = await import("./core/core")
	const config = buildFrameworkConfig(paths, settings, game)
	const core = await createEmbeddedCore(paths, config, onLog)

	try {
		await core.logger.verbose("Initialising RPKG instance")
		await core.rpkgInstance.waitForInitialised()

		fs.ensureDirSync(path.join(paths.dataRoot, "cache"))
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
