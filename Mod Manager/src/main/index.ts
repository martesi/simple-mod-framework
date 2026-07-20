import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, resolve, dirname } from 'path'
import fs from 'fs-extra'
import windowStateManager from 'electron-window-state'
import contextMenu from 'electron-context-menu'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn } from 'child_process'

app.commandLine.appendSwitch('remote-debugging-port', '9222')

let mainWindow: BrowserWindow | null = null

// In development mode, change the current working directory to build/Mod Manager
// so that all relative file paths (like "../config.json", "../Mods", and "../Deploy.exe")
// resolve correctly to the build directory.
if (!app.isPackaged) {
  const devCwd = resolve(__dirname, '..', '..', '..', 'build', 'Mod Manager')
  if (fs.existsSync(devCwd)) {
    process.chdir(devCwd)
  }
}

function createWindow(): BrowserWindow {
  if (!fs.existsSync(join('..', 'Deploy.exe'))) {
    process.chdir(dirname(app.getPath('exe')))
    app.relaunch({ execPath: app.getPath('exe'), args: process.argv.slice(1) })
    app.exit()
  }

  const windowState = windowStateManager({
    defaultWidth: 800,
    defaultHeight: 600
  })

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: true,
      spellcheck: false,
      webSecurity: false,
      preload: fs.existsSync(join(__dirname, '../preload/index.mjs'))
        ? join(__dirname, '../preload/index.mjs')
        : join(__dirname, '../preload/index.js')
    }
  })

  windowState.manage(win)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.argv[process.argv.length - 1] && process.argv[process.argv.length - 1].startsWith('simple-mod-framework://')) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('urlScheme', process.argv.pop()?.replace('simple-mod-framework://', ''))
    })
  }

  win.on('close', () => {
    windowState.saveState(win)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('simple-mod-framework', process.execPath, [resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('simple-mod-framework')
}

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }

    if (commandLine[commandLine.length - 1] && commandLine[commandLine.length - 1].startsWith('simple-mod-framework://')) {
      mainWindow?.webContents.send('urlScheme', commandLine.pop()?.replace('simple-mod-framework://', ''))
    }
  })

  contextMenu({
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    showCopyImage: false
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.atampy26.simple-mod-framework.mod-manager')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    mainWindow = createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// IPC Handlers
ipcMain.on('deploy', () => {
  const deployProcess = spawn('Deploy.exe --doNotPause --colors', ['--doNotPause --colors'], {
    shell: true,
    cwd: '..'
  })

  let deployOutput = ''

  mainWindow?.webContents.send('frameworkDeployModalOpen')

  deployProcess.stdout.on('data', (data: Buffer) => {
    deployOutput += String(data)
    mainWindow?.webContents.send('frameworkDeployOutput', deployOutput)
  })

  deployProcess.stderr.on('data', (data: Buffer) => {
    deployOutput += String(data)
    mainWindow?.webContents.send('frameworkDeployOutput', deployOutput)
  })

  deployProcess.on('close', () => {
    mainWindow?.webContents.send('frameworkDeployFinished')
  })
})

ipcMain.on('modFileOpenDialog', () => {
  mainWindow?.webContents.send(
    'modFileOpenDialogResult',
    dialog.showOpenDialogSync({
      title: 'Add a mod file',
      buttonLabel: 'Select',
      filters: [{ name: 'Mod Files', extensions: ['zip', '7z', 'rar', 'rpkg'] }],
      properties: ['openFile', 'dontAddToRecent']
    })
  )
})

ipcMain.on('runtimePackageOpenDialog', () => {
  mainWindow?.webContents.send(
    'runtimePackageOpenDialogResult',
    dialog.showOpenDialogSync({
      title: 'Select an RPKG file',
      buttonLabel: 'Select',
      filters: [{ name: 'RPKG Files', extensions: ['rpkg'] }],
      properties: ['openFile', 'dontAddToRecent']
    })
  )
})

ipcMain.on('imageOpenDialog', () => {
  mainWindow?.webContents.send(
    'imageOpenDialogResult',
    dialog.showOpenDialogSync({
      title: 'Select an image',
      buttonLabel: 'Select',
      filters: [{ name: 'Image Files', extensions: ['png', 'jpg', 'apng', 'gif', 'webp', 'svg', 'jpeg', 'jfif'] }],
      properties: ['openFile', 'dontAddToRecent']
    })
  )
})

ipcMain.on('relaunchApp', () => {
  app.relaunch()
  app.exit()
})
