import { Trans, useLingui } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LANGUAGE_ITEMS, LANGUAGES } from '@/lib/languages'
import { ACCENTS, type Accent, resolveDark, type ThemeMode } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { GamePlatformSelect } from './GamePlatformSelect'
import { PathInputRow } from './PathInputRow'

export function SettingsScreen() {
  const { t } = useLingui()
  const config = useAppStore((s) => s.config)
  const defaultPaths = useAppStore((s) => s.defaultPaths)
  const systemDark = useAppStore((s) => s.systemDark)
  const setThemeMode = useAppStore((s) => s.setThemeMode)
  const setAccent = useAppStore((s) => s.setAccent)
  const setGamePath = useAppStore((s) => s.setGamePath)
  const setGamePlatform = useAppStore((s) => s.setGamePlatform)
  const setCachePath = useAppStore((s) => s.setCachePath)
  const setModPath = useAppStore((s) => s.setModPath)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const browseGamePath = useAppStore((s) => s.browseGamePath)
  const browseCachePath = useAppStore((s) => s.browseCachePath)
  const browseModPath = useAppStore((s) => s.browseModPath)
  const rebuildCacheDb = useAppStore((s) => s.rebuildCacheDb)
  const rebuildingCacheDb = useAppStore((s) => s.rebuildingCacheDb)

  const [confirmRebuildOpen, setConfirmRebuildOpen] = useState(false)

  const THEME_MODES: { key: ThemeMode; label: string }[] = [
    { key: 'light', label: t`Light` },
    { key: 'dark', label: t`Dark` },
    { key: 'system', label: t`Auto` },
  ]

  const ACCENT_LABELS: Record<Accent, string> = {
    neutral: t`Neutral`,
    blue: t`Blue`,
    violet: t`Violet`,
    green: t`Green`,
    red: t`Red`,
  }

  if (!config || !defaultPaths) return null

  const dark = resolveDark(config.themeMode, systemDark)

  async function confirmRebuildCacheDb() {
    setConfirmRebuildOpen(false)
    await rebuildCacheDb()
  }

  return (
    <div className="max-w-[520px]">
      <h1 className="mb-1 text-2xl font-bold">
        <Trans>Settings</Trans>
      </h1>
      <div className="mb-6 text-[13px] text-text-2">
        Simple Mod Framework · Mod Manager v3.0.0-preview
      </div>

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">
        <Trans>Paths</Trans>
      </div>
      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-[18px] shadow-sm">
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">
            <Trans>Game root</Trans>
          </div>
          <PathInputRow
            value={config.gamePath}
            placeholder={defaultPaths.gamePath}
            onChange={setGamePath}
            onBrowse={browseGamePath}
          />
        </div>
        <GamePlatformSelect
          value={config.gamePlatform}
          required={config.gamePlatformChoiceRequired}
          disabled={!config.gamePath}
          onChange={setGamePlatform}
        />
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">
            <Trans>Cache path</Trans>
          </div>
          <PathInputRow
            value={config.cachePath}
            placeholder={defaultPaths.cachePath}
            onChange={setCachePath}
            onBrowse={browseCachePath}
          />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">
            <Trans>Mod path</Trans>
          </div>
          <PathInputRow
            value={config.modPath}
            placeholder={defaultPaths.modPath}
            onChange={setModPath}
            onBrowse={browseModPath}
          />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold text-text-2">
            <Trans>Language</Trans>
          </div>
          <Select
            items={LANGUAGE_ITEMS}
            value={config.language}
            onValueChange={(language) => language && setLanguage(language)}
          >
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

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">
        <Trans>Appearance</Trans>
      </div>
      <div className="mb-6 rounded-lg border border-border bg-surface p-[18px] shadow-sm">
        <div className="mb-2 text-[12px] font-semibold text-text-2">
          <Trans>Theme</Trans>
        </div>
        <div className="mb-5 flex max-w-[280px] gap-1 rounded-md border border-border bg-surface-2 p-[3px]">
          {THEME_MODES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setThemeMode(key)}
              className={cn(
                'flex-1 rounded-[6px] py-[7px] text-center text-[12.5px]',
                config.themeMode === key
                  ? 'bg-surface font-semibold text-text'
                  : 'font-normal text-text-2'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-2.5 text-[12px] font-semibold text-text-2">
          <Trans>Accent color</Trans>
        </div>
        <div className="flex gap-3">
          {(Object.keys(ACCENTS) as Accent[]).map((key) => (
            <button
              key={key}
              title={ACCENT_LABELS[key]}
              onClick={() => setAccent(key)}
              className="h-7 w-7 rounded-full shadow-[0_0_0_2px_var(--surface)_inset]"
              style={{
                background: ACCENTS[key][dark ? 'dark' : 'light'],
                border: config.accent === key ? '2px solid var(--text)' : '1px solid var(--border)',
              }}
            />
          ))}
        </div>
      </div>

      <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">
        <Trans>Advanced</Trans>
      </div>
      <div className="mb-6 flex items-center justify-between rounded-lg border border-border bg-surface px-[18px] py-4 shadow-sm">
        <div>
          <div className="text-[14px] font-semibold">
            <Trans>Rebuild cache database</Trans>
          </div>
          <div className="text-[12.5px] text-text-2">
            <Trans>
              Wipes and rebuilds cache.db from scratch (mods, manifests, per-mod builds) - the
              "something's wrong with the cache" recovery option. Doesn't touch your Mods folder or
              load order.
            </Trans>
          </div>
        </div>
        <Button
          variant="outline"
          disabled={rebuildingCacheDb}
          onClick={() => setConfirmRebuildOpen(true)}
        >
          {rebuildingCacheDb ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          <Trans>Rebuild cache database</Trans>
        </Button>
      </div>

      <Dialog open={confirmRebuildOpen} onOpenChange={setConfirmRebuildOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Rebuild cache database</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                This deletes cache.db and rebuilds every mod's cache from scratch - the same work as
                a first launch. It can take a while with a lot of mods installed, and any deploy is
                blocked until it finishes. Your Mods folder and load order aren't touched.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmRebuildOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={confirmRebuildCacheDb}>
              <Trans>Rebuild</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
