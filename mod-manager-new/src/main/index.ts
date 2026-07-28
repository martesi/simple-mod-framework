import { join } from "node:path"
import { app, shell, BrowserWindow } from "electron"
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.atampy26.simple-mod-framework.mod-manager")

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerModImageProtocolHandler()
  registerIpcHandlers(resolveAppPaths())

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
