import { resolve } from "node:path"
import { app } from "electron"

/**
 * Filesystem roots this process uses - mirrors {@link CoreOptions.paths} in
 * `src/core.ts` (dataRoot: writable, staging/cache/settings.json/Mods/Deploy.log;
 * toolsRoot: read-only, bundled Third-Party/ tools + cleanMicrosoftThumbs.dat).
 *
 * Unlike the old `Mod Manager/src/main/index.ts`, this never calls
 * `process.chdir()` - every consumer gets an absolute path up front instead
 * of relying on a mutated `process.cwd()`, which is both easier to reason
 * about and safe to call from more than one place (chdir is process-wide
 * global state; a resolved path is not).
 *
 * LEI-133's "userData settings" scope: `dataRoot` is now `app.getPath("userData")`
 * (a real per-user, per-install writable location, independent of where the
 * app itself is installed or where the game is) instead of the exe's own
 * folder - matching `core.ts`'s own doc comment ("Should be `app.getPath('userData')`
 * for Electron"). `toolsRoot` is `process.resourcesPath` when packaged (see
 * `electron-builder.yml`'s `extraResources`, mirroring the old Mod Manager's
 * LEI-131 setup) - both roots no longer need to be the same folder, since
 * nothing here relies on Deploy.exe/config.json sitting next to the game
 * install anymore (see settings.ts).
 */
export interface AppPaths {
  /** Writable: settings.json, Mods/, Deploy.log, cache/, staging/, temp/. */
  dataRoot: string
  /** Read-only: bundled Third-Party/ tools, cleanMicrosoftThumbs.dat. */
  toolsRoot: string
}

let cached: AppPaths | undefined

export function resolveAppPaths(): AppPaths {
  if (cached) return cached

  const dataRoot = app.getPath("userData")

  const toolsRoot = app.isPackaged
    ? process.resourcesPath
    : // Dev: point at the repo's shared `build/` fixture (Third-Party/,
      // cleanMicrosoftThumbs.dat) - this app *is* the repo root now (LEI-133's
      // CLI/Mod Manager merge), so build/ sits directly under it.
      resolve(app.getAppPath(), "build")

  cached = { dataRoot, toolsRoot }
  return cached
}
