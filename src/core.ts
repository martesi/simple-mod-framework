const FrameworkVersion = "2.33.40"
const isDevBuild = false

import * as Sentry from "@sentry/node"

import type { Config } from "./types"
import RPKGInstance from "./rpkg"
import chalk from "chalk"
import child_process from "child_process"
import fs from "fs-extra"
import json5 from "json5"
import path from "path"

/**
 * Options controlling how a {@link Core}'s logger behaves. All CLI-specific (console
 * printing/pausing) - an embedder (e.g. the mod manager's main process) will typically leave
 * these at their defaults.
 */
export interface CoreOptions {
	/** Print to the console (with ANSI colouring, no per-level filtering) instead of the default "write to Deploy.log and filter by logLevel" behaviour. Used by the CLI's `--useConsoleLogging` flag. */
	useConsoleLogging?: boolean

	/** In non-console-logging mode, which log levels get printed to stdout/stderr (everything is always appended to Deploy.log regardless). Defaults to every level. */
	logLevel?: string[]

	/** CLI-only debugging aid: block for a keypress after every logged line. */
	pauseAfterLogging?: boolean

	/**
	 * Skip the "press any key to continue" pause that normally follows a fatal error.
	 * Defaults to `true` (no pausing) because most embedders have no console to pause in -
	 * a real CLI entry point opts back into the interactive pause explicitly.
	 */
	doNotPause?: boolean
}

export interface Logger {
	verbose(text: string, mod?: string): Promise<void>
	debug(text: string, mod?: string): Promise<void>
	info(text: string, mod?: string): Promise<void>
	warn(text: string, mod?: string): Promise<void>

	/**
	 * Log an error. By default this is fatal - it runs cleanup (registered cleanup callbacks,
	 * Sentry, the RPKG process) and then throws a {@link CoreFatalError} instead of calling
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
	useConsoleLogging: boolean
	logLevel: string[]
	pauseAfterLogging: boolean
	doNotPause: boolean
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
	 * The options this Core was created with, normalised to concrete values. Lets a caller that
	 * only has access to a Core (not the original CoreOptions it was constructed with) spin up an
	 * equivalent one elsewhere - e.g. a Piscina worker thread bootstrapping its own Core so its
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

	/** Run the same cleanup a fatal error would (registered cleanups, Sentry, the RPKG process), without throwing - for a normal/successful end of a deploy. */
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
	const logLevel = options.logLevel?.length ? options.logLevel : ["debug", "info", "warn", "error"]
	const doNotPause = options.doNotPause ?? true

	const config: Config = typeof configOrPath === "string" ? json5.parse(fs.readFileSync(configOrPath, "utf8")) : configOrPath

	if (config.runtimePath === "..\\Runtime" && fs.existsSync(path.join(config.retailPath, "Runtime", "chunk0.rpkg"))) {
		config.runtimePath = "..\\Retail\\Runtime"

		if (typeof configOrPath === "string") {
			fs.writeFileSync(configOrPath, json5.stringify(config))
			fs.copyFileSync(path.join(process.cwd(), "cleanMicrosoftThumbs.dat"), path.join(process.cwd(), "cleanThumbs.dat"))
		}
	} // Automatically set runtime path and fix clean thumbs if using microsoft platform

	if (typeof config.reportErrors === "undefined") {
		config.reportErrors = false
		config.errorReportingID = null
	} // Do not report errors if no preference is set

	if (typeof config.developerMode === "undefined") {
		config.developerMode = false
	} // Assume user is not a developer if no preference is set

	config.runtimePath = path.resolve(process.cwd(), config.runtimePath)
	config.retailPath = path.resolve(process.cwd(), config.retailPath)

	const rpkgInstance = new RPKGInstance(path.join(process.cwd(), "Third-Party", "rpkg-cli"))

	const logFilePath = path.join(process.cwd(), "Deploy.log")

	/**
	 * Append-only write instead of the old "keep the whole log in a string and rewrite the entire
	 * file on every single log call" (O(n^2) total bytes written per deploy) - see LEI-129. There's
	 * no reason to keep the accumulated log text in memory either now that every call is just a
	 * single small write.
	 */
	function appendLog(line: string) {
		fs.appendFileSync(logFilePath, line)
	}

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

		await Sentry.close()

		rpkgInstance.exit()
	}

	async function cleanExit() {
		await runCleanup()
	}

	function pause() {
		child_process.execSync("pause", {
			// @ts-expect-error This code works and I'm not going to question it
			shell: true,
			stdio: "inherit"
		})
	}

	/** Shared by both logger flavours' `error()` - run cleanup and throw instead of `process.exit()`. */
	async function fatalError(text: string): Promise<never> {
		await runCleanup()
		throw new CoreFatalError(text)
	}

	const logger: Logger = options.useConsoleLogging
		? {
				async verbose(text, mod) {
					appendLog(`\nDETAIL\t${mod || "Deploy"}\t${text}`)
				},

				async debug(text, mod) {
					appendLog(`\nDEBUG\t${mod || "Deploy"}\t${text}`)
					console.debug("DEBUG", ...(mod ? [mod, text] : [text]))
				},

				async info(text, mod) {
					appendLog(`\nINFO\t${mod || "Deploy"}\t${text}`)
					console.info("INFO", ...(mod ? [mod, text] : [text]))
				},

				async warn(text, mod) {
					appendLog(`\nWARN\t${mod || "Deploy"}\t${text}`)
					console.warn("WARN", ...(mod ? [mod, text] : [text]))
				},

				async error(text, exitAfter = true, mod) {
					appendLog(`\nERROR\t${mod || "Deploy"}\t${text}`)
					console.log("ERROR", ...(mod ? [mod, text] : [text]))

					if (mod) {
						console.trace() // It's unimportant where framework errors come from
					}

					if (!doNotPause) {
						pause()
					}

					if (exitAfter) {
						await fatalError(text)
					}
				}
			}
		: {
				async verbose(text, mod) {
					appendLog(`\nDETAIL\t${mod || "Deploy"}\t${text}`)

					if (logLevel.includes("verbose")) {
						process.stdout.write(chalk(Object.assign([], { raw: [`{grey DETAIL${mod ? `\t${mod}` : ""}\t${text.replace(/\\/gi, "\\\\")}}\n`] })))

						if (options.pauseAfterLogging) {
							pause()
						}
					}
				},

				async debug(text, mod) {
					appendLog(`\nDEBUG\t${mod || "Deploy"}\t${text}`)

					if (logLevel.includes("debug")) {
						process.stdout.write(chalk(Object.assign([], { raw: [`{grey DEBUG${mod ? `\t${mod}` : ""}\t${text.replace(/\\/gi, "\\\\")}}\n`] })))

						if (options.pauseAfterLogging) {
							pause()
						}
					}
				},

				async info(text, mod) {
					appendLog(`\nINFO\t${mod || "Deploy"}\t${text}`)

					if (logLevel.includes("info")) {
						process.stdout.write(chalk(Object.assign([], { raw: [`{blue INFO}${mod ? `\t{magenta ${mod}}` : ""}\t${text.replace(/\\/gi, "\\\\")}\n`] })))

						if (options.pauseAfterLogging) {
							pause()
						}
					}
				},

				async warn(text, mod) {
					appendLog(`\nWARN\t${mod || "Deploy"}\t${text}`)

					if (logLevel.includes("warn")) {
						process.stdout.write(chalk(Object.assign([], { raw: [`{yellow WARN}${mod ? `\t{magenta ${mod}}` : ""}\t${text.replace(/\\/gi, "\\\\")}\n`] })))

						if (options.pauseAfterLogging) {
							pause()
						}
					}
				},

				async error(text, exitAfter = true, mod) {
					appendLog(`\nERROR\t${mod || "Deploy"}\t${text}`)

					// Matches the historical behaviour: if "error" isn't in the configured logLevel,
					// this call - including the fatal exitAfter path - is a no-op beyond the log file.
					if (logLevel.includes("error")) {
						process.stderr.write(chalk(Object.assign([], { raw: [`{red ERROR}${mod ? `\t{magenta ${mod}}` : ""}\t${text.replace(/\\/gi, "\\\\")}\n`] })))

						if (mod) {
							console.trace() // It's unimportant where framework errors come from
						}

						if (!doNotPause) {
							pause()
						}

						if (exitAfter) {
							await fatalError(text)
						}
					}
				}
			}

	return {
		FrameworkVersion,
		isDevBuild,
		rpkgInstance,
		config,
		logger,
		options: {
			useConsoleLogging: !!options.useConsoleLogging,
			logLevel,
			pauseAfterLogging: !!options.pauseAfterLogging,
			doNotPause
		},
		registerCleanup,
		unregisterCleanup,
		cleanExit
	}
}
