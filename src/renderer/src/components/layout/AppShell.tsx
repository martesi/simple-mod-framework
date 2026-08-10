import type { ReactNode } from 'react'
import { DeployToast } from '@/components/mods/DeployToast'
import { SetupWizard } from '@/components/settings/SetupWizard'
import { NavRail } from './NavRail'

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-app-bg font-sans text-text">
      <NavRail />
      <div className="min-w-0 flex-1 overflow-y-auto px-11 py-9">{children}</div>
      {/* Siblings of the scrollable content pane (not nested inside it) so
          they stay pinned to the app root instead of scrolling/clipping with
          the mods list, and stay reachable across screens - matches
          ui/Mod Manager.dc.html, where the toast and wizard both sit in the
          app root outside either screen's sc-if. The wizard in particular
          needs to be mountable on first run even when the current route is
          "/" (Mods), not just "/settings". */}
      <DeployToast />
      <SetupWizard />
    </div>
  )
}
