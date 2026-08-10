import { satisfies, valid, validRange } from 'semver'
import type { DeployInstruction, ManifestOptionData, ModReference, Platform } from './core/types'

const MOD_REFERENCE_FIELDS = [
  'requirements',
  'incompatibilities',
  'loadBefore',
  'loadAfter',
] as const

/**
 * Adds compatibility data contributed by an enabled manifest option to the manifest-level data.
 * Arrays intentionally retain manifest/option declaration order; preflight reports issues without
 * sorting or rewriting the user's configured load order.
 */
export function mergeDeployCompatibilityOptionData(
  target: ManifestOptionData,
  option: ManifestOptionData
): void {
  if (option.supportedPlatforms?.length) {
    target.supportedPlatforms ??= []
    target.supportedPlatforms.push(...option.supportedPlatforms)
  }

  for (const field of MOD_REFERENCE_FIELDS) {
    const additions = option[field]
    if (!additions?.length) continue
    target[field] ??= []
    target[field].push(...additions)
  }
}

/** The compatibility-only subset persisted in every framework mod's deploy instruction. */
export type DeployCompatibilityInstruction = Pick<DeployInstruction, 'id' | 'name' | 'version'> & {
  manifestSources: Pick<
    DeployInstruction['manifestSources'],
    'supportedPlatforms' | 'requirements' | 'incompatibilities' | 'loadBefore' | 'loadAfter'
  >
}

export interface DeployCompatibilityInput {
  /** Enabled IDs in the exact user-configured deploy order. */
  loadOrder: readonly string[]
  /** Every installed mod ID, including disabled entries. */
  installedMods: readonly string[]
  platform: Platform | `${Platform}`
  instructions: readonly DeployCompatibilityInstruction[]
}

export type DeployCompatibilityResult =
  | { ok: true }
  | { ok: false; errors: string[]; message: string }

function displayName(instruction: DeployCompatibilityInstruction): string {
  return instruction.name === instruction.id
    ? instruction.id
    : `${instruction.name} (${instruction.id})`
}

function describePlatforms(platforms: readonly string[]): string {
  if (platforms.length <= 1) return platforms[0] ?? 'no platforms'
  return `${platforms.slice(0, -1).join(', ')} or ${platforms[platforms.length - 1]}`
}

function parseReference(reference: ModReference): { id: string; range?: string } {
  if (typeof reference === 'string') return { id: reference }
  if (Array.isArray(reference)) return { id: reference[0], range: reference[1] }
  return reference
}

/**
 * Checks whether a version-qualified relationship applies. Invalid ranges and target versions are
 * returned as actionable author/install errors instead of being mistaken for a non-matching rule.
 */
function referenceApplies(
  reference: ModReference,
  source: DeployCompatibilityInstruction,
  target: DeployCompatibilityInstruction | undefined,
  relationship: string,
  errors: string[]
): boolean {
  const { id, range } = parseReference(reference)
  if (range === undefined) return true

  if (!validRange(range)) {
    errors.push(
      `${displayName(source)} declares invalid semantic-version range "${range}" for ${relationship} ${id}. Update or reinstall ${source.id} with a corrected manifest.`
    )
    return false
  }

  if (!target) {
    errors.push(
      `${displayName(source)} declares ${relationship} ${id} in version range "${range}", but ${id}'s version metadata is unavailable. Install and enable the framework mod, then rebuild its cache.`
    )
    return false
  }

  if (!valid(target.version)) {
    errors.push(
      `${displayName(target)} has invalid semantic version "${target.version}", needed to check ${relationship} declared by ${source.id}. Update or reinstall ${target.id}.`
    )
    return false
  }

  return satisfies(target.version, range)
}

function formatCompatibilityFailure(errors: readonly string[]): string {
  return `Compatibility preflight found ${errors.length} issue${errors.length === 1 ? '' : 's'}:\n${errors.map((error, index) => `${index + 1}. ${error}`).join('\n')}`
}

/**
 * Validates the frozen deploy snapshot without changing its order. All issues are collected so the
 * user can fix the configuration in one pass rather than discovering one incompatibility per run.
 */
export function validateDeployCompatibility(
  input: DeployCompatibilityInput
): DeployCompatibilityResult {
  const errors: string[] = []
  const enabled = new Set(input.loadOrder)
  const installed = new Set(input.installedMods)
  const order = new Map(input.loadOrder.map((id, index) => [id, index]))
  const instructions = new Map(
    input.instructions.map((instruction) => [instruction.id, instruction])
  )

  for (const source of input.instructions) {
    const metadata = source.manifestSources

    if (
      metadata.supportedPlatforms?.length &&
      !metadata.supportedPlatforms.includes(input.platform as Platform)
    ) {
      errors.push(
        `${displayName(source)} supports only ${describePlatforms(metadata.supportedPlatforms)}, but this game install is ${input.platform}. Disable ${source.id} or use a supported game platform.`
      )
    }

    for (const requirement of metadata.requirements ?? []) {
      const { id, range } = parseReference(requirement)
      if (!enabled.has(id)) {
        if (installed.has(id)) {
          errors.push(
            `${displayName(source)} requires ${id}${range ? ` in version range "${range}"` : ''}, but ${id} is installed and disabled. Enable ${id} and deploy again.`
          )
        } else {
          errors.push(
            `${displayName(source)} requires ${id}${range ? ` in version range "${range}"` : ''}, but it is not installed. Install and enable ${id}, then deploy again.`
          )
        }
        if (range !== undefined && !validRange(range)) {
          errors.push(
            `${displayName(source)} declares invalid semantic-version range "${range}" for requirement ${id}. Update or reinstall ${source.id} with a corrected manifest.`
          )
        }
        continue
      }

      const target = instructions.get(id)
      if (!referenceApplies(requirement, source, target, 'requirement', errors)) {
        if (range !== undefined && validRange(range) && target && valid(target.version)) {
          errors.push(
            `${displayName(source)} requires ${id} in version range "${range}", but enabled version ${target.version} does not match. Install a compatible version of ${id}.`
          )
        }
      }
    }

    for (const incompatibility of metadata.incompatibilities ?? []) {
      const { id, range } = parseReference(incompatibility)
      if (!enabled.has(id)) {
        if (range !== undefined && !validRange(range)) {
          errors.push(
            `${displayName(source)} declares invalid semantic-version range "${range}" for incompatibility ${id}. Update or reinstall ${source.id} with a corrected manifest.`
          )
        }
        continue
      }

      const target = instructions.get(id)
      if (referenceApplies(incompatibility, source, target, 'incompatibility with', errors)) {
        errors.push(
          `${displayName(source)} is incompatible with ${id}${range ? ` versions matching "${range}" (enabled: ${target?.version ?? 'unknown'})` : ''}. Disable either ${source.id} or ${id}.`
        )
      }
    }

    const sourceIndex = order.get(source.id)
    if (sourceIndex === undefined) continue

    const checkLoadOrder = (reference: ModReference, direction: 'before' | 'after'): void => {
      const { id, range } = parseReference(reference)
      if (!enabled.has(id)) {
        if (range !== undefined && !validRange(range)) {
          errors.push(
            `${displayName(source)} declares invalid semantic-version range "${range}" for load-${direction} rule targeting ${id}. Update or reinstall ${source.id} with a corrected manifest.`
          )
        }
        return
      }

      const target = instructions.get(id)
      if (!referenceApplies(reference, source, target, `load-${direction} rule targeting`, errors))
        return

      const targetIndex = order.get(id)
      if (targetIndex === undefined) return
      const correctlyOrdered =
        direction === 'before' ? sourceIndex < targetIndex : sourceIndex > targetIndex
      if (!correctlyOrdered) {
        errors.push(
          `${displayName(source)} must load ${direction} ${id}${range ? ` when ${id} matches "${range}"` : ''}. Move ${source.id} ${direction} ${id} in the mod load order.`
        )
      }
    }

    for (const reference of metadata.loadBefore ?? []) checkLoadOrder(reference, 'before')
    for (const reference of metadata.loadAfter ?? []) checkLoadOrder(reference, 'after')
  }

  return errors.length
    ? { ok: false, errors, message: formatCompatibilityFailure(errors) }
    : { ok: true }
}

/** Old cached instructions predate compatibility preflight and must be rebuilt once. */
export function hasDeployCompatibilityMetadata(serialisedInstruction: string | undefined): boolean {
  if (!serialisedInstruction) return false
  try {
    const instruction = JSON.parse(serialisedInstruction) as Partial<DeployCompatibilityInstruction>
    return typeof instruction.version === 'string' && !!instruction.manifestSources
  } catch {
    return false
  }
}
