import { describe, expect, test } from "bun:test"
import { ManifestCompatibilityError, normalizeManifest } from "../src/main/manifestCompatibility"

const base = { id: "Example.Mod", name: "Example", description: "Demo", authors: ["A"], version: "1.2.3", frameworkVersion: "2.33.40" }

describe("manifest compatibility boundary", () => {
  test("maps v3 data, aliases, references, platforms, and localisation", () => {
    const result = normalizeManifest({
      ...base,
      data: { blobFolders: ["blobs"], packageDefinition: [{ type: "partition" }] },
      supportedPlatforms: ["h3-steam"],
      requirements: ["Other.Mod@1.2.0", "Bare.Mod"],
      localisation: { GREETING: { english: "Hello", french: "Bonjour" } },
      url: "https://example.com/mod"
    })
    expect(result.blobsFolders).toEqual(["blobs"])
    expect(result.packagedefinition).toEqual([{ type: "partition" }])
    expect(result.supportedPlatforms).toEqual(["steam"])
    expect(result.requirements).toEqual([{ id: "Other.Mod", range: "^1.2.0" }, { id: "Bare.Mod", range: "*" }])
    expect(result.localisation).toEqual({ english: { GREETING: "Hello" }, french: { GREETING: "Bonjour" } })
    expect(result.url).toBe("https://example.com/mod")
  })

  test("rejects future framework, unsafe URL, unsupported platform, and mixed localisation", () => {
    for (const [field, value] of [
      ["frameworkVersion", "3.0.0"],
      ["url", "http://example.com"],
      ["supportedPlatforms", ["h2-steam"]],
      ["localisation", { english: { A: "x" }, A: { french: "y" } }]
    ] as const) {
      expect(() => normalizeManifest({ ...base, [field]: value })).toThrow(ManifestCompatibilityError)
    }
  })
})
