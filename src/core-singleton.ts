import type { Config } from "./types"
import type { CleanupCallback, Core, Logger, ResolvedCoreOptions } from "./core"
import type RPKGInstance from "./rpkg"

/**
 * Bridge between the many modules in this codebase that do
 * `import { config, logger, rpkgInstance } from "./core-singleton"` (deploy.ts, analyseMod.ts,
 * discover.ts, difference.ts, utils.ts, quickentity-3.ts, quickentity-rs.ts, patchWorker.ts) and
 * whichever {@link Core} instance is actually active in this module realm.
 *
 * Unlike the old core.ts, importing this module has no side effects and assumes nothing -
 * {@link setCurrentCore} must be called (by the CLI entry point in main.ts, or a worker thread's
 * own bootstrap in patchWorker.ts) before any of the exports below are read. This is
 * intentionally still "one active core per module realm" rather than full dependency injection
 * through every function in the files above - threading a Core instance through every call in
 * deploy.ts's ~2000 lines is a much larger, separate change. This bridge is what lets core.ts
 * stop doing import-time work while keeping the rest of the codebase's shape unchanged.
 *
 * A worker thread (see patchWorker.ts) is its own module realm with its own independent copy of
 * this module's state, so a deploy's worker threads don't share a core with the main thread or
 * with each other. Concurrent deploys sharing one *main*-thread realm are not yet safe and are
 * out of scope for this change - that's for whichever issue actually wires createCore() into a
 * long-lived Electron main process (LEI-133) to solve, by not relying on this bridge at all.
 */

let currentCore: Core | undefined

export function setCurrentCore(core: Core) {
	currentCore = core

	FrameworkVersion = core.FrameworkVersion
	isDevBuild = core.isDevBuild
	rpkgInstance = core.rpkgInstance
	config = core.config
	logger = core.logger
	options = core.options
}

export function getCurrentCore(): Core {
	if (!currentCore) {
		throw new Error(
			"No active core - createCore() must be called (and its result passed to setCurrentCore()) before using the framework. See main.ts's CLI bootstrap or patchWorker.ts's per-worker-thread bootstrap."
		)
	}

	return currentCore
}

// eslint-disable-next-line prefer-const
export let FrameworkVersion: string
// eslint-disable-next-line prefer-const
export let isDevBuild: boolean
// eslint-disable-next-line prefer-const
export let rpkgInstance: RPKGInstance
// eslint-disable-next-line prefer-const
export let config: Config
// eslint-disable-next-line prefer-const
export let logger: Logger
// eslint-disable-next-line prefer-const
export let options: ResolvedCoreOptions

export function registerCleanup(fn: CleanupCallback): void {
	getCurrentCore().registerCleanup(fn)
}

export function unregisterCleanup(fn: CleanupCallback): void {
	getCurrentCore().unregisterCleanup(fn)
}

export function cleanExit(): Promise<void> {
	return getCurrentCore().cleanExit()
}
