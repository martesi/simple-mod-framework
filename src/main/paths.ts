import { resolve } from 'node:path'
import { app } from 'electron'

/**
 * Filesystem roots this process uses. `dataRoot` contains machine-level settings; the resolved
 * temp/mod roots are derived separately from those settings and passed to the relevant subsystems.
 * `toolsRoot` contains the bundled Third-Party/ tools and cleanMicrosoftThumbs.dat.
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
  /** Writable app-data root containing settings.json and other machine-level state. */
  dataRoot: string
  /** Read-only: bundled Third-Party/ tools, cleanMicrosoftThumbs.dat. */
  toolsRoot: string
}

let cached: AppPaths | undefined

export function resolveAppPaths(): AppPaths {
  if (cached) return cached

  const dataRoot = app.getPath('userData')

  const toolsRoot = app.isPackaged
    ? process.resourcesPath
    : // Dev: point straight at the repo's committed extra/ folder (Third-Party/,
      // cleanMicrosoftThumbs.dat) - this app *is* the repo root now (LEI-133's
      // CLI/Mod Manager merge), and extra/ already has the same layout
      // electron-builder.yml's extraResources gives resourcesPath when packaged,
      // so no separate build/ staging step is needed to mirror it anymore.
      resolve(app.getAppPath(), 'extra')

  cached = { dataRoot, toolsRoot }
  return cached
}
