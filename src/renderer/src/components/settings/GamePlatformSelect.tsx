import { Trans, useLingui } from "@lingui/react/macro"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { GAME_PLATFORMS, isGamePlatform, type GamePlatform } from "../../../../shared/game"

export function GamePlatformSelect({ value, required, disabled, onChange }: { value?: GamePlatform; required: boolean; disabled?: boolean; onChange(platform: GamePlatform): void }) {
  const { t } = useLingui()
  const labels: Record<GamePlatform, string> = {
    steam: t`Steam`,
    epic: t`Epic Games Store`,
    microsoft: t`Microsoft Store / Xbox`
  }

  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold text-text-2">
        <Trans>Game platform</Trans>
      </div>
      <Select items={labels} value={value ?? ""} onValueChange={(platform) => isGamePlatform(platform) && onChange(platform)} disabled={disabled}>
        <SelectTrigger className="py-[9px] text-[13px]">
          <SelectValue placeholder={t`Choose a platform`} />
        </SelectTrigger>
        <SelectContent>
          {GAME_PLATFORMS.map((platform) => (
            <SelectItem key={platform} value={platform}>
              {labels[platform]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="mt-1.5 text-[12px] text-text-3">
        {required ? <Trans>Choose the storefront before deploying.</Trans> : value ? <Trans>This storefront will be used when checking the game install.</Trans> : <Trans>Choose a game folder first.</Trans>}
      </div>
    </div>
  )
}
