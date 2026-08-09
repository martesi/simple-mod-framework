import { describe, expect, test } from "bun:test"
import { hasDeployCompatibilityMetadata, mergeDeployCompatibilityOptionData, validateDeployCompatibility, type DeployCompatibilityInstruction } from "../src/main/deployCompatibility"
import type { ManifestOptionData } from "../src/main/core/types"

function instruction(id: string, metadata: Partial<DeployCompatibilityInstruction["manifestSources"]> = {}, version = "1.0.0"): DeployCompatibilityInstruction {
	return {
		id,
		name: id,
		version,
		manifestSources: { supportedPlatforms: undefined, requirements: undefined, incompatibilities: undefined, loadBefore: undefined, loadAfter: undefined, ...metadata }
	}
}

describe("deploy compatibility option data", () => {
	test("merges all fields after manifest data", () => {
		const target: ManifestOptionData = {
			supportedPlatforms: ["steam"], requirements: ["Base.Req"], incompatibilities: ["Base.Inc"], loadBefore: ["Base.Before"], loadAfter: ["Base.After"]
		}
		mergeDeployCompatibilityOptionData(target, {
			supportedPlatforms: ["epic"], requirements: [["Option.Req", "^2"]], incompatibilities: [["Option.Inc", "<3"]], loadBefore: ["Option.Before"], loadAfter: ["Option.After"]
		})
		expect(target).toEqual({
			supportedPlatforms: ["steam", "epic"], requirements: ["Base.Req", ["Option.Req", "^2"]], incompatibilities: ["Base.Inc", ["Option.Inc", "<3"]], loadBefore: ["Base.Before", "Option.Before"], loadAfter: ["Base.After", "Option.After"]
		})
	})
})

describe("deploy compatibility preflight", () => {
	test("accepts matching ranges and preserves configured order", () => {
		const loadOrder = ["Required", "Source", "Later"]
		const result = validateDeployCompatibility({
			loadOrder, installedMods: loadOrder, platform: "steam",
			instructions: [
				instruction("Required", {}, "2.4.0"),
				instruction("Source", { supportedPlatforms: ["steam"], requirements: [["Required", "^2"]], incompatibilities: [["Later", "<1"]], loadAfter: [["Required", ">=2"]], loadBefore: ["Later"] }),
				instruction("Later", {}, "1.5.0")
			]
		})
		expect(result).toEqual({ ok: true })
		expect(loadOrder).toEqual(["Required", "Source", "Later"])
	})

	test("aggregates actionable failures, including missing and disabled targets", () => {
		const result = validateDeployCompatibility({
			loadOrder: ["Conflict", "Source", "AfterTarget"], installedMods: ["Conflict", "Source", "AfterTarget", "Disabled"], platform: "epic",
			instructions: [
				instruction("Conflict", {}, "1.0.0"),
				instruction("Source", { supportedPlatforms: ["steam"], requirements: ["Missing", "Disabled", ["Conflict", ">=2"]], incompatibilities: ["Conflict"], loadBefore: ["Conflict"], loadAfter: ["AfterTarget"] }),
				instruction("AfterTarget")
			]
		})
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.errors).toHaveLength(7)
		expect(result.message).toContain("installed and disabled")
		expect(result.message).toContain("enabled version 1.0.0 does not match")
		expect(result.message).toContain("Move Source before Conflict")
		expect(result.message).toContain("Move Source after AfterTarget")
	})

	test("applies incompatibility and order rules only when target ranges match", () => {
		expect(validateDeployCompatibility({
			loadOrder: ["Target", "Source"], installedMods: ["Target", "Source"], platform: "steam",
			instructions: [instruction("Target", {}, "1.0.0"), instruction("Source", { incompatibilities: [["Target", ">=2"]], loadBefore: [["Target", ">=2"]] })]
		})).toEqual({ ok: true })
	})

	test("reports malformed ranges together", () => {
		const result = validateDeployCompatibility({
			loadOrder: ["Target", "Source"], installedMods: ["Target", "Source", "Disabled"], platform: "steam",
			instructions: [instruction("Target"), instruction("Source", { requirements: [["Target", "bad range"]], incompatibilities: [["Disabled", "bad range"]], loadAfter: [["Disabled", "bad range"]] })]
		})
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.errors).toHaveLength(3)
		expect(result.errors.every((error) => error.includes("invalid semantic-version range"))).toBe(true)
	})
})

test("legacy cached instructions are rebuilt", () => {
	expect(hasDeployCompatibilityMetadata(JSON.stringify({ id: "Legacy", manifestSources: {} }))).toBe(false)
	expect(hasDeployCompatibilityMetadata(JSON.stringify({ id: "Current", version: "1.0.0", manifestSources: {} }))).toBe(true)
	expect(hasDeployCompatibilityMetadata("not json")).toBe(false)
})
