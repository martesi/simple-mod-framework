import { config, logger, rpkgInstance } from "./core-singleton"

import { freeDiskSpace } from "./smf-rust"
import fs from "fs-extra"
import md5 from "md5"
import path from "path"

import * as quickentity1136 from "./quickentity1136"
import * as quickentity20 from "./quickentity20"
import * as quickentity21 from "./quickentity"
import * as quickentity3 from "./quickentity-3"
import * as quickentityRs from "./quickentity-rs"

const QuickEntity = {
	"0.1": quickentity1136,
	"2.0": quickentity20,
	"2.1": quickentity21,
	"3.0": quickentity3,
	"3.1": quickentityRs,

	"999.999": quickentityRs
} as {
	[k: string]: {
		convert: (game: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string, output: string) => Promise<void>
		generate: (game: string, input: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string) => Promise<void>
		applyPatchJSON: (original: string, patch: string, output: string) => Promise<void>
	}
}

const QuickEntityPatch = {
	"0": quickentity1136,
	"3": quickentity20,
	"4": quickentity21,
	"5": quickentity3,
	"6": quickentityRs,

	"999": quickentityRs
} as {
	[k: string]: {
		convert: (game: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string, output: string) => Promise<void>
		generate: (game: string, input: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string) => Promise<void>
		applyPatchJSON: (original: string, patch: string, output: string) => Promise<void>
	}
}

// QuickEntity/QuickEntityPatch are static after module init, so their key lists never change -
// compute each once instead of twice per lookup call (Object.keys() + findIndex()'s Object.keys()).
const quickEntityVersionKeys = Object.keys(QuickEntity)
const quickEntityPatchVersionKeys = Object.keys(QuickEntityPatch)

export function getQuickEntityFromVersion(version: string) {
	void logger.verbose(`Getting QuickEntity version from entity version ${version}`)

	return QuickEntity[quickEntityVersionKeys[quickEntityVersionKeys.findIndex((a) => parseFloat(a) > Number(version)) - 1]]
}

export function getQuickEntityFromPatchVersion(version: string) {
	void logger.verbose(`Getting QuickEntity version from patch version ${version}`)

	return QuickEntityPatch[quickEntityPatchVersionKeys[quickEntityPatchVersionKeys.findIndex((a) => parseFloat(a) > Number(version)) - 1]]
}

export function hexflip(input: string) {
	let output = ""

	for (let i = input.length; i > 0 / 2; i = i - 2) {
		output += input.substr(i - 2, 2)
	}

	return output
}

export async function extractOrCopyToTemp(rpkgOfFile: string, file: string, type: string, stagingChunk = "chunk0") {
	await logger.verbose(`Extract or copy to temp: ${rpkgOfFile} ${file} ${type} ${stagingChunk}`)

	if (!fs.existsSync(path.join(process.cwd(), "staging", stagingChunk, `${file}.${type}`))) {
		await rpkgInstance.callFunction(`-extract_from_rpkg "${path.join(config.runtimePath, `${rpkgOfFile}.rpkg`)}" -filter "${file}" -output_path temp`) // Extract the file
	} else {
		fs.ensureDirSync(path.join(process.cwd(), "temp", rpkgOfFile, type))
		fs.copyFileSync(path.join(process.cwd(), "staging", stagingChunk, `${file}.${type}`), path.join(process.cwd(), "temp", rpkgOfFile, type, `${file}.${type}`)) // Use the staging one (for mod compat - one mod can extract, patch and build, then the next can patch that one instead)

		if (fs.existsSync(path.join(process.cwd(), "staging", stagingChunk, `${file}.${type}.meta`))) {
			fs.copyFileSync(path.join(process.cwd(), "staging", stagingChunk, `${file}.${type}.meta`), path.join(process.cwd(), "temp", rpkgOfFile, type, `${file}.${type}.meta`))
		}
	}
}

export async function copyFromCache(mod: string, cachePath: string, outputPath: string) {
	if (fs.existsSync(path.join(process.cwd(), "cache", winPathEscape(mod), cachePath))) {
		await logger.verbose(`Cache hit: ${mod} ${cachePath} ${outputPath}`)

		fs.ensureDirSync(outputPath)
		fs.copySync(path.join(process.cwd(), "cache", winPathEscape(mod), cachePath), outputPath)
		return true
	}

	await logger.verbose(`No cache hit: ${mod} ${cachePath} ${outputPath}`)

	return false
}

export async function copyToCache(mod: string, originalPath: string, cachePath: string) {
	// do not cache if less than 5 GB remaining on disk
	if (fs.existsSync(originalPath) && (await freeDiskSpace()) / 1024 / 1024 / 1024 > 5) {
		await logger.verbose(`Copy to cache: ${mod} ${originalPath} ${cachePath}`)

		fs.emptyDirSync(path.join(process.cwd(), "cache", winPathEscape(mod), cachePath))
		fs.copySync(originalPath, path.join(process.cwd(), "cache", winPathEscape(mod), cachePath))
		return true
	}

	await logger.verbose(`Not enough space/nonexistent path: ${mod} ${originalPath} ${cachePath}`)

	return false
}

export function winPathEscape(str: string) {
	return str
		.replace(/</gi, "")
		.replace(/>/gi, "")
		.replace(/:/gi, "")
		.replace(/"/gi, "")
		.replace(/\//gi, "")
		.replace(/\\/gi, "")
		.replace(/"/gi, "")
		.replace(/\|/gi, "")
		.replace(/\?/gi, "")
		.replace(/\*/gi, "")
}

export function isValidHash(hash: string) {
	return /\b[a-fA-F0-9]{16}$\b/g.test(hash)
}

export function normaliseToHash(hashOrPath: string) {
	return isValidHash(hashOrPath) ? hashOrPath : `00${md5(hashOrPath.toLowerCase()).slice(2, 16).toUpperCase()}`
}
