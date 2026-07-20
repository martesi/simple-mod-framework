import { contextBridge, ipcRenderer, shell } from 'electron'
import fsExtra from 'fs-extra'
import path from 'path'
import klaw from 'klaw-sync'
import sanitizeHtml from 'sanitize-html'
import child_process from 'child_process'
import originalFs from 'original-fs'

const fs = (fsExtra as any).default || fsExtra

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('fs', fs)
    contextBridge.exposeInMainWorld('isFile', (p: string) => fs.statSync(p).isFile())
    contextBridge.exposeInMainWorld('originalFs', originalFs)
    contextBridge.exposeInMainWorld('path', path)
    contextBridge.exposeInMainWorld('klaw', klaw)
    contextBridge.exposeInMainWorld('Buffer', {
      isBuffer: Buffer.isBuffer,
      from: Buffer.from
    })
    contextBridge.exposeInMainWorld('ipc', {
      send: (channel: string, data?: any) => {
        ipcRenderer.send(channel, data)
      },
      sendSync: (channel: string, data?: any) => {
        return ipcRenderer.sendSync(channel, data)
      },
      receive: (channel: string, func: (...args: any[]) => void) => {
        ipcRenderer.on(channel, (_event, ...args) => func(...args))
      },
      receiveOnce: (channel: string, func: (...args: any[]) => void) => {
        ipcRenderer.once(channel, (_event, ...args) => func(...args))
      }
    })
    contextBridge.exposeInMainWorld('openExternalLink', (url: string) => shell.openExternal(url))
    contextBridge.exposeInMainWorld('sanitizeHtml', sanitizeHtml)
    contextBridge.exposeInMainWorld('child_process', child_process)
    contextBridge.exposeInMainWorld('nodeVersion', process.versions.node)
    contextBridge.exposeInMainWorld('electronVersion', process.versions.electron)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.fs = fs
  // @ts-ignore
  window.isFile = (p: string) => fs.statSync(p).isFile()
  // @ts-ignore
  window.originalFs = originalFs
  // @ts-ignore
  window.path = path
  // @ts-ignore
  window.klaw = klaw
  // @ts-ignore
  window.Buffer = { isBuffer: Buffer.isBuffer, from: Buffer.from }
  // @ts-ignore
  window.ipc = {
    send: (channel: string, data?: any) => ipcRenderer.send(channel, data),
    sendSync: (channel: string, data?: any) => ipcRenderer.sendSync(channel, data),
    receive: (channel: string, func: (...args: any[]) => void) => ipcRenderer.on(channel, (_event, ...args) => func(...args)),
    receiveOnce: (channel: string, func: (...args: any[]) => void) => ipcRenderer.once(channel, (_event, ...args) => func(...args))
  }
  // @ts-ignore
  window.openExternalLink = (url: string) => shell.openExternal(url)
  // @ts-ignore
  window.sanitizeHtml = sanitizeHtml
  // @ts-ignore
  window.child_process = child_process
  // @ts-ignore
  window.nodeVersion = process.versions.node
  // @ts-ignore
  window.electronVersion = process.versions.electron
}
