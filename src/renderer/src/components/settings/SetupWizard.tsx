import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Plural, Trans, useLingui } from "@lingui/react/macro"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAppStore } from "@/store/app-store"
import { getSmfApi } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import { LANGUAGES, LANGUAGE_ITEMS } from "@/lib/languages"
import { WIZARD_STEPS } from "@/lib/wizard-steps"
import { PathInputRow } from "./PathInputRow"

interface WizardDraft {
  gamePath: string
  cachePath: string
  modPath: string
  language: string
}

interface ModPreview {
  /** The path this result is actually for - compared against the live draft to derive "loading" (a stale/in-flight result for a since-changed path) without a separate flag to keep in sync. */
  path: string
  exists: boolean
  count: number
}

function WizardPathStep({
  title,
  description,
  value,
  placeholder,
  onChange,
  onBrowse
}: {
  title: string
  description: string
  value: string
  placeholder: string
  onChange(value: string): void
  onBrowse?: () => void
}) {
  return (
    <>
      <div className="mb-1.5 text-[22px] font-bold text-text">{title}</div>
      <div className="mb-[18px] text-[14px] leading-[1.55] text-text-2">{description}</div>
      <PathInputRow value={value} placeholder={placeholder} onChange={onChange} onBrowse={onBrowse} size="lg" />
    </>
  )
}

/**
 * Status line under the mod-path step's field - the wizard's own mirror of ModsScreen.tsx's
 * "Building mod cache" banner. Can't read the store's `modsLoading`/`mods` for this the way that
 * banner does: those reflect the *persisted* modPath, not whatever folder is currently staged in the
 * wizard's draft (see SetupWizard's doc comment) - `preview` instead comes from a debounced
 * `mods.previewFolder()` call scoped to this component.
 */
function ModDiscoveryStatus({ preview, loading }: { preview: ModPreview | null; loading: boolean }) {
  if (loading || !preview) {
    return (
      <div className="mt-3 flex items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <Trans>Scanning this folder for mods…</Trans>
      </div>
    )
  }

  if (!preview.exists) {
    return (
      <div className="mt-3 text-[13px] text-text-2">
        <Trans>This folder doesn't exist yet - it'll be created when you finish setup.</Trans>
      </div>
    )
  }

  return (
    <div className="mt-3 text-[13px] text-text-2">
      {preview.count > 0 ? (
        <Plural value={preview.count} one="# mod found in this folder." other="# mods found in this folder." />
      ) : (
        <Trans>No mods found in this folder yet - double-check the path if you expected some.</Trans>
      )}
    </div>
  )
}

/**
 * First-run onboarding, reachable any time from Settings via "Run setup
 * wizard". Renders as a fullscreen overlay covering the whole app (nav rail
 * included) - mirrors ui/Mod Manager.dc.html's wizard step for step, which
 * is a `position:absolute; inset:0; z-index:120` pane at the app root, not a
 * centered dialog card. Mounted once in AppShell so it's reachable no matter
 * which route is active (see AppShell.tsx).
 *
 * Every field (gamePath/cachePath/modPath/language) is kept in a local `draft` here rather than
 * going through the store's setGamePath()/setCachePath()/setModPath()/setLanguage() - those persist
 * to settings.json (and, for modPath, trigger a real index rebuild) on every single field change,
 * which is the right behavior for Settings' own Paths card but wrong for a multi-step wizard a user
 * can back out of partway through: closing it used to leave whatever had been typed so far already
 * saved. `commitWizard()` (the store) is called exactly once, at "Save & finish" (leaving the
 * "language" step) - same local-draft-until-commit shape as ModSettingsDrawer's own option list (see
 * that component's commitModOptions() doc comment in app-store.ts). Browse/scan feedback during the
 * wizard uses preview-only IPC calls (`config.pickGameDirectory(false)`, `config.previewPaths()`,
 * `mods.previewFolder()`) instead of the real persisting ones, so nothing hits disk until commit.
 */
export function SetupWizard() {
  const { t } = useLingui()
  const config = useAppStore((s) => s.config)
  const defaultPaths = useAppStore((s) => s.defaultPaths)
  const wizard = useAppStore((s) => s.wizard)
  const closeWizard = useAppStore((s) => s.closeWizard)
  const wizardBack = useAppStore((s) => s.wizardBack)
  const wizardNext = useAppStore((s) => s.wizardNext)
  const commitWizard = useAppStore((s) => s.commitWizard)

  const [draft, setDraft] = useState<WizardDraft | null>(null)
  // Whether the user has manually touched cache/mod path in this wizard session - once true, leaving
  // the game-root step no longer overwrites that field with the freshly-recomputed game-root-relative
  // default (see handleNext's "game" branch), the same "don't clobber an explicit choice" rule a
  // slug field auto-filled from a title would follow.
  const [cacheDirty, setCacheDirty] = useState(false)
  const [modDirty, setModDirty] = useState(false)
  const [modPreview, setModPreview] = useState<ModPreview | null>(null)
  const [committing, setCommitting] = useState(false)

  // Re-seeds the draft from whatever's actually committed every time the wizard opens - so a
  // previous session's abandoned (never-committed) edits never leak into a new one. Adjusts state
  // directly during render on the open/closed transition (React's documented alternative to an
  // effect for "reset state when a prop changes" - see its own "You Might Not Need An Effect" guide)
  // rather than a `useEffect([wizard.open])`, which would set state synchronously in the effect body.
  //
  // `prevWizardOpen` deliberately always starts `false` rather than `useState(wizard.open)`: this
  // component only mounts once `loaded`/`config` are truthy (see App.tsx's `!loaded || !config`
  // gate), and init() sets `wizard.open` in that very same store update for a fresh install (empty
  // gamePath) - so on this component's first render, `wizard.open` can already be `true` with no
  // prior `false` render to transition from. Seeding `prevWizardOpen` from `wizard.open` itself would
  // make that initial state its own baseline, so the `!==` check below never fires and `draft` never
  // gets populated - the wizard silently never appears (`!draft` early-returns null) despite
  // `wizard.open` being genuinely true. Starting at `false` unconditionally guarantees a real mount
  // with `wizard.open` already true still reads as an open transition.
  const [prevWizardOpen, setPrevWizardOpen] = useState(false)
  if (wizard.open !== prevWizardOpen) {
    setPrevWizardOpen(wizard.open)
    if (wizard.open && config) {
      setDraft({ gamePath: config.gamePath, cachePath: config.cachePath, modPath: config.modPath, language: config.language })
      setCacheDirty(false)
      setModDirty(false)
      setModPreview(null)
    }
  }

  // Debounced live preview of the staged mod folder - mirrors setModPath()'s own debounce (see its
  // doc comment in app-store.ts) so typing doesn't fire a previewFolder() call per keystroke. Loading
  // state is derived (`modPreview` missing or stale for the current path) rather than a separate flag
  // set synchronously in the effect body. Depends on the modPath string itself, not `draft`, so
  // editing gamePath/cachePath/language elsewhere in the draft doesn't re-trigger this.
  const draftModPath = draft?.modPath
  useEffect(() => {
    if (draftModPath === undefined) return
    let cancelled = false
    const handle = setTimeout(() => {
      void getSmfApi()
        .mods.previewFolder(draftModPath)
        .then((result) => {
          if (!cancelled) setModPreview({ path: draftModPath, ...result })
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [draftModPath])

  const modPreviewLoading = !modPreview || modPreview.path !== draftModPath

  if (!config || !defaultPaths || !draft) return null

  const step = WIZARD_STEPS[wizard.step] ?? "welcome"
  const isLast = wizard.step === WIZARD_STEPS.length - 1
  const isSecondLast = wizard.step === WIZARD_STEPS.length - 2
  const nextLabel = isLast ? t`Finish` : isSecondLast ? t`Save & finish` : t`Next`

  // Can't be dismissed until a game path is set - same "wizardDismissable:
  // !!s.gamePath" rule as the comp, so a fresh install can't skip straight
  // past setup with an empty config. Reads the *committed* config, not the draft - closing early is
  // exactly "discard the draft", so whether that's allowed has to hinge on what's already saved.
  const dismissable = !!config.gamePath

  async function handleBrowseGamePath() {
    const result = await getSmfApi().config.pickGameDirectory(false)
    if (result.ok) {
      setDraft((d) => d && { ...d, gamePath: result.config.gamePath, cachePath: cacheDirty ? d.cachePath : result.config.cachePath, modPath: modDirty ? d.modPath : result.config.modPath })
    } else if (result.error) {
      // An empty error means the user just canceled the dialog - nothing to say.
      toast.error(result.error)
    }
  }

  async function handleBrowseCachePath() {
    const picked = await getSmfApi().system.pickDirectory({ title: t`Select a cache folder` })
    if (!picked) return
    setDraft((d) => d && { ...d, cachePath: picked })
    setCacheDirty(true)
  }

  async function handleBrowseModPath() {
    const picked = await getSmfApi().system.pickDirectory({ title: t`Select a mod folder` })
    if (!picked) return
    setDraft((d) => d && { ...d, modPath: picked })
    setModDirty(true)
  }

  async function handleNext() {
    if (!draft) {
      wizardNext()
      return
    }
    const stepKey = WIZARD_STEPS[wizard.step]

    if (stepKey === "game") {
      // Leaving the game-root step: preview what cachePath (resolveTempDir()'s "SMF Data" folder
      // under the game root) - and modPath, if that's ever made to depend on gamePath too - would
      // resolve to now, without persisting anything. Only overwrites a field the user hasn't
      // manually edited yet (see cacheDirty/modDirty's doc comment).
      const preview = await getSmfApi().config.previewPaths(draft.gamePath)
      setDraft((d) => d && { ...d, cachePath: cacheDirty ? d.cachePath : preview.cachePath, modPath: modDirty ? d.modPath : preview.modPath })
    } else if (stepKey === "language") {
      // "Save & finish" - see this component's own doc comment for why every field waits until here.
      setCommitting(true)
      try {
        await commitWizard(draft)
      } finally {
        setCommitting(false)
      }
    }

    wizardNext()
  }

  let body: ReactNode = null
  switch (step) {
    case "welcome":
      body = (
        <>
          <div className="mb-3 text-[30px] font-bold text-text">
            <Trans>Welcome to Simple Mod Framework</Trans>
          </div>
          <div className="text-[15px] leading-[1.65] text-text-2">
            <Trans>This wizard walks you through pointing the mod manager at your game install and choosing where mods and cache files live. You can change any of this later in Settings.</Trans>
          </div>
        </>
      )
      break
    case "game":
      body = (
        <WizardPathStep
          title={t`Game path`}
          description={t`Point to the folder that contains the game's Retail executable.`}
          value={draft.gamePath}
          placeholder={defaultPaths.gamePath}
          onChange={(gamePath) => setDraft((d) => d && { ...d, gamePath })}
          onBrowse={handleBrowseGamePath}
        />
      )
      break
    case "cache":
      body = (
        <WizardPathStep
          title={t`Cache path`}
          description={t`Where extracted RPKG data and intermediate build files are stored.`}
          value={draft.cachePath}
          placeholder={defaultPaths.cachePath}
          onChange={(cachePath) => {
            setDraft((d) => d && { ...d, cachePath })
            setCacheDirty(true)
          }}
          onBrowse={handleBrowseCachePath}
        />
      )
      break
    case "mod":
      body = (
        <>
          <WizardPathStep
            title={t`Mod path`}
            description={t`The folder the manager scans for mods to load.`}
            value={draft.modPath}
            placeholder={defaultPaths.modPath}
            onChange={(modPath) => {
              setDraft((d) => d && { ...d, modPath })
              setModDirty(true)
            }}
            onBrowse={handleBrowseModPath}
          />
          <ModDiscoveryStatus preview={modPreview} loading={modPreviewLoading} />
        </>
      )
      break
    case "language":
      body = (
        <>
          <div className="mb-1.5 text-[22px] font-bold text-text">
            <Trans>Language</Trans>
          </div>
          <div className="mb-[18px] text-[14px] leading-[1.55] text-text-2">
            <Trans>Sets the in-game text language mods will target.</Trans>
          </div>
          <Select items={LANGUAGE_ITEMS} value={draft.language} onValueChange={(language) => language && setDraft((d) => d && { ...d, language })}>
            <SelectTrigger>
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
        </>
      )
      break
    case "done":
      body = (
        <>
          <div className="mb-[18px] flex h-[52px] w-[52px] items-center justify-center rounded-full bg-success text-[24px] font-bold text-white">✓</div>
          <div className="mb-2.5 text-[26px] font-bold text-text">
            <Trans>You're all set</Trans>
          </div>
          <div className="text-[15px] leading-[1.65] text-text-2">
            <Trans>Your paths and language are saved. You can revisit this wizard any time from Settings.</Trans>
          </div>
        </>
      )
      break
  }

  return (
    <DialogPrimitive.Root open={wizard.open} onOpenChange={(open) => !open && dismissable && closeWizard()} modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup className="fixed inset-0 z-120 flex flex-col overflow-hidden bg-app-bg text-text outline-none animate-fade-in">
          <div className="flex items-center justify-between px-10 py-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-accent text-[11px] font-bold text-accent-foreground">SMF</div>
              <DialogPrimitive.Title className="text-[14px] font-bold text-text">
                <Trans>Setup wizard</Trans>
              </DialogPrimitive.Title>
            </div>
            {dismissable && (
              <button onClick={closeWizard} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-hover">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="mx-auto flex w-full max-w-[520px] gap-1.5 px-10">
            {WIZARD_STEPS.map((key, i) => (
              <div key={key} className={cn("h-1 flex-1 rounded-full", i <= wizard.step ? "bg-accent" : "bg-border")} />
            ))}
          </div>

          <div className="flex flex-1 items-center justify-center overflow-y-auto px-10 py-5">
            <div className="w-full max-w-[480px]">{body}</div>
          </div>

          <div className="mx-auto flex w-full max-w-[520px] items-center justify-between px-10 py-6">
            <button onClick={wizardBack} className={cn("text-[13.5px] font-semibold text-text-2", wizard.step === 0 && "invisible")}>
              <Trans>Back</Trans>
            </button>
            <Button onClick={handleNext} disabled={committing}>
              {committing ? t`Saving…` : nextLabel}
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
