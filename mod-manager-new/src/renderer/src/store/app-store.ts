import { create } from "zustand"
import { toast } from "sonner"
import { getSmfApi } from "@/lib/ipc"
import type { DeployProgress, DeploySnapshot, ModTaskUpdate } from "@/lib/ipc"
import type { Config, DefaultPaths, ModEntry } from "@/lib/manifest-types"
import { WIZARD_STEPS } from "@/lib/wizard-steps"

export interface AddTask extends ModTaskUpdate {
  startedAt: number
}

interface DeployState {
  open: boolean
  /** Whether the toast is showing the step list, as opposed to just the collapsed header + progress bar. */
  expanded: boolean
  snapshot: DeploySnapshot | null
  progress: DeployProgress | null
  log: string[]
  logExpanded: boolean
}

interface WizardState {
  open: boolean
  step: number
}

interface AppState {
  loaded: boolean
  config: Config | null
  /** Example paths for the Paths card/wizard placeholder text - see ipc.ts's `config.getDefaultPaths()` doc comment. Null until `init()` resolves, same as `config`. */
  defaultPaths: DefaultPaths | null
  mods: ModEntry[]
  addTasks: Record<string, AddTask>
  addDialogOpen: boolean
  deploy: DeployState
  systemDark: boolean

  init(): Promise<void>

  setSearch(search: string): void
  search: string

  toggleMod(modId: string): void
  reorderMods(orderedIds: string[]): void
  setCheckboxOption(modId: string, optionName: string, enabled: boolean): void
  setSelectOption(modId: string, group: string, optionName: string): void

  addModFile(file: { name: string; size: number; path: string }): void
  /** Resolves each dropped/picked `File` to a real on-disk path and kicks off its add task - shared by AddModDialog's own dropzone and the whole-window drop handler in App.tsx. Opens the Add Mod dialog so progress is visible regardless of which one triggered it. */
  addFiles(files: FileList | File[]): void
  openAddDialog(): void
  closeAddDialog(): void
  removeMod(modId: string): Promise<{ ok: boolean; reason?: string }>
  updateOutdated(modId: string): Promise<void>

  startDeploy(): Promise<void>
  closeDeploy(): void
  toggleDeployExpanded(): void
  toggleDeployLog(): void

  setThemeMode(mode: Config["themeMode"]): void
  setAccent(accent: Config["accent"]): void
  toggleDevMode(): void
  setReportErrors(value: boolean): void

  setGamePath(path: string): void
  setCachePath(path: string): void
  setModPath(path: string): void
  setLanguage(language: string): void

  browseGamePath(): Promise<void>
  browseCachePath(): Promise<void>
  browseModPath(): Promise<void>

  wizard: WizardState
  openWizard(): void
  closeWizard(): void
  wizardBack(): void
  wizardNext(): void
}

export const useAppStore = create<AppState>((set, get) => ({
  loaded: false,
  config: null,
  defaultPaths: null,
  mods: [],
  addTasks: {},
  addDialogOpen: false,
  search: "",
  systemDark: typeof window !== "undefined" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false) : false,
  deploy: { open: false, expanded: false, snapshot: null, progress: null, log: [], logExpanded: false },
  wizard: { open: false, step: 0 },

  async init() {
    const smf = getSmfApi()
    const [config, mods, defaultPaths] = await Promise.all([smf.config.get(), smf.mods.list(), smf.config.getDefaultPaths()])
    // An empty gamePath is the sentinel loadSettings() writes for a brand-new
    // settings.json (see settings.ts's defaultSettings()/loadSettings() doc
    // comments) - i.e. "no config found yet". Open straight into the wizard
    // in that case instead of the normal mods screen, matching new-ui/Mod
    // Manager.dc.html's wizardOpen:true initial state.
    set({ config, mods, defaultPaths, loaded: true, wizard: { open: !config.gamePath, step: 0 } })

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

  addFiles(files) {
    // `File.path` was removed from Electron's renderer-exposed File object for security reasons -
    // `getPathForFile` (exposed via preload's `webUtils.getPathForFile`, see LEI-134) is the
    // supported replacement, and the only way the main process can be told which real on-disk file
    // to extract without granting the renderer raw fs access itself. Ported from
    // AddModDialog.tsx's own addFiles() - now shared so a whole-window drop (App.tsx) and the
    // dialog's own dropzone both feed the same pipeline instead of drifting apart.
    for (const file of Array.from(files)) {
      const path = window.smf?.getPathForFile(file) ?? ""
      get().addModFile({ name: file.name, size: file.size, path })
    }
    // A drop anywhere in the app should surface the same progress UI a click on "Add a mod" would -
    // otherwise a whole-window drop silently starts installing with no visible feedback at all,
    // which is worse than not supporting whole-window drop in the first place.
    set({ addDialogOpen: true })
  },

  openAddDialog() {
    set({ addDialogOpen: true })
  },

  closeAddDialog() {
    set({ addDialogOpen: false })
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
    // There's no real auto-updater yet (LEI-98) - this call only re-reads whatever's on disk right
    // now. If it's still flagged outdated, clicking the badge genuinely did nothing visible, which
    // reads as broken rather than as "there's nothing to fetch here yet" - say so explicitly instead
    // of leaving the badge sitting there unchanged with no explanation.
    if (updated.outdated) {
      toast.info("Still on an older framework version - install the updated mod files yourself (Add a mod), then this badge will clear.")
    }
  },

  async startDeploy() {
    const snapshot = await getSmfApi().deploy.start()
    set({ deploy: { open: true, expanded: false, snapshot, progress: null, log: [], logExpanded: false } })
  },

  closeDeploy() {
    set((s) => ({ deploy: { ...s.deploy, open: false } }))
  },

  toggleDeployExpanded() {
    set((s) => ({ deploy: { ...s.deploy, expanded: !s.deploy.expanded } }))
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
  },

  setGamePath(gamePath) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, gamePath } })
    getSmfApi().config.merge({ gamePath })
  },

  setCachePath(cachePath) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, cachePath } })
    getSmfApi().config.merge({ cachePath })
  },

  setModPath(modPath) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, modPath } })
    getSmfApi().config.merge({ modPath })
  },

  setLanguage(language) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, language } })
    getSmfApi().config.merge({ language })
  },

  async browseGamePath() {
    const result = await getSmfApi().config.pickGameDirectory()
    if (result.ok) {
      set({ config: result.config })
    } else if (result.error) {
      // An empty error means the user just canceled the dialog - nothing to say.
      toast.error(result.error)
    }
  },

  async browseCachePath() {
    const picked = await getSmfApi().system.pickDirectory({ title: "Select a cache folder" })
    if (picked) get().setCachePath(picked)
  },

  async browseModPath() {
    const picked = await getSmfApi().system.pickDirectory({ title: "Select a mod folder" })
    if (picked) get().setModPath(picked)
  },

  openWizard() {
    set({ wizard: { open: true, step: 0 } })
  },

  closeWizard() {
    set((s) => ({ wizard: { ...s.wizard, open: false } }))
  },

  wizardBack() {
    set((s) => ({ wizard: { ...s.wizard, step: Math.max(0, s.wizard.step - 1) } }))
  },

  wizardNext() {
    set((s) => {
      if (s.wizard.step >= WIZARD_STEPS.length - 1) return { wizard: { ...s.wizard, open: false } }
      return { wizard: { ...s.wizard, step: s.wizard.step + 1 } }
    })
  }
}))
