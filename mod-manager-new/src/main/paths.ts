import { dirname, resolve } from "node:path"
import { app } from "electron"

/**
 * Filesystem roots this process uses - mirrors {@link CoreOptions.paths} in
 * `src/core.ts` (dataRoot: writable, staging/cache/config.json/Mods/Deploy.log;
 * toolsRoot: read-only, bundled Third-Party/ tools). Both happen to be the
 * same folder for this app, same as the CLI's historical "everything sits
 * next to the exe" layout - see LEI-130/LEI-133's doc comments.
 *
 * Unlike the old `Mod Manager/src/main/index.ts`, this never calls
 * `process.chdir()` - every consumer gets an absolute path up front instead
 * of relying on a mutated `process.cwd()`, which is both easier to reason
 * about and safe to call from more than one place (chdir is process-wide
 * global state; a resolved path is not).
 *
 * Long-term this should move to `app.getPath("userData")` for user-specific
 * config and a resourcesPath-relative tools location (that's LEI-133's
 * "userData settings" scope) - kept pointed at the shared portable `build/`
 * folder for now so this app keeps working against the same config.json /
 * Mods/ / Deploy.exe / Third-Party/ layout the CLI and the old Mod Manager
 * already use.
 */
export interface AppPaths {
  /** Writable: config.json, Mods/, Deploy.log, cache/. */
  dataRoot: string
  /** Read-only: Deploy.exe, Third-Party/ tools. */
  toolsRoot: string
}

let cached: AppPaths | undefined

export function resolveAppPaths(): AppPaths {
  if (cached) return cached

  if (app.isPackaged) {
    const dir = dirname(app.getPath("exe"))
    cached = { dataRoot: dir, toolsRoot: dir }
  } else {
    // Dev: point at the repo's shared `build/` fixture (config.json, Mods/,
    // Third-Party/, Deploy.exe) - the same folder the old Mod Manager's dev
    // build used via `process.chdir(".../build/Mod Manager")` + `..`.
    const devRoot = resolve(app.getAppPath(), "..", "build")
    cached = { dataRoot: devRoot, toolsRoot: devRoot }
  }

  return cached
}
