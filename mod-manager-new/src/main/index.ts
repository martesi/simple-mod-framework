import { join } from "node:path"
import { app, shell, BrowserWindow } from "electron"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"

/**
 * UI-only stub main process (LEI-137). This deliberately does not touch
 * fs/child_process, doesn't spawn Deploy.exe, and doesn't read config.json -
 * it just opens a window and loads the renderer, which talks to the mocked
 * contract in src/renderer/src/lib/ipc.ts. Real handlers land in LEI-134
 * (moving fs/child_process off the renderer) and LEI-133 (embedded core +
 * game directory picker + userData settings).
 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
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
