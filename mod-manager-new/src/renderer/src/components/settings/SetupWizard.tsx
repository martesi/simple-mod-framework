import type { ReactNode } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAppStore } from "@/store/app-store"
import { cn } from "@/lib/utils"
import { LANGUAGES } from "@/lib/languages"
import { WIZARD_STEPS } from "@/lib/wizard-steps"
import { PathInputRow } from "./PathInputRow"

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
 * First-run onboarding, reachable any time from Settings via "Run setup
 * wizard". Renders as a fullscreen overlay covering the whole app (nav rail
 * included) - mirrors ui/Mod Manager.dc.html's wizard step for step, which
 * is a `position:absolute; inset:0; z-index:120` pane at the app root, not a
 * centered dialog card. Mounted once in AppShell so it's reachable no matter
 * which route is active (see AppShell.tsx).
 */
export function SetupWizard() {
  const config = useAppStore((s) => s.config)
  const defaultPaths = useAppStore((s) => s.defaultPaths)
  const wizard = useAppStore((s) => s.wizard)
  const closeWizard = useAppStore((s) => s.closeWizard)
  const wizardBack = useAppStore((s) => s.wizardBack)
  const wizardNext = useAppStore((s) => s.wizardNext)
  const setGamePath = useAppStore((s) => s.setGamePath)
  const setCachePath = useAppStore((s) => s.setCachePath)
  const setModPath = useAppStore((s) => s.setModPath)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const browseGamePath = useAppStore((s) => s.browseGamePath)
  const browseCachePath = useAppStore((s) => s.browseCachePath)
  const browseModPath = useAppStore((s) => s.browseModPath)

  if (!config || !defaultPaths) return null

  const step = WIZARD_STEPS[wizard.step] ?? "welcome"
  const isLast = wizard.step === WIZARD_STEPS.length - 1
  const isSecondLast = wizard.step === WIZARD_STEPS.length - 2
  const nextLabel = isLast ? "Finish" : isSecondLast ? "Save & finish" : "Next"

  // Can't be dismissed until a game path is set - same "wizardDismissable:
  // !!s.gamePath" rule as the comp, so a fresh install can't skip straight
  // past setup with an empty config.
  const dismissable = !!config.gamePath

  let body: ReactNode = null
  switch (step) {
    case "welcome":
      body = (
        <>
          <div className="mb-3 text-[30px] font-bold text-text">Welcome to Simple Mod Framework</div>
          <div className="text-[15px] leading-[1.65] text-text-2">
            This wizard walks you through pointing the mod manager at your game install and choosing where mods and cache files live. You can change any of this later in Settings.
          </div>
        </>
      )
      break
    case "game":
      body = (
        <WizardPathStep
          title="Game path"
          description="Point to the folder that contains the game's Retail executable."
          value={config.gamePath}
          placeholder={defaultPaths.gamePath}
          onChange={setGamePath}
          onBrowse={browseGamePath}
        />
      )
      break
    case "cache":
      body = (
        <WizardPathStep
          title="Cache path"
          description="Where extracted RPKG data and intermediate build files are stored."
          value={config.cachePath}
          placeholder={defaultPaths.cachePath}
          onChange={setCachePath}
          onBrowse={browseCachePath}
        />
      )
      break
    case "mod":
      body = (
        <WizardPathStep
          title="Mod path"
          description="The folder the manager scans for mods to load."
          value={config.modPath}
          placeholder={defaultPaths.modPath}
          onChange={setModPath}
          onBrowse={browseModPath}
        />
      )
      break
    case "language":
      body = (
        <>
          <div className="mb-1.5 text-[22px] font-bold text-text">Language</div>
          <div className="mb-[18px] text-[14px] leading-[1.55] text-text-2">Sets the in-game text language mods will target.</div>
          <select
            value={config.language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3.5 py-3 text-[14px] text-text outline-none"
          >
            {LANGUAGES.map((lo) => (
              <option key={lo.code} value={lo.code}>
                {lo.label}
              </option>
            ))}
          </select>
        </>
      )
      break
    case "done":
      body = (
        <>
          <div className="mb-[18px] flex h-[52px] w-[52px] items-center justify-center rounded-full bg-success text-[24px] font-bold text-white">✓</div>
          <div className="mb-2.5 text-[26px] font-bold text-text">You're all set</div>
          <div className="text-[15px] leading-[1.65] text-text-2">Your paths and language are saved. You can revisit this wizard any time from Settings.</div>
        </>
      )
      break
  }

  return (
    <DialogPrimitive.Root open={wizard.open} onOpenChange={(open) => !open && dismissable && closeWizard()} modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup className="fixed inset-0 z-[120] flex flex-col overflow-hidden bg-app-bg text-text outline-none animate-fade-in">
          <div className="flex items-center justify-between px-10 py-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-accent text-[11px] font-bold text-accent-foreground">SMF</div>
              <DialogPrimitive.Title className="text-[14px] font-bold text-text">Setup wizard</DialogPrimitive.Title>
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
              Back
            </button>
            <Button onClick={wizardNext}>{nextLabel}</Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
