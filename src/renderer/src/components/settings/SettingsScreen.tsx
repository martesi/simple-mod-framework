import { useState } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAppStore } from "@/store/app-store"
import { cn } from "@/lib/utils"
import { ACCENTS, ACCENT_LABELS, resolveDark, type Accent, type ThemeMode } from "@/lib/theme"
import { LANGUAGES } from "@/lib/languages"
import { PathInputRow } from "./PathInputRow"

const THEME_MODES: { key: ThemeMode; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "Auto" }
]

const ABOUT_LINKS = [
  { label: "Documentation", href: "https://github.com/atampy25/simple-mod-framework" },
  { label: "Report an issue", href: "https://github.com/atampy25/simple-mod-framework/issues" },
  { label: "Discord community", href: "https://discord.gg/" }
]

export function SettingsScreen() {
  const config = useAppStore((s) => s.config)
  const defaultPaths = useAppStore((s) => s.defaultPaths)
  const systemDark = useAppStore((s) => s.systemDark)
  const setThemeMode = useAppStore((s) => s.setThemeMode)
  const setAccent = useAppStore((s) => s.setAccent)
  const toggleDevMode = useAppStore((s) => s.toggleDevMode)
  const setGamePath = useAppStore((s) => s.setGamePath)
  const setCachePath = useAppStore((s) => s.setCachePath)
  const setModPath = useAppStore((s) => s.setModPath)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const browseGamePath = useAppStore((s) => s.browseGamePath)
  const browseCachePath = useAppStore((s) => s.browseCachePath)
  const browseModPath = useAppStore((s) => s.browseModPath)
  const openWizard = useAppStore((s) => s.openWizard)
  const rebuildCacheDb = useAppStore((s) => s.rebuildCacheDb)
  const rebuildingCacheDb = useAppStore((s) => s.rebuildingCacheDb)

  const [confirmRebuildOpen, setConfirmRebuildOpen] = useState(false)

  if (!config || !defaultPaths) return null

  const dark = resolveDark(config.themeMode, systemDark)

  async function confirmRebuildCacheDb() {
    setConfirmRebuildOpen(false)
    await rebuildCacheDb()
  }

  return (
    <div className="max-w-[520px]">
      <div className="mb-1 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold">Settings</h1>
        <Button variant="outline" size="sm" className="shrink-0" onClick={openWizard}>
          Run setup wizard
        </Button>
      </div>
      <div className="mb-6 text-[13px] text-text-2">Simple Mod Framework · Mod Manager v3.0.0-preview</div>

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">Paths</div>
      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-[18px] shadow-sm">
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">Game path</div>
          <PathInputRow value={config.gamePath} placeholder={defaultPaths.gamePath} onChange={setGamePath} onBrowse={browseGamePath} />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">Cache path</div>
          <PathInputRow value={config.cachePath} placeholder={defaultPaths.cachePath} onChange={setCachePath} onBrowse={browseCachePath} />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">Mod path</div>
          <PathInputRow value={config.modPath} placeholder={defaultPaths.modPath} onChange={setModPath} onBrowse={browseModPath} />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">Language</div>
          <Select value={config.language} onValueChange={(language) => language && setLanguage(language)}>
            <SelectTrigger className="py-[9px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((lo) => (
                <SelectItem key={lo.code} value={lo.code}>
                  {lo.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">Appearance</div>
      <div className="mb-6 rounded-lg border border-border bg-surface p-[18px] shadow-sm">
        <div className="mb-2 text-[12px] font-semibold text-text-2">Theme</div>
        <div className="mb-5 flex max-w-[280px] gap-1 rounded-md border border-border bg-surface-2 p-[3px]">
          {THEME_MODES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setThemeMode(key)}
              className={cn(
                "flex-1 rounded-[6px] py-[7px] text-center text-[12.5px]",
                config.themeMode === key ? "bg-surface font-semibold text-text" : "font-normal text-text-2"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-2.5 text-[12px] font-semibold text-text-2">Accent color</div>
        <div className="flex gap-3">
          {(Object.keys(ACCENTS) as Accent[]).map((key) => (
            <button
              key={key}
              title={ACCENT_LABELS[key]}
              onClick={() => setAccent(key)}
              className="h-7 w-7 rounded-full shadow-[0_0_0_2px_var(--surface)_inset]"
              style={{
                background: ACCENTS[key][dark ? "dark" : "light"],
                border: config.accent === key ? "2px solid var(--text)" : "1px solid var(--border)"
              }}
            />
          ))}
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between rounded-lg border border-border bg-surface px-[18px] py-4 shadow-sm">
        <div>
          <div className="text-[14px] font-semibold">Developer mode</div>
          <div className="text-[12.5px] text-text-2">Shows the authoring tools and raw docs in the rail.</div>
        </div>
        <Switch checked={config.developerMode} onCheckedChange={toggleDevMode} />
      </div>

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">Advanced</div>
      <div className="mb-6 flex items-center justify-between rounded-lg border border-border bg-surface px-[18px] py-4 shadow-sm">
        <div>
          <div className="text-[14px] font-semibold">Rebuild cache database</div>
          <div className="text-[12.5px] text-text-2">
            Wipes and rebuilds cache.db from scratch (mods, manifests, per-mod builds) - the "something's wrong with the cache" recovery option. Doesn't touch your Mods folder or load order.
          </div>
        </div>
        <Button variant="outline" disabled={rebuildingCacheDb} onClick={() => setConfirmRebuildOpen(true)}>
          {rebuildingCacheDb ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Rebuild cache database
        </Button>
      </div>

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">About</div>
      <div className="rounded-lg border border-border bg-surface shadow-sm">
        {ABOUT_LINKS.map(({ label, href }, i) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn("flex items-center justify-between px-[18px] py-3.5 text-[13.5px] text-text hover:bg-surface-hover", i !== ABOUT_LINKS.length - 1 && "border-b border-border")}
          >
            {label}
            <ExternalLink className="h-3.5 w-3.5 text-text-3" />
          </a>
        ))}
      </div>

      <Dialog open={confirmRebuildOpen} onOpenChange={setConfirmRebuildOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rebuild cache database</DialogTitle>
            <DialogDescription>
              This deletes cache.db and rebuilds every mod's cache from scratch - the same work as a first launch. It can take a while with a lot of mods installed, and any deploy is blocked until it
              finishes. Your Mods folder and load order aren't touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmRebuildOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmRebuildCacheDb}>Rebuild</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
