const FrameworkVersion = "2.33.40"
const isDevBuild = false

import log from "electron-log/node"

import type { Config } from "./types"
import RPKGInstance from "./rpkg"
import fs from "fs-extra"
import json5 from "json5"
import path from "path"

/**
 * Options controlling how a {@link Core}'s logger behaves. The old CLI-era knobs
 * (`useConsoleLogging`/`pauseAfterLogging`/`doNotPause`, plus the `pause()` "press any key to
 * continue" behaviour they gated) are gone along with the CLI itself - there's no console for an
 * embedder to pause in, and nothing ever set any of them to a non-default value once the CLI was
 * dropped. Logging itself now goes through `electron-log` (see the `logger` construction below)
 * instead of a hand-rolled chalk-coloured `process.stdout.write` + manual `Deploy.log`
 * `fs.appendFileSync` - a "proper" log writer gives file rotation/formatting for free, and nothing
 * downstream of the embedded app was actually reading main-process stdout anyway.
 */
export interface CoreOptions {
	/** Minimum electron-log level (`"error" | "warn" | "info" | "verbose" | "debug" | "silly"`) forwarded to the main-process/DevTools console, or `false` to disable it entirely. Defaults to `"debug"`. Deploy.log itself (the file transport) always receives every level regardless of this - this only controls what's cheap-to-ignore console noise. */
	consoleLevel?: false | "error" | "warn" | "info" | "verbose" | "debug" | "silly"

	/**
	 * Injected filesystem roots - replaces the old assumption that "the framework's own folder"
	 * and `process.cwd()` are the same thing (see LEI-130). Both default to `process.cwd()` when
	 * omitted, matching the CLI's historical portable-folder layout (exe, config.json, Third-Party/,
	 * Mods/ and a symlinked Runtime/ all sitting side by side) - a real embedder (e.g. the Electron
	 * mod manager's main process) should always pass these explicitly instead of relying on that
	 * default.
	 */
	paths?: {
		/** Writable: staging/, temp/, cache/, Deploy.log, cleanThumbs.dat, cleanPackageDefinition.txt, config.json (when passed a path). Should be app.getPath('userData') for Electron. */
		dataRoot?: string

		/** Read-only: bundled Third-Party/ tools and hash data. Should be process.resourcesPath for a packaged Electron app. */
		toolsRoot?: string
	}
}

export interface Logger {
	verbose(text: string, mod?: string): Promise<void>
	debug(text: string, mod?: string): Promise<void>
	info(text: string, mod?: string): Promise<void>
	warn(text: string, mod?: string): Promise<void>

	/**
	 * Log an error. By default this is fatal - it runs cleanup (registered cleanup callbacks,
	 * the RPKG process) and then throws a {@link CoreFatalError} instead of calling
	 * `process.exit()`; it is up to whichever caller is running the core (the CLI entry point,
	 * or an embedder's IPC handler) to decide what to do with that - typically `process.exit(1)`
	 * for a CLI, or surfacing the error to the UI for an embedder. Pass `exitAfter: false` for a
	 * non-critical error that should just be logged (use `warn` instead if it's not really an
	 * error at all).
	 */
	error(text: string, exitAfter?: boolean, mod?: string): Promise<void>
}

export type CleanupCallback = () => void | Promise<void>

/** {@link CoreOptions}, normalised to concrete values - see {@link Core.options}. */
export interface ResolvedCoreOptions {
	consoleLevel: false | "error" | "warn" | "info" | "verbose" | "debug" | "silly"
}

/**
 * Thrown by {@link Logger.error} in place of the old `process.exit(1)`. Whoever is running the
 * core decides what a fatal deploy error means for them - kill the CLI process, show a dialog in
 * the mod manager UI, etc.
 */
export class CoreFatalError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CoreFatalError"
	}
}

export interface Core {
	FrameworkVersion: string
	isDevBuild: boolean

	rpkgInstance: RPKGInstance
	config: Config
	logger: Logger

	/**
	 * The resolved filesystem roots this Core was created with (see {@link CoreOptions.paths}).
	 * Threaded through instead of `process.cwd()` everywhere - a worker thread bootstrapping its
	 * own Core (see patchWorker.ts) needs these handed over explicitly the same way `config` and
	 * `options` are, since it's a separate module realm with no access to this one's values.
	 */
	paths: {
		dataRoot: string
		toolsRoot: string
	}

	/**
	 * The options this Core was created with, normalised to concrete values. Lets a caller that
	 * only has access to a Core (not the original CoreOptions it was constructed with) spin up an
	 * equivalent one elsewhere - e.g. a WorkerPool worker thread bootstrapping its own Core so its
	 * logging matches the thread that created the pool (see patchWorker.ts). Worker threads are
	 * separate module realms with no access to the main thread's in-memory state, so this has to
	 * be threaded through function arguments (the task payload passed to `workerPool.run()`)
	 * rather than assumed to exist as ambient/global state.
	 */
	options: ResolvedCoreOptions

	/**
	 * Register a callback to run as part of fatal-error/cleanExit cleanup - e.g. destroying a
	 * worker pool created for this deploy. Replaces the old `global.currentWorkerPool` hack: the
	 * pool's owner registers/unregisters it explicitly on this Core instance instead of the
	 * framework reaching into a process-wide global that assumed only one deploy ever ran per
	 * process.
	 */
	registerCleanup(fn: CleanupCallback): void
	unregisterCleanup(fn: CleanupCallback): void

	/** Run the same cleanup a fatal error would (registered cleanups, the RPKG process), without throwing - for a normal/successful end of a deploy. */
	cleanExit(): Promise<void>
}

/**
 * Build a new, independent {@link Core} - the embeddable replacement for what used to be this
 * module's import-time singleton (see LEI-129). Accepts either a path to a `config.json` (the
 * CLI/transitional case) or an already-parsed {@link Config} object (the embedded/in-process
 * case, e.g. a long-lived Electron main process running many deploys with configs that can
 * change between them).
 *
 * Importing this module has no side effects: nothing reads config.json, spawns rpkg-cli, or
 * touches the filesystem until this function is actually called.
 */
export function createCore(configOrPath: Config | string, options: CoreOptions = {}): Core {
	const consoleLevel = options.consoleLevel ?? "debug"

	const config: Config = typeof configOrPath === "string" ? json5.parse(fs.readFileSync(configOrPath, "utf8")) : configOrPath

	// Both default to process.cwd() - the CLI's historical "everything sits next to the exe" layout
	// (see CoreOptions.paths). A real embedder always passes these explicitly.
	const dataRoot = options.paths?.dataRoot ?? process.cwd()
	const toolsRoot = options.paths?.toolsRoot ?? process.cwd()

	if (config.runtimePath === "..\\Runtime" && fs.existsSync(path.join(config.retailPath, "Runtime", "chunk0.rpkg"))) {
		config.runtimePath = "..\\Retail\\Runtime"

		if (typeof configOrPath === "string") {
			fs.writeFileSync(configOrPath, json5.stringify(config))
			fs.copyFileSync(path.join(toolsRoot, "cleanMicrosoftThumbs.dat"), path.join(dataRoot, "cleanThumbs.dat"))
		}
	} // Automatically set runtime path and fix clean thumbs if using microsoft platform

	if (typeof config.reportErrors === "undefined") {
		config.reportErrors = false
		config.errorReportingID = null
	} // Do not report errors if no preference is set

	if (typeof config.developerMode === "undefined") {
		config.developerMode = false
	} // Assume user is not a developer if no preference is set

	if (!config.modsPath) {
		config.modsPath = path.join(dataRoot, "Mods")
	} // Default the mod storage location to Mods/ under dataRoot if unset - matches the historical hardcoded location

	config.runtimePath = path.resolve(dataRoot, config.runtimePath)
	config.retailPath = path.resolve(dataRoot, config.retailPath)
	config.modsPath = path.resolve(dataRoot, config.modsPath)

	const rpkgInstance = new RPKGInstance(toolsRoot)

	// electron-log's own file/console transports replace the old hand-rolled pair of a manual
	// `fs.appendFileSync` to Deploy.log plus a chalk-coloured `process.stdout.write` - "a proper
	// electron log writer" instead of reinventing formatting/level-filtering ourselves. `/node`
	// (not `/main`) deliberately: this same createCore() runs both on the main thread and inside a
	// worker thread (see patchWorker.ts), and `electron-log/main`'s default log-path resolution
	// (plus its renderer-IPC-bridge `initialize()` step, which we don't use here anyway) goes
	// through Electron's `app` module - not something a plain `node:worker_threads` Worker is
	// guaranteed to have working access to. `/node` never touches `app` at all, so it behaves
	// identically in both contexts; we already pass `dataRoot` in explicitly instead of relying on
	// electron-log's own Electron-app-path default regardless.
	const logFilePath = path.join(dataRoot, "Deploy.log")
	log.transports.file.resolvePathFn = () => logFilePath

	// Deploy.log is meant to be a complete record - every level, always - matching the old
	// unconditional appendLog() behaviour. `consoleLevel` only governs the separate console
	// transport below (main-process stdout / DevTools), which nothing downstream of this embedded
	// app actually reads once the CLI's own terminal went away - it's left on by default purely as
	// a cheap `npm run dev` convenience, not because anything in production consumes it.
	log.transports.file.level = "silly"
	log.transports.console.level = consoleLevel

	const cleanupCallbacks = new Set<CleanupCallback>()

	function registerCleanup(fn: CleanupCallback) {
		cleanupCallbacks.add(fn)
	}

	function unregisterCleanup(fn: CleanupCallback) {
		cleanupCallbacks.delete(fn)
	}

	async function runCleanup() {
		for (const fn of [...cleanupCallbacks]) {
			try {
				await fn()
			} catch {
				// A cleanup callback failing shouldn't prevent the rest of cleanup (or the fatal
				// error itself) from proceeding.
			}
		}

		cleanupCallbacks.clear()

		rpkgInstance.exit()
	}

	async function cleanExit() {
		await runCleanup()
	}

	/** Shared by `logger.error()` - run cleanup and throw instead of `process.exit()`. */
	async function fatalError(text: string): Promise<never> {
		await runCleanup()
		throw new CoreFatalError(text)
	}

	const logger: Logger = {
		async verbose(text, mod) {
			log.verbose(...(mod ? [`[${mod}]`, text] : [text]))
		},

		async debug(text, mod) {
			log.debug(...(mod ? [`[${mod}]`, text] : [text]))
		},

		async info(text, mod) {
			log.info(...(mod ? [`[${mod}]`, text] : [text]))
		},

		async warn(text, mod) {
			log.warn(...(mod ? [`[${mod}]`, text] : [text]))
		},

		async error(text, exitAfter = true, mod) {
			log.error(...(mod ? [`[${mod}]`, text] : [text]))

			if (mod) {
				console.trace() // It's unimportant where framework errors come from
			}

			// Unlike the old logLevel-gated version of this branch, the fatal exitAfter path always
			// runs regardless of consoleLevel - whether a stage prints to the console is cosmetic;
			// whether a deploy actually stops on a real error should never depend on it.
			if (exitAfter) {
				await fatalError(text)
			}
		}
	}

	return {
		FrameworkVersion,
		isDevBuild,
		rpkgInstance,
		config,
		logger,
		paths: {
			dataRoot,
			toolsRoot
		},
		options: {
			consoleLevel
		},
		registerCleanup,
		unregisterCleanup,
		cleanExit
	}
}
