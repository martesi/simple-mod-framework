/**
 * Cooperative cancellation for `deploy()` (core/deploy.ts) - deliberately coarse. `deploy()` only
 * ever checks {@link isCancelActive} at the top of its two per-item loops ("Analyse mods",
 * "Execute instructions"), never mid-instruction, so a cancel takes effect at the next loop
 * boundary rather than instantly.
 *
 * Once {@link enterFinalizePhase} is called (right after the "Execute instructions" loop finishes,
 * before Contract destinations/WWEV patches/Localisation/Localisation overrides/Thumbs/Package
 * definition/Generate RPKGs), cancellation is permanently locked out for the rest of this run:
 * {@link isCancelActive} returns false from then on even if a cancel was already requested. As of
 * LEI-151, the stages that actually write into the game's live Retail/Runtime folder (Thumbs,
 * Package definition, Generate RPKGs - the others only ever write into paths.dataRoot's own
 * staging/temp scratch dirs) do so via a staged-then-atomic-rename (utils.ts's
 * atomicCopyFileSync), so a kill here no longer risks leaving Runtime with a truncated file. The
 * lockout remains regardless: these stages also shell out to external tools (HMLanguageTools,
 * rpkgFunction.exe, h6xtea.exe) this app doesn't control and can't safely interrupt
 * mid-invocation - interrupting a live child process, not raw write safety, is now the actual
 * reason cancellation is refused here.
 *
 * Module-level singleton, same "one active core per module realm" bridge pattern as
 * `core-singleton.ts` - each deploy runs in its own fresh worker thread (see `deployManager.ts`'s
 * `spawnDeployWorker`), so there's exactly one deploy's worth of state per module realm and no
 * reset-between-runs is needed.
 */

export class DeployCancelledError extends Error {
  constructor() {
    super('Deploy cancelled')
    this.name = 'DeployCancelledError'
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
