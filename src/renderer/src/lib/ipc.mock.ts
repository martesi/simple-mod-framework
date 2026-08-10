import type {
  DeployProgress,
  DeploySnapshot,
  GamePathPreview,
  ModBuildInfo,
  ModTaskUpdate,
  SmfApi,
  Unsubscribe,
} from './ipc'
import type { GamePlatform } from './manifest-types'
import {
  type Config,
  type DefaultPaths,
  type Manifest,
  type ModEntry,
  OptionType,
} from './manifest-types'

/**
 * STUB IMPLEMENTATION - see the big comment block in ipc.ts.
 *
 * Everything here is in-memory + localStorage. There is no real fs access,
 * no real archive extraction, and no real Deploy.exe invocation - this
 * exists purely so the UI has something believable to render and interact
 * with while LEI-133/134/136 land the real handlers.
 */

const CONFIG_KEY = 'smf-mock:config'
const MODS_KEY = 'smf-mock:mods'

/** Mirrors settings.ts's guessGameRoot() - strips a trailing "\Retail" so both cache/mod path previews sit under the actual game root. */
function guessGameRoot(gamePath: string): string {
  return gamePath.replace(/\\Retail$/i, '')
}

/** Mirrors settings.ts's resolveTempDir()'s ".smf/tmp"-under-game-root default, just enough to look plausible in the mock. */
function previewCachePath(gamePath: string): string {
  return `${guessGameRoot(gamePath)}\\.smf\\tmp`
}

/** Mirrors settings.ts's resolveModsDir()'s ".smf/mods"-under-game-root default, just enough to look plausible in the mock. */
function previewModPath(gamePath: string): string {
  return `${guessGameRoot(gamePath)}\\.smf\\mods`
}

function uuid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

function makeManifest(partial: Partial<Manifest> & Pick<Manifest, 'id' | 'name'>): Manifest {
  return {
    description: '',
    authors: [],
    version: '1.0.0',
    frameworkVersion: '3.0.0',
    ...partial,
  }
}

const seedMods: ModEntry[] = [
  {
    id: 'atampy26.SilentAssassinSuitPack',
    isFrameworkMod: true,
    manifest: makeManifest({
      id: 'atampy26.SilentAssassinSuitPack',
      name: 'Silent Assassin Suit Pack',
      description: 'Adds 12 additional suits themed around the Silent Assassin rating.',
      authors: ['atampy26'],
      options: [
        {
          name: 'Unlock suits immediately',
          type: OptionType.checkbox,
          enabledByDefault: false,
          tooltip: 'Skip the in-game unlock requirements.',
          image: 'https://picsum.photos/seed/smf-unlock/300/200',
        },
        {
          name: 'Classic',
          type: OptionType.select,
          group: 'Suit tint',
          enabledByDefault: true,
          image: 'https://picsum.photos/seed/smf-classic/300/200',
        },
        {
          name: 'Midnight',
          type: OptionType.select,
          group: 'Suit tint',
          image: 'https://picsum.photos/seed/smf-midnight/300/200',
        },
        {
          name: 'Ash',
          type: OptionType.select,
          group: 'Suit tint',
          image: 'https://picsum.photos/seed/smf-ash/300/200',
        },
        { name: 'Charcoal', type: OptionType.select, group: 'Suit tint' },
      ],
    }),
  },
  {
    id: 'InderpreetSK.CustomLoadoutMenu',
    isFrameworkMod: true,
    manifest: makeManifest({
      id: 'InderpreetSK.CustomLoadoutMenu',
      name: 'Custom Loadout Menu',
      description: 'Replaces the loadout selection screen with a searchable grid and favorites.',
      authors: ['InderpreetSK'],
    }),
  },
  {
    id: 'notex.HDTextureOverhaulParis',
    isFrameworkMod: true,
    outdated: true,
    manifest: makeManifest({
      id: 'notex.HDTextureOverhaulParis',
      name: 'HD Texture Overhaul — Paris',
      description: '4K retextures for the Paris courtyard and manor interiors.',
      authors: ['notex'],
      frameworkVersion: '2.1.0',
    }),
  },
  {
    id: 'atampy26.SniperAssassinUnlocker',
    isFrameworkMod: true,
    manifest: makeManifest({
      id: 'atampy26.SniperAssassinUnlocker',
      name: 'Sniper Assassin Unlocker',
      description: 'Unlocks all Sniper Assassin maps and loadouts from the start.',
      authors: ['atampy26'],
      options: [{ name: 'Include DLC maps', type: OptionType.checkbox, enabledByDefault: true }],
    }),
  },
  {
    id: 'rox.ChongqingAmbientOverhaul',
    isFrameworkMod: true,
    manifest: makeManifest({
      id: 'rox.ChongqingAmbientOverhaul',
      name: 'Chongqing Ambient Overhaul',
      description: 'Reworks crowd density and ambient audio for a livelier city feel.',
      authors: ['rox'],
    }),
  },
  {
    id: 'markusA.ElusiveTargetReplayPack',
    isFrameworkMod: true,
    manifest: makeManifest({
      id: 'markusA.ElusiveTargetReplayPack',
      name: 'Elusive Target Replay Pack',
      description: 'Re-enables 14 retired Elusive Targets for offline replay.',
      authors: ['markusA'],
    }),
  },
  {
    id: 'chunk_extras_v3',
    isFrameworkMod: false,
    rpkgModName: 'chunk_extras_v3',
  },
  {
    id: 'kereminde.ModernWeaponPack',
    isFrameworkMod: true,
    manifest: makeManifest({
      id: 'kereminde.ModernWeaponPack',
      name: 'Modern Weapon Pack',
      description: 'Adds 6 real-world-inspired weapon reskins across all disciplines.',
      authors: ['kereminde'],
      options: [
        { name: 'Replace default pistol', type: OptionType.checkbox, enabledByDefault: false },
      ],
    }),
  },
]

function loadMods(): ModEntry[] {
  try {
    const raw = localStorage.getItem(MODS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // fall through to seed
  }
  return structuredClone(seedMods)
}

function saveMods(mods: ModEntry[]) {
  localStorage.setItem(MODS_KEY, JSON.stringify(mods))
}

function defaultConfig(mods: ModEntry[]): Config {
  const modOptions: Record<string, string[]> = {}
  for (const mod of mods) {
    if (!mod.manifest?.options) continue
    modOptions[mod.id] = mod.manifest.options
      .filter((o) => o.type !== OptionType.conditional && o.enabledByDefault)
      .map((o) => (o.type === OptionType.select ? `${o.group}:${o.name}` : o.name))
  }

  return {
    loadOrder: mods
      .filter(
        (m) =>
          m.id !== 'markusA.ElusiveTargetReplayPack' &&
          m.id !== 'chunk_extras_v3' &&
          m.id !== 'kereminde.ModernWeaponPack'
      )
      .map((m) => m.id),
    modOrder: mods.map((m) => m.id),
    knownMods: mods.map((m) => m.id),
    modOptions,
    developerMode: false,
    reportErrors: undefined,
    themeMode: 'system',
    accent: 'neutral',
    gamePath: '',
    cachePath: '',
    modPath: '',
    language: 'en-US',
    gamePlatform: undefined,
    gamePlatformChoiceRequired: false,
  }
}

function loadConfig(mods: ModEntry[]): Config {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) return { ...defaultConfig(mods), ...JSON.parse(raw) }
  } catch {
    // fall through to default
  }
  return defaultConfig(mods)
}

function saveConfig(config: Config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

class MockSmfApi implements SmfApi {
  private modsData: ModEntry[] = loadMods()
  private cfg: Config = loadConfig(this.modsData)
  private taskListeners = new Set<(u: ModTaskUpdate) => void>()
  private cacheProgressListeners = new Set<(p: { scanned: number; total: number }) => void>()
  private progressListeners = new Set<(p: DeployProgress) => void>()
  private activeSnapshot: DeploySnapshot | null = null
  private deployTimer: ReturnType<typeof setInterval> | null = null
  private deployStage: DeployProgress['stage'] | null = null

  config = {
    get: async (): Promise<Config> => structuredClone(this.cfg),
    merge: async (patch: Partial<Config>): Promise<Config> => {
      this.cfg = { ...this.cfg, ...patch }
      saveConfig(this.cfg)
      return structuredClone(this.cfg)
    },

    // No real filesystem/dialog outside a real Electron shell - just simulate a successful pick
    // after a beat, same "believable" spirit as the rest of this mock. `persist: false` (the setup
    // wizard - see ipc.ts's doc comment) skips the write and hands back a preview instead, mirroring
    // the real backend's toUiConfig-against-a-hypothetical-gamePath trick.
    pickGameDirectory: async (
      persist = true,
      selectedPlatform?: GamePlatform
    ): Promise<{ ok: true; config: Config } | { ok: false; error: string }> => {
      await delay(300)
      const gamePath = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\HITMAN 3'
      const gamePlatform = selectedPlatform ?? 'steam'
      if (!persist) {
        return {
          ok: true,
          config: {
            ...structuredClone(this.cfg),
            gamePath,
            cachePath: previewCachePath(gamePath),
            modPath: previewModPath(gamePath),
            gamePlatform,
            gamePlatformChoiceRequired: false,
          },
        }
      }
      this.cfg = {
        ...this.cfg,
        gamePath,
        cachePath: previewCachePath(gamePath),
        modPath: previewModPath(gamePath),
        gamePlatform,
        gamePlatformChoiceRequired: false,
      }
      saveConfig(this.cfg)
      return { ok: true, config: structuredClone(this.cfg) }
    },

    // No real userData/OS username to read outside a real Electron shell - this mock just has to
    // look plausible. The real backend (settings.ts's resolveDefaultUiPaths()) returns actual
    // dataRoot-based paths instead of a made-up "C:\Users\you\..." string.
    getDefaultPaths: async (): Promise<DefaultPaths> => {
      await delay(50)
      return {
        gamePath: 'C:\\Games\\HITMAN3',
        cachePath: 'C:\\Users\\you\\AppData\\Roaming\\Mod Manager\\cache',
        modPath: 'C:\\Users\\you\\AppData\\Roaming\\Mod Manager\\Mods',
      }
    },

    // Mirrors the real backend's config:previewPaths - both cachePath and modPath move with the
    // hypothetical gamePath (settings.ts's resolveTempDir()/resolveModsDir() both derive from the
    // game root by default).
    previewPaths: async (
      gamePath: string,
      gamePlatform?: 'steam' | 'epic' | 'microsoft'
    ): Promise<GamePathPreview> => {
      await delay(50)
      return {
        ok: true,
        cachePath: previewCachePath(gamePath),
        modPath: previewModPath(gamePath),
        gamePlatform: gamePlatform ?? 'steam',
        gamePlatformChoiceRequired: false,
      }
    },
  }

  system = {
    pickDirectory: async (): Promise<string | null> => {
      await delay(300)
      return 'C:\\Users\\you\\Documents\\SMF'
    },
  }

  mods = {
    list: async (): Promise<ModEntry[]> => structuredClone(this.modsData),

    // No real disk to check outside a real Electron shell - the wizard's mod-path step just gets
    // whatever's already in memory, same "believable" spirit as the rest of this mock, regardless
    // of what path was actually typed.
    previewFolder: async (dir: string): Promise<{ exists: boolean; count: number }> => {
      await delay(300)
      return { exists: dir.length > 0, count: this.modsData.length }
    },

    // No real disk to re-walk outside a real Electron shell - just simulate the "please wait,
    // re-scanning" beat the real handler's chunked fs walk (modIndex.ts's rebuildChunked()) incurs,
    // firing a couple of believable progress ticks along the way, then hand back whatever's
    // already in memory.
    rebuildIndex: async (): Promise<ModEntry[]> => {
      const total = this.modsData.length || 1
      for (let scanned = 1; scanned <= total; scanned++) {
        await delay(400 / total)
        for (const cb of this.cacheProgressListeners) cb({ scanned, total })
      }
      return structuredClone(this.modsData)
    },

    beginAdd: (file: { name: string; size: number; path: string }): string => {
      const taskId = uuid()
      const label = file.name.replace(/\.(zip|7z|rar|rpkg)$/i, '')
      const looksLikeArchive = /\.(zip|7z|rar|rpkg)$/i.test(file.name)

      const emit = (u: Omit<ModTaskUpdate, 'taskId' | 'label'>) => {
        for (const cb of this.taskListeners) cb({ taskId, label, ...u })
      }

      // Simulate an independent async pipeline per add - deliberately not
      // awaited here, and nothing here touches a shared lock, so calling
      // beginAdd() again immediately for a different file proceeds in
      // parallel without waiting on this one.
      ;(async () => {
        emit({ status: 'queued' })
        await delay(200)

        if (!looksLikeArchive) {
          emit({
            status: 'error',
            message: "This doesn't look like a mod - expected a .zip, .7z, .rar, or .rpkg file.",
          })
          return
        }

        emit({ status: 'extracting' })
        await delay(500)
        emit({ status: 'validating' })
        await delay(400)

        if (this.modsData.some((m) => m.id === label)) {
          emit({
            status: 'error',
            message: `"${label}" is already installed (same destination folder).`,
          })
          return
        }

        emit({ status: 'installing' })
        await delay(400)

        const isRpkg = /\.rpkg$/i.test(file.name)
        const newMod: ModEntry = isRpkg
          ? { id: label, isFrameworkMod: false, rpkgModName: label }
          : {
              id: label,
              isFrameworkMod: true,
              manifest: makeManifest({
                id: label,
                name: label,
                description: 'Recently added mod.',
              }),
            }

        this.modsData = [...this.modsData, newMod]
        this.cfg = {
          ...this.cfg,
          knownMods: [...this.cfg.knownMods, newMod.id],
          modOrder: [...this.cfg.modOrder, newMod.id],
        }
        saveMods(this.modsData)
        saveConfig(this.cfg)

        emit({ status: 'done', modId: newMod.id })
      })()

      return taskId
    },

    onTaskUpdate: (cb: (update: ModTaskUpdate) => void): Unsubscribe => {
      this.taskListeners.add(cb)
      return () => this.taskListeners.delete(cb)
    },

    onCacheProgress: (cb: (progress: { scanned: number; total: number }) => void): Unsubscribe => {
      this.cacheProgressListeners.add(cb)
      return () => this.cacheProgressListeners.delete(cb)
    },

    remove: async (modId: string): Promise<{ ok: boolean; reason?: string }> => {
      if (this.activeSnapshot) {
        return {
          ok: false,
          reason:
            "A deploy is currently running. Deploy.exe reads mod folders throughout the run, so mods can't be removed until it finishes.",
        }
      }
      await delay(150)
      this.modsData = this.modsData.filter((m) => m.id !== modId)
      this.cfg = {
        ...this.cfg,
        loadOrder: this.cfg.loadOrder.filter((a) => a !== modId),
        modOrder: this.cfg.modOrder.filter((a) => a !== modId),
        knownMods: this.cfg.knownMods.filter((a) => a !== modId),
      }
      saveMods(this.modsData)
      saveConfig(this.cfg)
      return { ok: true }
    },

    // No real cache.db outside a real Electron shell - every mod just reports "ready" immediately,
    // since this mock has nothing that could ever be "building".
    buildStatuses: async (): Promise<ModBuildInfo[]> => {
      await delay(50)
      return this.modsData
        .filter((m) => m.isFrameworkMod)
        .map((m) => ({ modId: m.id, status: 'ready' as const }))
    },

    rebuildCacheDb: async (): Promise<{ ok: boolean; reason?: string }> => {
      if (this.activeSnapshot) return { ok: false, reason: 'A deploy is currently running.' }
      const total = this.modsData.length || 1
      for (let scanned = 1; scanned <= total; scanned++) {
        await delay(300 / total)
        for (const cb of this.cacheProgressListeners) cb({ scanned, total })
      }
      return { ok: true }
    },
  }

  deploy = {
    start: async (): Promise<DeploySnapshot> => {
      // The snapshot is frozen here - "server-side" - at the instant deploy
      // starts. Live config edits after this point (toggling mods, changing
      // options, reordering) must not affect this in-flight run.
      const snapshot: DeploySnapshot = {
        snapshotId: uuid(),
        snapshotTime: Date.now(),
        loadOrder: [...this.cfg.loadOrder],
      }
      this.activeSnapshot = snapshot

      if (this.deployTimer) clearInterval(this.deployTimer)

      const stages: DeployProgress['stage'][] = ['sorting', 'extracting', 'patching', 'finalizing']
      let stageIndex = 0
      let modIndex = 0

      const tick = () => {
        const stage = stages[stageIndex]
        this.deployStage = stage
        const isPatching = stage === 'patching'
        const modTotal = snapshot.loadOrder.length

        if (isPatching && modIndex < modTotal) {
          const currentModId = snapshot.loadOrder[modIndex]
          this.emitProgress({
            stage,
            stageIndex,
            stageTotal: stages.length,
            currentModId,
            modIndex,
            modTotal,
            logLine: `Patching ${currentModId}`,
            done: false,
          })
          modIndex++
          return
        }

        this.emitProgress({
          stage,
          stageIndex,
          stageTotal: stages.length,
          modTotal,
          logLine: `${stage[0].toUpperCase()}${stage.slice(1)}...`,
          done: false,
        })

        stageIndex++
        modIndex = 0

        if (stageIndex >= stages.length) {
          if (this.deployTimer) clearInterval(this.deployTimer)
          this.deployTimer = null
          this.emitProgress({
            stage: 'finalizing',
            stageIndex: stages.length - 1,
            stageTotal: stages.length,
            logLine: 'Done.',
            done: true,
            ok: true,
          })
          this.activeSnapshot = null
          this.deployStage = null
        }
      }

      this.deployTimer = setInterval(tick, 600)
      return structuredClone(snapshot)
    },

    onProgress: (cb: (progress: DeployProgress) => void): Unsubscribe => {
      this.progressListeners.add(cb)
      return () => this.progressListeners.delete(cb)
    },

    getActiveSnapshot: (): DeploySnapshot | null =>
      this.activeSnapshot ? structuredClone(this.activeSnapshot) : null,

    analyseMod: async (modId: string): Promise<{ ok: boolean; error?: string }> => {
      await delay(200)
      return this.modsData.some((m) => m.id === modId)
        ? { ok: true }
        : { ok: false, error: `"${modId}" isn't installed.` }
    },

    cancel: async (snapshotId: string): Promise<{ ok: boolean; error?: string }> => {
      await delay(50)
      if (!this.activeSnapshot || this.activeSnapshot.snapshotId !== snapshotId) {
        return { ok: false, error: 'No matching active deploy.' }
      }

      // Mirrors the real safe-window lockout: once the simulated run has reached "finalizing",
      // cancellation is no longer honoured.
      if (this.deployStage === 'finalizing') {
        return { ok: false, error: 'Deploy is finalizing and can no longer be cancelled.' }
      }

      if (this.deployTimer) {
        clearInterval(this.deployTimer)
        this.deployTimer = null
      }
      this.emitProgress({
        stage: 'finalizing',
        stageIndex: 3,
        stageTotal: 4,
        logLine: 'Deploy cancelled.',
        done: true,
        ok: false,
      })
      this.activeSnapshot = null
      this.deployStage = null
      return { ok: true }
    },
  }

  private emitProgress(p: DeployProgress) {
    for (const cb of this.progressListeners) cb(p)
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createMockSmfApi(): SmfApi {
  return new MockSmfApi()
}
