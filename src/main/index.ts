import { join } from "node:path"
import { app, dialog, shell, BrowserWindow } from "electron"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import { resolveAppPaths } from "./paths"
import { registerIpcHandlers } from "./ipcHandlers"
import { registerModImageProtocolHandler, registerModImageSchemePrivileges } from "./modImages"

/**
 * LEI-134: this app no longer needs (and no longer grants) raw Node access
 * in the renderer. `nodeIntegration`/`contextIsolation`/`sandbox` are left
 * at Electron's own current secure defaults (false/true/true) rather than
 * merely relying on them silently - the point of this file, historically,
 * was the *opposite* combination in the old Svelte app's
 * `Mod Manager/src/main/index.ts` (`nodeIntegration: true`,
 * `webSecurity: false` alongside `contextIsolation: true`), which gave the
 * renderer unrestricted disk/process access despite context isolation being
 * on. Everything the renderer needs now goes through the `smf` API exposed
 * by `src/preload/index.ts`, backed by the `ipcMain.handle` channels in
 * `ipcHandlers.ts` - see that file and `ipc.ts` for the contract.
 */
registerModImageSchemePrivileges()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: "deny" }
  })

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

let forceQuit = false

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.atampy26.simple-mod-framework.mod-manager")

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerModImageProtocolHandler()
  const deployManager = registerIpcHandlers(resolveAppPaths())

  // Closing the app (window close, taskbar quit, Cmd/Alt+Q) while a deploy is running today just
  // kills the process with no warning. `deploy()`'s finalize stage (see core/cancel.ts's doc
  // comment) shells out to external tools (HMLanguageTools, rpkgFunction.exe, h6xtea.exe) this app
  // doesn't control - an uncontrolled kill mid-invocation there can still leave one of those
  // half-run against a live game file, even though the writes deploy() itself makes into Retail/
  // Runtime are staged-then-atomic-rename (LEI-151) and no longer the risk they used to be. This
  // doesn't make quitting mid-deploy safe - it just makes sure the user is told before it happens,
  // same as the in-app Cancel action being locked out past "Finalizing deploy" rather than
  // silently allowed.
  app.on("before-quit", (event) => {
    if (forceQuit || !deployManager.isActive()) return
    event.preventDefault()

    dialog
      .showMessageBox(BrowserWindow.getAllWindows()[0] ?? null, {
        type: "warning",
        buttons: ["Quit anyway", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "Deploy in progress",
        detail: "Quitting now may leave your game files in a partially-patched state. Quit anyway?"
      })
      .then(({ response }) => {
        if (response === 0) {
          forceQuit = true
          app.quit()
        }
      })
  })

  createWindow()

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
