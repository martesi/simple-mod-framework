/**
 * Cooperative cancellation for `deploy()` (core/deploy.ts) - deliberately coarse. `deploy()` only
 * ever checks {@link isCancelActive} at the top of its two per-item loops ("Analyse mods",
 * "Execute instructions"), never mid-instruction, so a cancel takes effect at the next loop
 * boundary rather than instantly.
 *
 * Once {@link enterFinalizePhase} is called (right after the "Execute instructions" loop finishes,
 * before Contract destinations/Localisation/Thumbs/Package definition/Generate RPKGs - the stages
 * that write directly into the game's live Retail/Runtime folder with no staging-then-atomic-
 * rename), cancellation is permanently locked out for the rest of this run: {@link isCancelActive}
 * returns false from then on even if a cancel was already requested, because interrupting a
 * mid-write to Runtime risks corrupting the actual game install, not just mod output.
 *
 * Module-level singleton, same "one active core per module realm" bridge pattern as
 * `core-singleton.ts` - each deploy runs in its own fresh worker thread (see `deployManager.ts`'s
 * `spawnDeployWorker`), so there's exactly one deploy's worth of state per module realm and no
 * reset-between-runs is needed.
 */

export class DeployCancelledError extends Error {
	constructor() {
		super("Deploy cancelled")
		this.name = "DeployCancelledError"
	}
}

let cancelRequested = false
let finalizeEntered = false

export function requestCancel(): void {
	cancelRequested = true
}

export function enterFinalizePhase(): void {
	finalizeEntered = true
}

export function isCancelActive(): boolean {
	return cancelRequested && !finalizeEntered
}

export function throwIfCancelled(): void {
	if (isCancelActive()) {
		throw new DeployCancelledError()
	}
}
