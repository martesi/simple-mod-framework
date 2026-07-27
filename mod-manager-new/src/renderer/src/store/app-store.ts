import { create } from "zustand"
import { getSmfApi } from "@/lib/ipc"
import type { DeployProgress, DeploySnapshot, ModTaskUpdate } from "@/lib/ipc"
import type { Config, ModEntry } from "@/lib/manifest-types"

export interface AddTask extends ModTaskUpdate {
  startedAt: number
}

interface DeployState {
  open: boolean
  snapshot: DeploySnapshot | null
  progress: DeployProgress | null
  log: string[]
  logExpanded: boolean
}

interface AppState {
  loaded: boolean
  config: Config | null
  mods: ModEntry[]
  addTasks: Record<string, AddTask>
  deploy: DeployState
  systemDark: boolean

  init(): Promise<void>

  setSearch(search: string): void
  search: string

  toggleMod(modId: string): void
  reorderMods(orderedIds: string[]): void
  setCheckboxOption(modId: string, optionName: string, enabled: boolean): void
  setSelectOption(modId: string, group: string, optionName: string): void

  addModFile(file: { name: string; size: number }): void
  removeMod(modId: string): Promise<{ ok: boolean; reason?: string }>
  updateOutdated(modId: string): Promise<void>

  startDeploy(): Promise<void>
  closeDeploy(): void
  toggleDeployLog(): void

  setThemeMode(mode: Config["themeMode"]): void
  setAccent(accent: Config["accent"]): void
  toggleDevMode(): void
  setReportErrors(value: boolean): void
}

export const useAppStore = create<AppState>((set, get) => ({
  loaded: false,
  config: null,
  mods: [],
  addTasks: {},
  search: "",
  systemDark: typeof window !== "undefined" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false) : false,
  deploy: { open: false, snapshot: null, progress: null, log: [], logExpanded: false },

  async init() {
    const smf = getSmfApi()
    const [config, mods] = await Promise.all([smf.config.get(), smf.mods.list()])
    set({ config, mods, loaded: true })

    smf.mods.onTaskUpdate((update) => {
      set((s) => ({ addTasks: { ...s.addTasks, [update.taskId]: { ...update, startedAt: s.addTasks[update.taskId]?.startedAt ?? Date.now() } } }))

      if (update.status === "done") {
        // A task finishing is exactly the kind of external mutation that
        // should refresh the mods list without disturbing anything else the
        // user is doing (per-row, non-blocking - see ipc.ts).
        smf.mods.list().then((mods) => set({ mods }))
        setTimeout(() => {
          set((s) => {
            const next = { ...s.addTasks }
            delete next[update.taskId]
            return { addTasks: next }
          })
        }, 4000)
      }

      if (update.status === "error") {
        setTimeout(() => {
          set((s) => {
            const next = { ...s.addTasks }
            delete next[update.taskId]
            return { addTasks: next }
          })
        }, 6000)
      }
    })

    smf.deploy.onProgress((progress) => {
      set((s) => ({
        deploy: {
          ...s.deploy,
          progress,
          log: progress.logLine ? [...s.deploy.log, progress.logLine] : s.deploy.log
        }
      }))
    })

    if (typeof window !== "undefined") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)")
      mq.addEventListener("change", (e) => set({ systemDark: e.matches }))
    }
  },

  setSearch(search) {
    set({ search })
  },

  toggleMod(modId) {
    const { config } = get()
    if (!config) return
    const enabled = config.loadOrder.includes(modId)
    // Toggling never touches modOrder - a disabled mod keeps the shelf
    // position it was dragged to, and slots back into that spot in
    // loadOrder if it's re-enabled later.
    const loadOrder = enabled ? config.loadOrder.filter((id) => id !== modId) : config.modOrder.filter((id) => id === modId || config.loadOrder.includes(id))
    set({ config: { ...config, loadOrder } })
    getSmfApi().config.merge({ loadOrder })
  },

  reorderMods(orderedIds) {
    const { config } = get()
    if (!config) return
    const loadOrder = orderedIds.filter((id) => config.loadOrder.includes(id))
    set({ config: { ...config, modOrder: orderedIds, loadOrder } })
    getSmfApi().config.merge({ modOrder: orderedIds, loadOrder })
  },

  setCheckboxOption(modId, optionName, enabled) {
    const { config } = get()
    if (!config) return
    const current = config.modOptions[modId] ?? []
    const next = enabled ? [...current.filter((o) => o !== optionName), optionName] : current.filter((o) => o !== optionName)
    const modOptions = { ...config.modOptions, [modId]: next }
    set({ config: { ...config, modOptions } })
    getSmfApi().config.merge({ modOptions })
  },

  setSelectOption(modId, group, optionName) {
    const { config } = get()
    if (!config) return
    const current = config.modOptions[modId] ?? []
    const next = [...current.filter((o) => !o.startsWith(`${group}:`)), `${group}:${optionName}`]
    const modOptions = { ...config.modOptions, [modId]: next }
    set({ config: { ...config, modOptions } })
    getSmfApi().config.merge({ modOptions })
  },

  addModFile(file) {
    // Fire-and-forget on purpose: this must never block a second call for a
    // different file made a moment later.
    getSmfApi().mods.beginAdd(file)
  },

  async removeMod(modId) {
    const result = await getSmfApi().mods.remove(modId)
    if (result.ok) {
      const smf = getSmfApi()
      const [config, mods] = await Promise.all([smf.config.get(), smf.mods.list()])
      set({ config, mods })
    }
    return result
  },

  async updateOutdated(modId) {
    const updated = await getSmfApi().mods.updateOutdated(modId)
    set((s) => ({ mods: s.mods.map((m) => (m.id === modId ? updated : m)) }))
  },

  async startDeploy() {
    const snapshot = await getSmfApi().deploy.start()
    set({ deploy: { open: true, snapshot, progress: null, log: [], logExpanded: false } })
  },

  closeDeploy() {
    set((s) => ({ deploy: { ...s.deploy, open: false } }))
  },

  toggleDeployLog() {
    set((s) => ({ deploy: { ...s.deploy, logExpanded: !s.deploy.logExpanded } }))
  },

  setThemeMode(themeMode) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, themeMode } })
    getSmfApi().config.merge({ themeMode })
  },

  setAccent(accent) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, accent } })
    getSmfApi().config.merge({ accent })
  },

  toggleDevMode() {
    const { config } = get()
    if (!config) return
    const developerMode = !config.developerMode
    set({ config: { ...config, developerMode } })
    getSmfApi().config.merge({ developerMode })
  },

  setReportErrors(value) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, reportErrors: value } })
    getSmfApi().config.merge({ reportErrors: value })
  }
}))
