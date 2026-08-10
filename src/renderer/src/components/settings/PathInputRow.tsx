import { useLingui } from '@lingui/react/macro'
import { FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A path text field + "Browse" button, shared by SettingsScreen's Paths card
 * and SetupWizard's per-path steps. The text field round-trips to the real
 * settings.json after a short input debounce (LEI-134), and Browse now opens a real native
 * `dialog.showOpenDialog` folder picker (LEI-133) via `onBrowse` - the game
 * path uses `smf.config.pickGameDirectory()` (validated + derives
 * runtimePath/platform), cache/mod paths use the plain `smf.system.pickDirectory()`.
 */
export function PathInputRow({
  value,
  placeholder,
  onChange,
  onBrowse,
  size = 'default',
}: {
  value: string
  placeholder: string
  onChange(value: string): void
  onBrowse?: () => void
  size?: 'default' | 'lg'
}) {
  const { t } = useLingui()
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'flex-1 rounded-md border border-border bg-surface-2 font-mono text-text outline-none placeholder:text-text-3',
          size === 'lg' ? 'px-3.5 py-3 text-[14px]' : 'px-3 py-[9px] text-[13px]'
        )}
      />
      <button
        type="button"
        title={t`Browse`}
        onClick={() => onBrowse?.()}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-text-2 hover:bg-surface-hover',
          size === 'lg' ? 'h-[42px] w-[42px]' : 'h-9 w-9'
        )}
      >
        <FolderOpen className="h-[14px] w-[14px]" />
      </button>
    </div>
  )
}
