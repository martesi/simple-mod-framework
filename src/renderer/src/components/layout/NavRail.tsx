import { useLingui } from '@lingui/react/macro'
import { LayoutList, Loader2, Settings2 } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { selectDeployActive, useAppStore } from '@/store/app-store'

export function NavRail() {
  const { t } = useLingui()
  const deployActive = useAppStore(selectDeployActive)
  const openDeploy = useAppStore((s) => s.openDeploy)
  const items = [
    { to: '/', label: t`Mods`, icon: LayoutList },
    { to: '/settings', label: t`Settings`, icon: Settings2 },
  ]

  return (
    <div className="flex w-[68px] shrink-0 flex-col items-center gap-2 border-r border-border bg-surface py-4">
      <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-accent-foreground">
        SMF
      </div>

      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end
          title={label}
          className="relative flex h-10 w-11 items-center justify-center"
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <div className="absolute -left-2 top-1.5 h-7 w-[3px] rounded-sm bg-accent" />
              )}
              <div
                className={cn(
                  'flex h-10 w-11 items-center justify-center rounded-lg',
                  isActive && 'bg-surface-hover'
                )}
              >
                <Icon className="h-[18px] w-[18px] text-text" strokeWidth={1.75} />
              </div>
            </>
          )}
        </NavLink>
      ))}

      <div className="grow" />

      {deployActive && (
        // Stays visible even after the deploy toast (DeployToast.tsx) is dismissed - closing the
        // toast only hides it, it doesn't stop tracking progress, so without this there was no way
        // to tell a deploy was still running or get back to its status.
        <button
          onClick={openDeploy}
          title={t`Deploy in progress — click to view`}
          className="flex h-10 w-11 shrink-0 items-center justify-center rounded-lg text-accent hover:bg-surface-hover"
        >
          <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}
