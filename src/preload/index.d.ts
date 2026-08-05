import { ElectronAPI } from "@electron-toolkit/preload"

/**
 * The raw shape `contextBridge.exposeInMainWorld("smf", ...)` puts on
 * `window.smf` (see preload/index.ts). Deliberately loose/`unknown`-typed on
 * the wire - `renderer/src/lib/ipc.electron.ts` is what gives this the real,
 * strongly-typed `SmfApi` shape the rest of the UI codes against.
 */
export interface SmfBridge {
  config: {
    get(): Promise<unknown>
    merge(patch: unknown): Promise<unknown>
    pickGameDirectory(persist?: boolean): Promise<unknown>
    getDefaultPaths(): Promise<unknown>
    previewPaths(gamePath: string): Promise<unknown>
  }
  system: {
    pickDirectory(options?: { title?: string }): Promise<string | null>
  }
  mods: {
    list(): Promise<unknown>
    previewFolder(dir: string): Promise<unknown>
    rebuildIndex(): Promise<unknown>
    beginAdd(file: { name: string; size: number; path: string }): string
    onTaskUpdate(callback: (update: unknown) => void): () => void
    onCacheProgress(callback: (progress: unknown) => void): () => void
    remove(modId: string): Promise<unknown>
    buildStatuses(): Promise<unknown>
    rebuildCacheDb(): Promise<unknown>
  }
  deploy: {
    start(): Promise<unknown>
    onProgress(callback: (progress: unknown) => void): () => void
    getActiveSnapshot(): Promise<unknown>
    analyseMod(modId: string): Promise<unknown>
    cancel(snapshotId: string): Promise<unknown>
  }
  getPathForFile(file: File): string
}

declare global {
  interface Window {
    electron: ElectronAPI
    smf: SmfBridge
  }
}
