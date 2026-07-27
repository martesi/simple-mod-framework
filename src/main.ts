import * as Sentry from "@sentry/node"
import * as Tracing from "@sentry/tracing"
import * as LosslessJSON from "lossless-json"

import { DateTime, Duration, DurationLikeObject } from "luxon"
import type { Span, Transaction } from "@sentry/tracing"

import { Platform } from "./types"
import analyseMod, { loadRPKGHashCache, saveRPKGHashCache } from "./analyseMod"
import { CoreFatalError, createCore } from "./core"
import { setCurrentCore } from "./core-singleton"
import deploy from "./deploy"
import difference from "./difference"
import discover from "./discover"
import arg from "arg"
import fs from "fs-extra"
import md5File from "md5-file"
import path from "path"
import { xxhash3 } from "hash-wasm"

import "clarify"

/* ---------------------------------------------------------------------------------------------- */
/*   CLI bootstrap. This is the only place in the framework that reads process.argv, parses       */
/*   config.json off disk as a side effect of starting up, and owns the process's exit code -      */
/*   core.ts/rpkg.ts/deploy.ts are meant to be embeddable and never call process.exit() or touch   */
/*   argv themselves; this file is where "what does a fatal deploy error mean" gets decided for    */
/*   the CLI build specifically (an embedder, e.g. the mod manager's main process, would have its  */
/*   own equivalent of this file that reacts differently - by surfacing to a UI instead of         */
/*   exiting the whole process).                                                                  */
/* ---------------------------------------------------------------------------------------------- */

const cliArgs = arg(
	{
		"--useConsoleLogging": Boolean,
		"--pauseAfterLogging": Boolean,
		"--doNotPause": Boolean,
		"--logLevel": [String],
		"--analyseMod": String
	},
	{
		permissive: true
	}
)

const core = createCore(path.join(process.cwd(), "config.json"), {
	useConsoleLogging: cliArgs["--useConsoleLogging"],
	pauseAfterLogging: cliArgs["--pauseAfterLogging"],
	doNotPause: cliArgs["--doNotPause"] ?? false, // the CLI pauses on a fatal error by default, unlike embedded callers of createCore()
	logLevel: cliArgs["--logLevel"]?.length ? cliArgs["--logLevel"] : undefined
})

setCurrentCore(core)

const gameHashes = {
	"b894cfa2f11b6db52db587a21de688b2": Platform.epic, // base game
	"6ce4ebfdd9e22e179206281d818850f5": Platform.epic, // ansel unlock
	//"09278760d4943ad21d04921169366d54": Platform.epic, // ansel no collision
	//"a8752bc4b36a74600549778685db3b4c": Platform.epic, // ansel unlock + no collision
	"4f1b7753a40359bde5d4aa013257c5f1": Platform.steam, // base game
	"406865e7486cbc3b77a5f22fd73fbe00": Platform.steam, // ansel unlock
	//"28607baf7a75271b6924fe0d52263600": Platform.steam, // ansel no collision
	//"d028074b654cb628ef88ced7b5d3eb96": Platform.steam, // ansel unlock + no collision

	// Gamepass/store protects the EXE from reading so we can't hash it, instead we hash the game config
	"cfdf300263b03d625099226882eafe84": Platform.microsoft
} as {
	[k: string]: Platform
}

if (!core.config.reportErrors) {
	process.on("uncaughtException", (err, origin) => {
		void (async () => {
			if (!cliArgs["--useConsoleLogging"]) {
				await core.logger.warn("Error reporting is disabled; if you experience this issue again, please enable it so that the problem can be debugged.")
			}

			await core.logger.error(`Uncaught exception! ${err}`, false)
			console.error(origin)
			await core.cleanExit()
			process.exit()
		})()
	})

	process.on("unhandledRejection", (err, origin) => {
		void (async () => {
			if (!cliArgs["--useConsoleLogging"]) {
				await core.logger.warn("Error reporting is disabled; if you experience this issue again, please enable it so that the problem can be debugged.")
			}

			await core.logger.error(`Unhandled promise rejection! ${err}`, false)
			console.error(origin)
			await core.cleanExit()
			process.exit()
		})()
	})
}

if (!fs.existsSync(core.config.runtimePath)) {
	void core.logger.error("The Runtime folder couldn't be located, please re-read the installation instructions!")
}

if (!(fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg")) || fs.existsSync(path.join(core.config.runtimePath, "..", "Retail", "HITMAN3.exe")))) {
	void core.logger.error("HITMAN3.exe couldn't be located, please re-read the installation instructions!")
}

if (fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg")) && !fs.existsSync(path.join(core.config.retailPath, "..", "MicrosoftGame.Config"))) {
	void core.logger.error("The game config couldn't be located, please re-read the installation instructions!")
}

if (fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg"))) {
	try {
		fs.accessSync(path.join(core.config.retailPath, "thumbs.dat"), fs.constants.R_OK | fs.constants.W_OK)
	} catch {
		void core.logger.error("thumbs.dat couldn't be accessed; try running Mod Manager.exe in the similarly named folder as administrator!")
	}
}

const detectedPlatform = fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg"))
	? gameHashes[md5File.sync(path.join(core.config.retailPath, "..", "MicrosoftGame.Config"))]
	: gameHashes[md5File.sync(path.join(core.config.runtimePath, "..", "Retail", "HITMAN3.exe"))] // Platform detection

// PATCH: an unrecognised game hash (e.g. after a game update) normally aborts the
// deploy with "Unknown game version". Instead, fall back to Steam so deploys keep
// working on updated/unknown builds. See PATCH_NOTICE.md.
core.config.platform = detectedPlatform ?? Platform.steam
if (typeof detectedPlatform === "undefined") {
	void core.logger.warn("Unknown game version — assuming Steam (patched fallback, see PATCH_NOTICE.md). If deploy misbehaves, the framework likely needs updating for this game build.")
}

let sentryTransaction = {
	startChild(...args) {
		return {
			startChild(...args) {
				return {
					startChild(...args) {
						return {
							startChild(...args) {
								return {
									startChild(...args) {
										return {
											startChild(...args) {
												return {
													startChild(...args) {
														return {
															finish(...args) {}
														}
													},
													finish(...args) {}
												}
											},
											finish(...args) {}
										}
									},
									finish(...args) {}
								}
							},
							finish(...args) {}
						}
					},
					finish(...args) {}
				}
			},
			finish(...args) {}
		}
	},
	finish(...args) {}
} as Transaction

function configureSentryScope(transaction: Span) {
	// if (core.config.reportErrors)
	// 	Sentry.configureScope((scope) => {
	// 		scope.setSpan(transaction)
	// 	})
}

function toHuman(dur: Duration) {
	const units: (keyof DurationLikeObject)[] = ["years", "months", "days", "hours", "minutes", "seconds", "milliseconds"]
	const smallestIdx = units.indexOf("seconds")
	const entries = Object.entries(
		dur
			.shiftTo(...units)
			.normalize()
			.toObject()
	).filter(([_, amount], idx) => amount > 0 && idx <= smallestIdx)
	return entries.map((a) => a[1] + a[0][0]).join("")
}

process.on("SIGINT", () => void core.logger.error("Received SIGINT signal"))
process.on("SIGTERM", () => void core.logger.error("Received SIGTERM signal"))

/**
 * Platform-version validation and error-reporting bootstrap shared by every command (full deploy
 * or `--analyseMod`). A mod's analysis script gets the full effective config (including
 * `platform`), and if error reporting is on, uncaught exceptions during `--analyseMod` should be
 * reported the same way they are during a full deploy - so both paths need this, not just deploy.
 */
async function initialiseCommon() {
	if (typeof core.config.platform === "undefined") {
		await core.logger.error(
			"Unknown game version. If the game has recently updated, wait for a framework update to be released; the developers are already aware. If you're using a cracked version of the game, that's the problem."
		)
	}

	if (core.config.reportErrors) {
		await core.logger.info("Initialising error reporting")

		Sentry.init({
			dsn: "https://464c3dd1424b4270803efdf7885c1b90@o1144555.ingest.sentry.io/6208676",
			release: core.isDevBuild ? "dev" : core.FrameworkVersion,
			environment: core.isDevBuild ? "dev" : "production",
			tracesSampleRate: 0.5,
			integrations: [
				new Sentry.Integrations.OnUncaughtException({
					onFatalError: (err) => {
						if (!String(err).includes("write EPIPE")) {
							void core.logger.info("Reporting an error:").then(() => {
								void core.logger.error(`Uncaught exception! ${err}`, false)
							})
						}
					}
				}),
				new Sentry.Integrations.OnUnhandledRejection({
					mode: "strict"
				})
			]
		})

		Sentry.setUser({
			id: core.config.errorReportingID!
		})

		// sentryTransaction = Sentry.startTransaction({
		// 	op: "deploy",
		// 	name: "Deploy"
		// })

		// Sentry.configureScope((scope) => {
		// 	scope.setSpan(sentryTransaction)
		// })

		Sentry.setTag(
			"game_hash",
			fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg"))
				? md5File.sync(path.join(core.config.retailPath, "..", "MicrosoftGame.Config"))
				: md5File.sync(path.join(core.config.runtimePath, "..", "Retail", "HITMAN3.exe"))
		)
	}
}

/**
 * `Deploy --analyseMod <id>`: analyse a single mod and (re)populate its analysis cache entry,
 * without running the full discover/difference/deploy pipeline. Meant to be invoked by the mod
 * manager whenever a mod is added/updated or its selected options change, so that a subsequent
 * full deploy can load this mod's cached deployInstruction instead of re-walking/re-parsing it -
 * see analyseMod.ts and deploy.ts's "Analyse mods" phase.
 */
async function doAnalyseModThing() {
	await initialiseCommon()

	const startedDate = DateTime.now()

	await core.logger.verbose("Initialising RPKG instance")
	await core.rpkgInstance.waitForInitialised()

	fs.ensureDirSync(path.join(process.cwd(), "cache"))
	loadRPKGHashCache()

	const modId = cliArgs["--analyseMod"]!
	await core.logger.info(`Analysing ${modId}`)
	await analyseMod(modId)

	saveRPKGHashCache()

	await core.logger.info(`Done in ${toHuman(startedDate.until(DateTime.now()).toDuration()) || "less than a second"}`)

	await core.cleanExit()
}

async function doTheThing() {
	await initialiseCommon()

	const startedDate = DateTime.now()

	await core.logger.verbose("Initialising RPKG instance")
	await core.rpkgInstance.waitForInitialised()

	await core.logger.verbose("Removing existing patch files")
	for (const chunkPatchFile of fs.readdirSync(core.config.runtimePath)) {
		try {
			if (chunkPatchFile.includes("patch")) {
				const match = chunkPatchFile.match(/^chunk[0-9]+patch([0-9]+)\.rpkg$/)
				if (match) {
					const patchNumber = parseInt(match[1])
					if (patchNumber >= 200 && patchNumber <= 300) {
						// The mod framework manages patch files between 200 (inc) and 300 (inc), allowing mods to place runtime files in those ranges
						fs.rmSync(path.join(core.config.runtimePath, chunkPatchFile))
					}
				} else {
					await core.logger.warn(`${chunkPatchFile} in your Runtime folder is not from the vanilla game. This might cause issues with SMF - move it elsewhere!`)
				}
			} else if (chunkPatchFile.match(/^chunk[0-9]+\.rpkg$/)) {
				if (parseInt(chunkPatchFile.split(".")[0].slice(5)) > 30) {
					fs.rmSync(path.join(core.config.runtimePath, chunkPatchFile))
				}
			} else if (chunkPatchFile !== "packagedefinition.txt") {
				await core.logger.warn(`${chunkPatchFile} in your Runtime folder is not from the vanilla game. This might cause issues with SMF - move it elsewhere!`)
			}
		} catch {}
	}

	await core.logger.verbose("Emptying folders")
	fs.emptyDirSync(path.join(process.cwd(), "staging"))
	fs.emptyDirSync(path.join(process.cwd(), "temp"))

	await core.logger.verbose("Beginning discovery")
	const fileMap = await discover()
	fs.ensureDirSync(path.join(process.cwd(), "cache"))

	await core.logger.verbose("Checking cache versions")
	if (fs.existsSync(path.join(process.cwd(), "cache", "map.json"))) {
		if (
			fs.readJSONSync(path.join(process.cwd(), "cache", "map.json")).frameworkVersion < core.FrameworkVersion ||
			fs.readJSONSync(path.join(process.cwd(), "cache", "map.json")).game !==
				(fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg"))
					? md5File.sync(path.join(core.config.retailPath, "..", "MicrosoftGame.Config"))
					: md5File.sync(path.join(core.config.runtimePath, "..", "Retail", "HITMAN3.exe")))
		) {
			fs.emptyDirSync(path.join(process.cwd(), "cache")) // Empty the cache when the framework or game updates
		}
	}

	await core.logger.verbose("Beginning difference")
	const { invalidData } = await difference(fs.existsSync(path.join(process.cwd(), "cache", "map.json")) ? fs.readJSONSync(path.join(process.cwd(), "cache", "map.json")).files : {}, fileMap)

	await core.logger.verbose("Writing cache")
	fs.writeJSONSync(path.join(process.cwd(), "cache", "map.json"), {
		files: fileMap,
		frameworkVersion: core.FrameworkVersion,
		game: fs.existsSync(path.join(core.config.retailPath, "Runtime", "chunk0.rpkg"))
			? md5File.sync(path.join(core.config.retailPath, "..", "MicrosoftGame.Config"))
			: md5File.sync(path.join(core.config.runtimePath, "..", "Retail", "HITMAN3.exe"))
	})

	await core.logger.verbose("Beginning deploy")
	const { lastServerSideStates } = (await deploy(sentryTransaction, configureSentryScope, invalidData))!

	await core.logger.verbose("Finishing")

	if (core.config.outputConfigToAppDataOnDeploy) {
		fs.ensureDirSync(path.join(process.env.LOCALAPPDATA!, "Simple Mod Framework"))
		fs.writeFileSync(
			path.join(process.env.LOCALAPPDATA!, "Simple Mod Framework", "lastDeploy.json"),
			LosslessJSON.stringify({
				...core.config,
				lastServerSideStates
			})
		)
	}

	await core.logger.info(`Done in ${toHuman(startedDate.until(DateTime.now()).toDuration()) || "less than a second"}`)

	await core.cleanExit()
}

/**
 * core.logger.error() (and RPKGInstance's fatal-crash path) now throws/rejects instead of calling
 * `process.exit()` - see LEI-129. This is the one place that decides what that means for the CLI
 * build: exit 1. A clean run of either command falls through to exit 0, matching the old
 * `core.cleanExit()`'s unconditional `process.exit()` (exit code 0).
 */
async function run() {
	try {
		if (cliArgs["--analyseMod"]) {
			await doAnalyseModThing()
		} else {
			await doTheThing()
		}

		process.exit(0)
	} catch (err) {
		if (!(err instanceof CoreFatalError)) {
			// A CoreFatalError means logger.error() already printed/logged the failure - anything
			// else is an unexpected bug, so make sure it's visible before the process goes down.
			console.error(err)
		}

		process.exit(1)
	}
}

void run()
