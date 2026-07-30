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
  /** True from init() until the first mods.list() resolves - see init()'s doc comment for why this is split off from `loaded`. */
  modsLoading: boolean
  /** Progress of an in-flight main-process cache scan (cold start, "Rebuild cache", or a modPath switch) - null when nothing is scanning. */
  cacheProgress: { scanned: number; total: number } | null
  addTasks: Record<string, AddTask>
  addDialogOpen: boolean
  deploy: DeployState
  systemDark: boolean

  init(): Promise<void>
  /** Subscribes to the `smf` IPC push channels (deploy progress, mod task updates) plus the OS dark-mode media query, and returns a cleanup function that undoes all of it. Split out of `init()` (see App.tsx) so React - StrictMode's dev-mode double-invoke included - can mount/cleanup/remount this effect and always land on exactly one live subscription of each, instead of `init()` leaking a second one every time it re-ran. */
  initListeners(): () => void

  setSearch(search: string): void
  search: string

  toggleMod(modId: string): void
  reorderMods(orderedIds: string[]): void
  /** Persists a mod's full enabled-option list in one shot - see the implementation's doc comment for why this replaced per-click setCheckboxOption()/setSelectOption(). */
  commitModOptions(modId: string, options: string[]): void

  addModFile(file: { name: string; size: number; path: string }): void
  /** Resolves each dropped/picked `File` to a real on-disk path and kicks off its add task - shared by AddModDialog's own dropzone and the whole-window drop handler in App.tsx. Opens the Add Mod dialog so progress is visible regardless of which one triggered it. */
  addFiles(files: FileList | File[]): void
  openAddDialog(): void
  closeAddDialog(): void
  removeMod(modId: string): Promise<{ ok: boolean; reason?: string }>
  updateOutdated(modId: string): Promise<void>
  /** Whether a rebuildIndex() call is in flight - lets the "Rebuild cache" button show a spinner and disable itself, mirroring the old Mod Manager's "please wait" modal for the same (synchronous, on the main-process side) full-disk-walk operation. */
  rebuildingIndex: boolean
  rebuildIndex(): Promise<void>

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
  setModPath(path: string): Promise<void>
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
  modsLoading: true,
  cacheProgress: null,
  rebuildingIndex: false,
  addTasks: {},
  addDialogOpen: false,
  search: "",
  systemDark: typeof window !== "undefined" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false) : false,
  deploy: { open: false, expanded: false, snapshot: null, progress: null, log: [], logExpanded: false },
  wizard: { open: false, step: 0 },

  async init() {
    const smf = getSmfApi()
    // config.get()/config.getDefaultPaths() are cheap in-memory reads on the main side - only
    // mods.list() can be slow (a full Mods/ folder walk the very first time this launch, or after a
    // modPath switch - see ipcHandlers.ts's mods:list). It used to be lumped into this same
    // Promise.all(), which meant `loaded` (and so the whole app, per App.tsx's `if (!loaded ...)`
    // guard) stayed on a blank "Loading Mod Manager..." screen for as long as that scan took, with
    // no feedback at all. Split it off: `loaded` flips as soon as config is in hand, so the real UI
    // (nav, Settings, the Mods screen shell) is interactable immediately, and `mods`/`modsLoading`
    // fill in a moment later - see ModsScreen.tsx's cache-building banner, driven by
    // `modsLoading`/`cacheProgress`, and initListeners()'s onCacheProgress subscription below.
    const [config, defaultPaths] = await Promise.all([smf.config.get(), smf.config.getDefaultPaths()])
    // An empty gamePath is the sentinel loadSettings() writes for a brand-new
    // settings.json (see settings.ts's defaultSettings()/loadSettings() doc
    // comments) - i.e. "no config found yet". Open straight into the wizard
    // in that case instead of the normal mods screen, matching new-ui/Mod
    // Manager.dc.html's wizardOpen:true initial state.
    // Plain data fetch, no subscriptions - safe to call more than once (StrictMode's double
    // effect invoke included), since re-running it just re-fetches and re-sets the same kind of
    // data rather than accumulating anything. See initListeners() for the subscription half.
    set({ config, defaultPaths, loaded: true, modsLoading: true, wizard: { open: !config.gamePath, step: 0 } })

    const mods = await smf.mods.list()

    // mods:list's own addKnownMods() write-through (see ipcHandlers.ts) may have just registered
    // mods that were already sitting on disk before this app ever indexed them - e.g. a modPath
    // just pointed at an existing folder migrated from the old Mod Manager - into knownMods/
    // modOrder on disk. The `config` this store is holding was fetched *before* that write-through
    // ran, so its modOrder is still the pre-registration snapshot; left alone, toggleMod()'s
    // `config.modOrder.filter(...)` below would never find those mods' ids and flipping their
    // switch would silently produce the same loadOrder it started with. Re-fetching here is cheap
    // (config:get is an in-memory read, same as the one in the Promise.all above) and keeps this
    // store's config in sync with whatever mods:list just persisted.
    const freshConfig = await smf.config.get()
    set({ mods, modsLoading: false, cacheProgress: null, config: freshConfig })
  },

  initListeners() {
    const smf = getSmfApi()

    const unsubscribeTaskUpdate = smf.mods.onTaskUpdate((update) => {
      set((s) => ({ addTasks: { ...s.addTasks, [update.taskId]: { ...update, startedAt: s.addTasks[update.taskId]?.startedAt ?? Date.now() } } }))

      if (update.status === "done") {
        // A task finishing is exactly the kind of external mutation that
        // should refresh the mods list without disturbing anything else the
        // user is doing (per-row, non-blocking - see ipc.ts). A fresh install
        // also just ran its own addKnownMods() write-through (see
        // modOps.ts), same hazard as init()/setModPath()/rebuildIndex()
        // above - re-fetch config too, or the just-installed mod's id won't
        // be in this store's modOrder yet and its switch won't do anything.
        smf.mods.list().then((mods) => {
          set({ mods })
          smf.config.get().then((config) => set({ config }))
        })
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

    const unsubscribeCacheProgress = smf.mods.onCacheProgress((progress) => {
      set({ cacheProgress: progress })
    })

    const unsubscribeProgress = smf.deploy.onProgress((progress) => {
      set((s) => ({
        deploy: {
          ...s.deploy,
          progress,
          log: progress.logLine ? [...s.deploy.log, progress.logLine] : s.deploy.log
        }
      }))
    })

    let mq: MediaQueryList | undefined
    let onSystemDarkChange: ((e: MediaQueryListEvent) => void) | undefined
    if (typeof window !== "undefined") {
      mq = window.matchMedia("(prefers-color-scheme: dark)")
      onSystemDarkChange = (e) => set({ systemDark: e.matches })
      mq.addEventListener("change", onSystemDarkChange)
    }

    return () => {
      unsubscribeTaskUpdate()
      unsubscribeCacheProgress()
      unsubscribeProgress()
      mq?.removeEventListener("change", onSystemDarkChange!)
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

  /**
   * The *only* place a mod's option selections reach `config`/disk. ModSettingsDrawer.tsx keeps its
   * own local draft of the enabled-option list while it's open (instant, drawer-scoped re-renders
   * only) and calls this once when it closes, instead of every single checkbox/radio click calling
   * through to here directly (the old setCheckboxOption()/setSelectOption(), removed).
   *
   * That old per-click version updated the *global* `config` object on every click - and since
   * ModsScreen.tsx subscribes to `config` (for loadOrder/modOrder), every click forced a full
   * mods-list reconciliation pass along with it. With many mods installed that reconciliation is
   * real, visible work, so a single checkbox click could feel like it took a long time - not because
   * the click handler itself was slow, but because of everything it dragged along with it. Batching
   * every change made during one drawer session into one commit (and one settings.json write) fixes
   * both problems at once: instant local feedback while the drawer is open, and only one list
   * re-render + one disk write per drawer visit instead of one per click.
   */
  commitModOptions(modId, options) {
    const { config } = get()
    if (!config) return
    const modOptions = { ...config.modOptions, [modId]: options }
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

  async rebuildIndex() {
    set({ rebuildingIndex: true, cacheProgress: null })
    try {
      const mods = await getSmfApi().mods.rebuildIndex()
      // Same addKnownMods() write-through hazard as init()/setModPath() above: a rebuild can
      // surface mods dropped into the Mods folder outside this app entirely (see
      // ipcHandlers.ts's mods:rebuildIndex doc comment), and this store's `config` needs a
      // fresh modOrder/knownMods to actually be able to enable them afterward.
      const freshConfig = await getSmfApi().config.get()
      set({ mods, config: freshConfig })
      toast.success("Mod cache rebuilt.")
    } finally {
      set({ rebuildingIndex: false, cacheProgress: null })
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

  async setModPath(modPath) {
    const { config } = get()
    if (!config) return
    set({ config: { ...config, modPath } })
    await getSmfApi().config.merge({ modPath })
    // Pointing at a different folder means a genuinely different set of mods live there - the main
    // process just force-rebuilt its index against it and registered whatever was already sitting
    // in that folder into knownMods/modOrder (see ipcHandlers.ts's config:merge -> addKnownMods()),
    // so re-fetch both here instead of leaving the mod list showing whatever was in the old folder
    // and `config` (specifically modOrder) stuck on the pre-switch snapshot. Without the config
    // re-fetch, toggleMod()'s `config.modOrder.filter(...)` would never find any mod that was only
    // just registered by this switch, and flipping its switch would silently do nothing - the exact
    // "picked a mod path with existing mods in it, now can't enable any of them" bug. Sequential,
    // not Promise.all'd: mods:list() has its own addKnownMods() write-through too (see
    // ipcHandlers.ts), so config:get() has to run *after* it resolves to see that write as well,
    // not just config:merge's.
    const mods = await getSmfApi().mods.list()
    const freshConfig = await getSmfApi().config.get()
    set({ mods, config: freshConfig })
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
    if (picked) await get().setModPath(picked)
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
