import { Trans } from '@lingui/react/macro'
import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AppShell } from '@/components/layout/AppShell'
import { ModsScreen } from '@/components/mods/ModsScreen'
import { SettingsScreen } from '@/components/settings/SettingsScreen'
import { computeThemeVars, resolveDark } from '@/lib/theme'
import { useAppStore } from '@/store/app-store'

export default function App() {
  const init = useAppStore((s) => s.init)
  const initListeners = useAppStore((s) => s.initListeners)
  const loaded = useAppStore((s) => s.loaded)
  const config = useAppStore((s) => s.config)
  const systemDark = useAppStore((s) => s.systemDark)
  const addFiles = useAppStore((s) => s.addFiles)

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    // Separate from the init() effect above on purpose: this one subscribes to IPC push channels
    // and a media-query listener, so - unlike the plain data fetch in init(), which is harmless to
    // re-run - it needs a real cleanup. Returning one here means React 18 StrictMode's dev-mode
    // mount -> cleanup -> mount double-invoke actually exercises the unsubscribe path (the same way
    // the drag/drop effect below already does) and leaves exactly one live subscription of each,
    // instead of the previous version (which subscribed from inside init() with no cleanup, so
    // StrictMode's second invoke permanently doubled every deploy:progress / mods:taskUpdate
    // listener - see app-store.ts's initListeners() doc comment).
    return initListeners()
  }, [initListeners])

  useEffect(() => {
    // Without this, dropping a file anywhere in the window *other* than the Add Mod dialog's own
    // dropzone (AddModDialog.tsx) does nothing useful: Electron's default is to try to navigate
    // the whole window to the dropped file's file:// URL, which just fails silently since it's
    // not HTML - reading, to a user who's never opened that dialog first, as "I can't drag a mod
    // into the app at all." Listening on `window` (capture phase, so it fires before anything else
    // has a chance to stop the drop) and preventing default everywhere blocks that navigation and
    // means a drop anywhere - not just inside an already-open dialog - starts the same install
    // pipeline (app-store.ts's addFiles(), which also pops the dialog open to show progress).
    function onDragOver(e: DragEvent): void {
      e.preventDefault()
    }

    function onDrop(e: DragEvent): void {
      e.preventDefault()
      // Capture phase means this always fires before AddModDialog.tsx's own onDrop (a bubble-phase
      // React handler on its dropzone) does. If that dialog is already open, its dropzone is the
      // one actually visible under the cursor and will handle this same drop itself a moment later
      // - bail out here or every file dropped on it would get added twice.
      if (useAppStore.getState().addDialogOpen) return
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
    }

    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [addFiles])

  useEffect(() => {
    if (!config) return
    const dark = resolveDark(config.themeMode, systemDark)
    const vars = computeThemeVars(dark, config.accent)
    const root = document.documentElement
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value)
    }
    root.classList.toggle('dark', dark)
  }, [config, systemDark])

  if (!loaded || !config) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-app-bg text-text-2 text-sm">
        <Trans>Loading Mod Manager…</Trans>
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
