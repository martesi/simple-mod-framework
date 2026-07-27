import { useEffect } from "react"
import { Routes, Route, Navigate } from "react-router-dom"
import { Toaster } from "sonner"

import { useAppStore } from "@/store/app-store"
import { computeThemeVars, resolveDark } from "@/lib/theme"
import { AppShell } from "@/components/layout/AppShell"
import { ModsScreen } from "@/components/mods/ModsScreen"
import { SettingsScreen } from "@/components/settings/SettingsScreen"

export default function App() {
  const init = useAppStore((s) => s.init)
  const loaded = useAppStore((s) => s.loaded)
  const config = useAppStore((s) => s.config)
  const systemDark = useAppStore((s) => s.systemDark)

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    if (!config) return
    const dark = resolveDark(config.themeMode, systemDark)
    const vars = computeThemeVars(dark, config.accent)
    const root = document.documentElement
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value)
    }
    root.classList.toggle("dark", dark)
  }, [config, systemDark])

  if (!loaded || !config) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-app-bg text-text-2 text-sm">
        Loading Mod Manager…
      </div>
    )
  }

  return (
    <>
      <AppShell>
        <Routes>
          <Route path="/" element={<ModsScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <Toaster position="bottom-right" richColors />
    </>
  )
}
