/**
 * @param {string} name
 * @returns {never}
 */
function requireArg(name) {
	throw new Error(`Missing required argument: ${name}`)
}

import fs from "fs"
import path from "path"
import * as LosslessJSON from "lossless-json"
import Decimal from "decimal.js"
import rfc6902 from "rfc6902"
import { Euler, MathUtils, Matrix4 } from "three"

// This file only uses Matrix4/Euler for rotation-matrix decomposition, plus the legacy
// `THREE.Math` alias (removed from three.js itself, replaced by MathUtils) for RAD2DEG/DEG2RAD.
// Previously this relied on a `global.THREE` set up by whichever entry point happened to import
// first (main.ts/patchWorker.ts) - a real, local import here means this file doesn't depend on
// ambient global state or import order at all.
const THREE = { Matrix4, Euler, Math: MathUtils, MathUtils }

const QuickEntityVersion = 1.135

// oi sieni shut up yeah?
// you've got ur select box
// - Atampy26

async function parseProperty(property, argsMode, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry) {
	if (property.value["$type"].startsWith("TArray<")) {
		for (var prop in property.value["$val"]) {
			var usedProp = {}
			usedProp.nPropertyID = ""
			usedProp.value = {
				"$type": property.value["$type"].slice(7, -1),
				"$val": property.value["$val"][prop]
			}

			parseProperty(usedProp, argsMode, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)

			property.value["$val"][prop] = usedProp.value["$val"]
		}

		return
	}

	if (property.value) {
		switch (property.value["$type"]) {
			case "SEntityTemplateReference":
				try {
					if (property.value["$val"].exposedEntity.length || property.value["$val"].externalSceneIndex != -1) {
						if (argsMode != "ids") {
							property.value["$val"] = {
								"ref": property.value["$val"].entityIndex == -2 ? "SPECIAL: Use EntityID" : entity.entities[property.value["$val"].entityIndex].name,
								"entityID": new Decimal(property.value["$val"].entityID.value).toHex().substring(2),
								"externalScene": property.value["$val"].externalSceneIndex != -1 ? TEMPmeta.hash_reference_data[TEMP.externalSceneTypeIndicesInResourceHeader[property.value["$val"].externalSceneIndex]].hash : "SPECIAL: None",
								"exposedEntity": property.value["$val"].exposedEntity
							}
						} else {
							property.value["$val"] = {
								"ref": property.value["$val"].entityIndex == -2 ? "SPECIAL: Use EntityID" : property.value["$val"].entityIndex,
								"entityID": new Decimal(property.value["$val"].entityID.value).toHex().substring(2),
								"externalScene": property.value["$val"].externalSceneIndex != -1 ? TEMPmeta.hash_reference_data[TEMP.externalSceneTypeIndicesInResourceHeader[property.value["$val"].externalSceneIndex]].hash : "SPECIAL: None",
								"exposedEntity": property.value["$val"].exposedEntity
							}
						}
					} else {
						if (argsMode != "ids") {
							property.value["$val"] = property.value["$val"].entityIndex == -2 ? "SPECIAL: Use EntityID" : property.value["$val"].entityIndex == -1 ? "SPECIAL: None" : entity.entities[property.value["$val"].entityIndex].name
						} else {
							property.value["$val"] = property.value["$val"].entityIndex == -2 ? "SPECIAL: Use EntityID" : property.value["$val"].entityIndex == -1 ? "SPECIAL: None" : property.value["$val"].entityIndex
						}
					}
				} catch (e) {
					console.log("Error in custom property parse (SEntityTemplateReference type) for " + entry.name + ": " + e)
				}
				break;

			case "ZRuntimeResourceID":
				try {
					if (property.value["$val"]["m_IDLow"] == 4294967295 && property.value["$val"]["m_IDHigh"] == 4294967295) {
						property.value["$val"] = "SPECIAL: None"
					} else {
						property.value["$val"] = TEMPmeta["hash_reference_data"][property.value["$val"]["m_IDLow"]].hash
					}
				} catch (e) {
					console.log("Error in custom property parse (ZRuntimeResourceID type) for " + entry.name + ": " + e)
				}
				break;

			case "SMatrix43":
				try {
					var matrix = new THREE.Matrix4()
					matrix.elements[0] = new Decimal(property.value["$val"].XAxis.x.value)
					matrix.elements[4] = new Decimal(property.value["$val"].XAxis.y.value)
					matrix.elements[8] = new Decimal(property.value["$val"].XAxis.z.value)

					matrix.elements[1] = new Decimal(property.value["$val"].YAxis.x.value)
					matrix.elements[5] = new Decimal(property.value["$val"].YAxis.y.value)
					matrix.elements[9] = new Decimal(property.value["$val"].YAxis.z.value)

					matrix.elements[2] = new Decimal(property.value["$val"].ZAxis.x.value)
					matrix.elements[6] = new Decimal(property.value["$val"].ZAxis.y.value)
					matrix.elements[10] = new Decimal(property.value["$val"].ZAxis.z.value)

					var euler = new THREE.Euler(0, 0, 0, "XYZ").setFromRotationMatrix(matrix)

					property.value["$val"] = {
						rotation: {
							x: euler["_x"] * THREE.Math.RAD2DEG,
							y: euler["_y"] * THREE.Math.RAD2DEG,
							z: euler["_z"] * THREE.Math.RAD2DEG
						},
						position: {
							x: property.value["$val"].Trans.x,
							y: property.value["$val"].Trans.y,
							z: property.value["$val"].Trans.z
						}
					}
				} catch (e) {
					console.log("Error in custom property parse (SMatrix43 type) for " + entry.name + ": " + e)
				}
				break;

			case "ZGuid":
				try {
					property.value["$val"] = `${Number(property.value["$val"]["_a"].value).toString(16).padStart(2,"0")}-${Number(property.value["$val"]["_b"].value).toString(16).padStart(2,"0")}-${Number(property.value["$val"]["_c"].value).toString(16).padStart(2,"0")}-${Number(property.value["$val"]["_d"].value).toString(16).padStart(2,"0")}${Number(property.value["$val"]["_e"].value).toString(16).padStart(2,"0")}-${Number(property.value["$val"]["_f"].value).toString(16).padStart(2,"0")}${Number(property.value["$val"]["_g"].value).toString(16).padStart(2,"0")}${Number(property.value["$val"]["_h"].value).toString(16).padStart(2,"0")}${Number(property.value["$val"]["_i"].value).toString(16).padStart(2,"0")}${Number(property.value["$val"]["_j"].value).toString(16).padStart(2,"0")}${Number(property.value["$val"]["_k"].value).toString(16).padStart(2,"0")}`
				} catch (e) {
					console.log("Error in custom property parse (ZGuid type) for " + entry.name + ": " + e)
				}
				break;

			case "SColorRGB":
				try {
					property.value["$val"] = "#" + (Math.round(Number(property.value["$val"].r.value) * 255)).toString(16).padStart(2,"0") + (Math.round(Number(property.value["$val"].g.value) * 255)).toString(16).padStart(2,"0") + (Math.round(Number(property.value["$val"].b.value) * 255)).toString(16).padStart(2,"0")
				} catch (e) {
					console.log("Error in custom property parse (SColorRGB type) for " + entry.name + ": " + e)
				}
				break;

			case "SColorRGBA":
				try {
					property.value["$val"] = "#" + (Math.round(Number(property.value["$val"].r.value) * 255)).toString(16).padStart(2,"0") + (Math.round(Number(property.value["$val"].g.value) * 255)).toString(16).padStart(2,"0") + (Math.round(Number(property.value["$val"].b.value) * 255)).toString(16).padStart(2,"0") + (Math.round(Number(property.value["$val"].a.value) * 255)).toString(16).padStart(2,"0")
				} catch (e) {
					console.log("Error in custom property parse (SColorRGBA type) for " + entry.name + ": " + e)
				}
				break;

			// case "ZGameTime":
			//     try {
			//         property.value["$val"] = new LosslessJSON.LosslessNumber(property.value["$val"].value / 1024 / 1024)
			//         property.value["$type"] = "ZGameTimeSeconds"
			//     } catch (e) {
			//         console.log("Error in custom property parse (ZGameTime type) for " + entry.name + ": " + e)
			//     }
			//     break;
		}
	}
}

async function rebuildSpecificProp(property, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, findEntityCache) {
	switch (property.type) {
		// case "ZGameTimeSeconds":
		//     return {
		//         "nPropertyID": property.name,
		//         "value": {
		//             "$type": "ZGameTime",
		//             "$val": new LosslessJSON.LosslessNumber(Number(property.value.value) * 1024 * 1024)
		//         }
		//     }
		//     break

		case "SColorRGB":
			return {
				"nPropertyID": property.name,
				"value": {
					"$type": "SColorRGB",
					"$val": {
						"r": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(0,2), 16) / 255).toString()),
						"g": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(2,4), 16) / 255).toString()),
						"b": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(4,6), 16) / 255).toString())
					}
				}
			}
			break
		case "SColorRGBA":
			return {
				"nPropertyID": property.name,
				"value": {
					"$type": "SColorRGBA",
					"$val": {
						"r": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(0,2), 16) / 255).toString()),
						"g": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(2,4), 16) / 255).toString()),
						"b": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(4,6), 16) / 255).toString()),
						"a": new LosslessJSON.LosslessNumber((parseInt(property.value.substring(1).slice(6,8), 16) / 255).toString())
					}
				}
			}
			break
		case "ZGuid":
			return {
				"nPropertyID": property.name,
				"value": {
					"$type": "ZGuid",
					"$val": {
						"_a": parseInt(property.value.split("-")[0], 16),
						"_b": parseInt(property.value.split("-")[1], 16),
						"_c": parseInt(property.value.split("-")[2], 16),
						"_d": parseInt(property.value.split("-")[3].slice(0,2), 16),
						"_e": parseInt(property.value.split("-")[3].slice(2,4), 16),
						"_f": parseInt(property.value.split("-")[4].slice(0,2), 16),
						"_g": parseInt(property.value.split("-")[4].slice(2,4), 16),
						"_h": parseInt(property.value.split("-")[4].slice(4,6), 16),
						"_i": parseInt(property.value.split("-")[4].slice(6,8), 16),
						"_j": parseInt(property.value.split("-")[4].slice(8,10), 16),
						"_k": parseInt(property.value.split("-")[4].slice(10,12), 16)
					}
				}
			}
			break
		case "SMatrix43":
			var matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(new Decimal(property.value.rotation.x.value) * THREE.Math.DEG2RAD, new Decimal(property.value.rotation.y.value) * THREE.Math.DEG2RAD, new Decimal(property.value.rotation.z.value) * THREE.Math.DEG2RAD, "XYZ"))

			return {
				"nPropertyID": property.name,
				"value": {
					"$type": "SMatrix43",
					"$val": {
						"XAxis": {
							"x": Number(matrix.elements[0]),
							"y": Number(matrix.elements[4]),
							"z": Number(matrix.elements[8])
						},
						"YAxis": {
							"x": Number(matrix.elements[1]),
							"y": Number(matrix.elements[5]),
							"z": Number(matrix.elements[9])
						},
						"ZAxis": {
							"x": Number(matrix.elements[2]),
							"y": Number(matrix.elements[6]),
							"z": Number(matrix.elements[10])
						},
						"Trans": {
							"x": property.value.position.x,
							"y": property.value.position.y,
							"z": property.value.position.z
						}
					}
				}
			}
			break
		case "SEntityTemplateReference":
			return {
				"nPropertyID": property.name,
				"value": {
					"$type": property.type,
					"$val": typeof property.value == "object" && property.value.ref ? {
						"entityID": new LosslessJSON.LosslessNumber(new Decimal("0x" + property.value.entityID).toFixed()),
						"externalSceneIndex": property.value.externalScene,
						"entityIndex": findEntity(findEntityCache, property.value.ref),
						"exposedEntity": property.value.exposedEntity
					} : {
						"entityID": new LosslessJSON.LosslessNumber("18446744073709551615"),
						"externalSceneIndex": -1,
						"entityIndex": findEntity(findEntityCache, property.value),
						"exposedEntity": ""
					}
				}
			}
			break
		case "ZRuntimeResourceID":
			if (property.value == "SPECIAL: None") {
				return {
					"nPropertyID": property.name,
					"value": {
						"$type": property.type,
						"$val": {
							"m_IDHigh": 4294967295,
							"m_IDLow": 4294967295
						}
					}
				}

				break
			}

			if (!TEMPmeta.hash_reference_data.find(a => a.hash == property.value)) {
				TEMPmeta.hash_reference_data.push({
					"hash": property.value,
					"flag": "1F"
				})
			}

			return {
				"nPropertyID": property.name,
				"value": {
					"$type": property.type,
					"$val": {
						"m_IDHigh": 0,
						"m_IDLow": TEMPmeta["hash_reference_data"].findIndex(a => a.hash == property.value)
					}
				}
			}
			break
		default:
			return {
				"nPropertyID": property.name,
				"value": property.type ? {
					"$type": property.type,
					"$val": property.value
				} : undefined
			}
			break
	}
}

async function rebuildProperty(property, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, index, findEntityCache, isOverrides = false) {
	if (property.type.startsWith("TArray<")) {
		propertyToAdd = {
			"nPropertyID": property.name,
			"value": property.type ? {
				"$type": property.type,
				"$val": property.value
			} : undefined
		}

		for (var prop in propertyToAdd.value["$val"]) {
			var usedProp = {}
			usedProp.name = ""
			usedProp.type = property.type.slice(7, -1)
			usedProp.value = propertyToAdd.value["$val"][prop]

			propertyToAdd.value["$val"][prop] = (await rebuildSpecificProp(usedProp, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, findEntityCache)).value["$val"]
		}

		if (isOverrides) {
			TEMP["propertyOverrides"][index][propertyValues] = propertyToAdd
		} else {
			TEMP.subEntities[index][propertyValues].push(propertyToAdd)
		}

		return
	}

	propertyToAdd = await rebuildSpecificProp(property, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, findEntityCache)

	if (isOverrides) {
		TEMP["propertyOverrides"][index][propertyValues] = propertyToAdd
	} else {
		TEMP.subEntities[index][propertyValues].push(propertyToAdd)
	}
}

async function convert(automateGame = false, automateMode = false, automateTempPath = false, automateTempMetaPath = false, automateTbluPath = false, automateTbluMetaPath = false, automateQNPath = false) {

const args = process.argv.slice(2)


const tempPath = automateTempPath || requireArg("automateTempPath")

const TEMP = LosslessJSON.parse(String(fs.readFileSync(tempPath)))
const TEMPmeta = LosslessJSON.parse(String(fs.readFileSync(automateTempMetaPath || requireArg("automateTempMetaPath"))))

const tbluPath = automateTbluPath || requireArg("automateTbluPath")

const TBLU = LosslessJSON.parse(String(fs.readFileSync(tbluPath)))
const TBLUmeta = LosslessJSON.parse(String(fs.readFileSync(automateTbluMetaPath || requireArg("automateTbluMetaPath"))))

const game = automateGame || requireArg("automateGame")

if (game === "HM2016") {
	TEMP.subEntities = TEMP.entityTemplates
	delete TEMP.entityTemplates

	TBLU.subEntities = TBLU.entityTemplates
	delete TBLU.entityTemplates
}

var argsMode = automateMode ? automateMode : undefined

if (!automateMode) {
	var allEntityNames = TBLU.subEntities.map(object => object.entityName)

	if (new Set(allEntityNames).size == allEntityNames.length) {
		argsMode = "names"
	} else {
		requireArg("automateMode ('ids' or 'names' - required because this entity has duplicate subEntity names)")
	}
}

// {
//     "rootEntityIndex": 0,
//     "subEntities": [
//         {
//             "entityTemplate": "",
//             "entityBlueprint": "",
//             "propertyValues": [],
//             "postInitPropertyValues": [],
//             "platformSpecificPropertyValues": [],
//             "entityName": "Scene",
//             "propertyAliases": [],
//             "exposedEntities": [],
//             "exposedInterfaces": [],
//             "entitySubsets": []
//         },
//     ],
//     "propertyOverrides": [],
//     "externalSceneTypeIndicesInResourceHeader": [
//     ]
// }

var entity =  {
	"tempHash": path.basename(tempPath).slice(0, -10),
	"tbluHash": path.basename(tbluPath).slice(0, -10),
	"rootEntity": TBLU.subEntities[TEMP.rootEntityIndex].entityName,
	"entities": [],
	"externalScenes": [],
	"propertyOverrides": TEMP.propertyOverrides,
	"overrideDeletes": TBLU.overrideDeletes,
	"pinConnectionOverrides": TBLU.pinConnectionOverrides,
	"pinConnectionOverrideDeletes": TBLU.pinConnectionOverrideDeletes,
	"subType": TEMP.subType,
	"quickEntityVersion": QuickEntityVersion,
	"quickEntityMode": argsMode
}

index = 0
for (var entry of TEMP.subEntities) {
	var subsets = []

	try {
		for (var subset of TBLU.subEntities[index].entitySubsets) {
			var subsetData = subset[1]
			for (var subsetEntity in subsetData.entities) {
				subsetData.entities[subsetEntity] = argsMode == "ids" ? subsetData.entities[subsetEntity] : TBLU.subEntities[subsetData.entities[subsetEntity]].entityName
			}
			subsets.push([subset[0], subsetData])
		}
	} catch (e) {
		console.log("Error deindexing entitySubsets for entity " + index + ": " + e)
	}

	entity.entities.push({
		"parent": {
			"ref": argsMode == "ids" ? (entry.logicalParent.entityIndex >= 0 ? entry.logicalParent.entityIndex : (entry.logicalParent.entityIndex == -2 ? "SPECIAL: Use EntityID" : "SPECIAL: None")) : (entry.logicalParent.entityIndex >= 0 ? TBLU.subEntities[entry.logicalParent.entityIndex].entityName : (entry.logicalParent.entityIndex == -2 ? "SPECIAL: Use EntityID" : "SPECIAL: None")),
			"exposedEntity": entry.logicalParent.exposedEntity,
			"externalScene": entry.logicalParent.externalSceneIndex >= 0 ? TEMPmeta["hash_reference_data"][TEMP.externalSceneTypeIndicesInResourceHeader[entry.logicalParent.externalSceneIndex]].hash : "SPECIAL: None",
			"entityID": new Decimal(entry.logicalParent.entityID.value).toHex().substring(2)
		},
		"name": TBLU.subEntities[index].entityName,
		"template": TEMPmeta["hash_reference_data"][entry.entityTypeResourceIndex].hash,
		"blueprint": TBLUmeta["hash_reference_data"][TBLU.subEntities[index].entityTypeResourceIndex].hash,
		"properties": [],
		"postInitProperties": [],
		"editorOnly": TBLU.subEntities[index].editorOnly,
		"propertyValues": entry.propertyValues,
		"postInitPropertyValues": entry.postInitPropertyValues,
		"platformSpecificPropertyValues": entry.platformSpecificPropertyValues ? entry.platformSpecificPropertyValues : [],
		"propertyAliases": TBLU.subEntities[index].propertyAliases,
		"exposedEntities": TBLU.subEntities[index].exposedEntities,
		"exposedInterfaces": TBLU.subEntities[index].exposedInterfaces,
		"entitySubsets": subsets,
		"entityID": new Decimal(TBLU.subEntities[index].entityId.value).toHex().substring(2)
	})

	if (argsMode == "ids") {
		entity.entities[index].refID = index
	}

	index ++
}

for (var entry of entity.entities) {
	var propertyValues = LosslessJSON.parse(LosslessJSON.stringify(entry.propertyValues))
	for (var property of propertyValues) {
		await parseProperty(property, argsMode, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)
	}

	entry.properties = []
	for (var property of propertyValues) {
		entry.properties.push({
			name: property.nPropertyID,
			type: property.value ? property.value["$type"] : undefined,
			value: property.value ? property.value["$val"] : undefined
		})
	}

	delete entry.propertyValues
}

for (var entry of entity.entities) {
	var postInitPropertyValues = LosslessJSON.parse(LosslessJSON.stringify(entry.postInitPropertyValues))
	for (var property of postInitPropertyValues) {
		await parseProperty(property, argsMode, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)
	}

	entry.postInitProperties = []
	for (var property of postInitPropertyValues) {
		entry.postInitProperties.push({
			name: property.nPropertyID,
			type: property.value ? property.value["$type"] : undefined,
			value: property.value ? property.value["$val"] : undefined
		})
	}

	delete entry.postInitPropertyValues
}

for (var entry of entity.entities) {
	if (!entry.propertyAliases.length) {
		delete entry.propertyAliases
	}
	
	if (!entry.exposedEntities.length) {
		delete entry.exposedEntities
	}
	
	if (!entry.exposedInterfaces.length) {
		delete entry.exposedInterfaces
	}
	
	if (!entry.entitySubsets.length) {
		delete entry.entitySubsets
	}
}

for (var sceneTypeIndex of TEMP.externalSceneTypeIndicesInResourceHeader) {
	entity.externalScenes.push(TEMPmeta["hash_reference_data"][sceneTypeIndex].hash)
}

for (var pin of TBLU.pinConnections) {
	if (!entity.entities[pin.fromID].events) {
		entity.entities[pin.fromID].events = []
	}

	entity.entities[pin.fromID].events.push({
		onEvent: pin.fromPinName,
		shouldTrigger: pin.toPinName,
		onEntity: argsMode == "ids" ? pin.toID : entity.entities[pin.toID].name,
		value: pin.constantPinValue ? (pin.constantPinValue["$type"] == "void" ? undefined : {
			type: pin.constantPinValue["$type"],
			value: pin.constantPinValue["$val"],
		}) : undefined
	})
}

for (var pin of TBLU.inputPinForwardings) {
	if (!entity.entities[pin.fromID].inputCopying) {
		entity.entities[pin.fromID].inputCopying = []
	}

	entity.entities[pin.fromID].inputCopying.push({
		whenTriggered: pin.fromPinName,
		alsoTrigger: pin.toPinName,
		onEntity: argsMode == "ids" ? pin.toID : entity.entities[pin.toID].name,
		value: pin.constantPinValue ? (pin.constantPinValue["$type"] == "void" ? undefined : {
			type: pin.constantPinValue["$type"],
			value: pin.constantPinValue["$val"],
		}) : undefined
	})
}

for (var pin of TBLU.outputPinForwardings) {
	if (!entity.entities[pin.fromID].outputCopying) {
		entity.entities[pin.fromID].outputCopying = []
	}

	entity.entities[pin.fromID].outputCopying.push({
		onEvent: pin.fromPinName,
		propagateEvent: pin.toPinName,
		onEntity: argsMode == "ids" ? pin.toID : entity.entities[pin.toID].name,
		value: pin.constantPinValue ? (pin.constantPinValue["$type"] == "void" ? undefined : {
			type: pin.constantPinValue["$type"],
			value: pin.constantPinValue["$val"],
		}) : undefined
	})
}

for (var entry of entity.propertyOverrides) {
	entry.propertyOwner.externalScene = entry.propertyOwner.externalSceneIndex >= 0 ? TBLUmeta["hash_reference_data"][TBLU.externalSceneTypeIndicesInResourceHeader[entry.propertyOwner.externalSceneIndex]].hash : "SPECIAL: None"
	delete entry.propertyOwner.externalSceneIndex

	await parseProperty(entry.propertyValue, argsMode, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)

	entry.propertyValue = {
		name: entry.propertyValue.nPropertyID,
		type: entry.propertyValue.value ? entry.propertyValue.value["$type"] : undefined,
		value: entry.propertyValue.value ? entry.propertyValue.value["$val"] : undefined
	}
}

for (var entry of entity.overrideDeletes) {
	entry.externalScene = entry.externalSceneIndex >= 0 ? TBLUmeta["hash_reference_data"][TBLU.externalSceneTypeIndicesInResourceHeader[entry.externalSceneIndex]].hash : "SPECIAL: None"
	delete entry.externalSceneIndex
}

if (game !== "HM2016") {
	for (var entry of entity.pinConnectionOverrides) {
		entry.fromEntity.externalScene = entry.fromEntity.externalSceneIndex >= 0 ? TBLUmeta["hash_reference_data"][TBLU.externalSceneTypeIndicesInResourceHeader[entry.fromEntity.externalSceneIndex]].hash : "SPECIAL: None"
		delete entry.fromEntity.externalSceneIndex

		entry.toEntity.externalScene = entry.toEntity.externalSceneIndex >= 0 ? TBLUmeta["hash_reference_data"][TBLU.externalSceneTypeIndicesInResourceHeader[entry.toEntity.externalSceneIndex]].hash : "SPECIAL: None"
		delete entry.toEntity.externalSceneIndex
	}

	for (var entry of entity.pinConnectionOverrideDeletes) {
		entry.fromEntity.externalScene = entry.fromEntity.externalSceneIndex >= 0 ? TBLUmeta["hash_reference_data"][TBLU.externalSceneTypeIndicesInResourceHeader[entry.fromEntity.externalSceneIndex]].hash : "SPECIAL: None"
		delete entry.fromEntity.externalSceneIndex

		entry.toEntity.externalScene = entry.toEntity.externalSceneIndex >= 0 ? TBLUmeta["hash_reference_data"][TBLU.externalSceneTypeIndicesInResourceHeader[entry.toEntity.externalSceneIndex]].hash : "SPECIAL: None"
		delete entry.toEntity.externalSceneIndex
	}
}

fs.writeFileSync(automateQNPath || requireArg("automateQNPath"), LosslessJSON.stringify(entity))
}

function findEntity(cache, ref) {
	return ref == "SPECIAL: None" ? -1 : ref == "SPECIAL: Use EntityID" ? -2 : cache.hasOwnProperty(ref) ? cache[ref] : -1
}

async function generate(automateGame = false, automateQNPath = false, automateTempPath = false, automateTempMetaPath = false, automateTbluPath = false, automateTbluMetaPath = false) {

const game = automateGame || requireArg("automateGame")

const entity = LosslessJSON.parse(String(fs.readFileSync(automateQNPath || requireArg("automateQNPath"))))

const argsMode = entity.quickEntityMode

if (argsMode != "ids") {
	var allEntityNames = entity.entities.map(object => object.name)
	if (new Set(allEntityNames).size != allEntityNames.length) {
		throw new Error("The QuickEntity JSON was converted using names mode but contains duplicate entity names. Converting to ResourceTool Source will likely result in loss of rebuilding integrity.")
	}
}

const findEntityCache = {}
if (argsMode == "ids") {
	for (var entry in entity.entities) {
		findEntityCache[entity.entities[entry].refID] = Number(entry)
	}
} else {
	for (var entry in entity.entities) {
		findEntityCache[entity.entities[entry].name] = Number(entry)
	}
}


var TEMP = {
	"subType": entity.subType,
	"blueprintIndexInResourceHeader": 0,
	"rootEntityIndex": entity.entities.findIndex(a => a.name == entity.rootEntity),
	"subEntities": [],
	"propertyOverrides": entity.propertyOverrides,
	"externalSceneTypeIndicesInResourceHeader": []
}

var TEMPmeta = {
	"hash_value": entity.tempHash,
	"hash_offset": 1367,
	"hash_size": 2147484657,
	"hash_resource_type": "TEMP",
	"hash_reference_table_size": 193,
	"hash_reference_table_dummy": 0,
	"hash_size_final": 2377,
	"hash_size_in_memory": 1525,
	"hash_size_in_video_memory": 4294967295,
	"hash_reference_data": []
}

var TBLU = {
	"subType": entity.subType,
	"rootEntityIndex": entity.entities.findIndex(a => a.name == entity.rootEntity),
	"subEntities": [],
	"externalSceneTypeIndicesInResourceHeader": [],
	"overrideDeletes": entity.overrideDeletes,
	"pinConnectionOverrides": game !== "HM2016" ? entity.pinConnectionOverrides : undefined,
	"pinConnectionOverrideDeletes": game !== "HM2016" ? entity.pinConnectionOverrideDeletes : undefined
}

var TBLUmeta = {
	"hash_value": entity.tbluHash,
	"hash_offset": 359,
	"hash_size": 2147484656,
	"hash_resource_type": "TBLU",
	"hash_reference_table_size": 184,
	"hash_reference_table_dummy": 0,
	"hash_size_final": 2380,
	"hash_size_in_memory": 1715,
	"hash_size_in_video_memory": 4294967295,
	"hash_reference_data": []
}

TEMPmeta.hash_reference_data.push({
	"hash": entity.tbluHash,
	"flag": "1F"
})


for (var externalScene of entity.externalScenes) {
	TEMPmeta.hash_reference_data.push({
		"hash": externalScene,
		"flag": "1F"
	})

	TEMP.externalSceneTypeIndicesInResourceHeader.push(TEMPmeta.hash_reference_data.length - 1)

	TBLUmeta.hash_reference_data.push({
		"hash": externalScene,
		"flag": "1F"
	})

	TBLU.externalSceneTypeIndicesInResourceHeader.push(TBLUmeta.hash_reference_data.length - 1)
}


/*
	GENERATE: SKELETON DATA
*/

var tempInitialIndex = TEMPmeta.hash_reference_data.length
var tbluInitialIndex = TBLUmeta.hash_reference_data.length
var soFarUsedTEMP = new Set()
var soFarUsedTBLU = new Set()

for (var entry of entity.entities) {
	if (!soFarUsedTEMP.has(entry.template)) {
		TEMPmeta.hash_reference_data.push({
			"hash": entry.template,
			"flag": "1F"
		})
		soFarUsedTEMP.add(entry.template)
	}

	if (!soFarUsedTBLU.has(entry.blueprint)) {
		TBLUmeta.hash_reference_data.push({
			"hash": entry.blueprint,
			"flag": "1F"
		})
		soFarUsedTBLU.add(entry.blueprint)
	}
}

soFarUsedTEMP = [...soFarUsedTEMP]
soFarUsedTBLU = [...soFarUsedTBLU]

for (var entry of entity.entities) {
	TEMP.subEntities.push({
		"logicalParent": {
			"entityID": new LosslessJSON.LosslessNumber("18446744073709551615"),
			"externalSceneIndex": -1,
			"entityIndex": 0,
			"exposedEntity": ""
		},
		"entityTypeResourceIndex": soFarUsedTEMP.indexOf(entry.template) + tempInitialIndex,
		"propertyValues": [],
		"postInitPropertyValues": [],
		"platformSpecificPropertyValues": entry.platformSpecificPropertyValues ? entry.platformSpecificPropertyValues : []
	})

	TBLU.subEntities.push({
		"logicalParent": {
			"entityID": new LosslessJSON.LosslessNumber("18446744073709551615"),
			"externalSceneIndex": -1,
			"entityIndex": 0,
			"exposedEntity": ""
		},
		"entityTypeResourceIndex": soFarUsedTBLU.indexOf(entry.blueprint) + tbluInitialIndex,
		"entityId": new LosslessJSON.LosslessNumber(new Decimal("0x" + entry.entityID).toFixed()),
		"editorOnly": entry.editorOnly ? true : false,
		"entityName": entry.name,
		"propertyAliases": entry.propertyAliases ? entry.propertyAliases : [],
		"exposedEntities": entry.exposedEntities ? entry.exposedEntities : [],
		"exposedInterfaces": entry.exposedInterfaces ? entry.exposedInterfaces : [],
		"entitySubsets": entry.entitySubsets ? entry.entitySubsets : []
	})
}


/*
	REINDEX: entitySubsets, logicalParent
*/

index = 0
for (var entry of entity.entities) {
	if (entry.entitySubsets) {
		for (var subset of entry.entitySubsets) {
			for (var item in subset[1]["entities"]) {
				subset[1]["entities"][item] = findEntity(findEntityCache, subset[1]["entities"][item])
			}
		}
	}

	TEMP.subEntities[index].logicalParent.entityIndex = findEntity(findEntityCache, entry.parent.ref)
	TBLU.subEntities[index].logicalParent.entityIndex = findEntity(findEntityCache, entry.parent.ref)

	TEMP.subEntities[index].logicalParent.entityID = new LosslessJSON.LosslessNumber(new Decimal("0x" + entry.parent.entityID).toFixed())
	TBLU.subEntities[index].logicalParent.entityID = new LosslessJSON.LosslessNumber(new Decimal("0x" + entry.parent.entityID).toFixed())

	TEMP.subEntities[index].logicalParent.exposedEntity = entry.parent.exposedEntity
	TBLU.subEntities[index].logicalParent.exposedEntity = entry.parent.exposedEntity

	TEMP.subEntities[index].logicalParent.externalSceneIndex = entry.parent.externalScene
	TBLU.subEntities[index].logicalParent.externalSceneIndex = entry.parent.externalScene

	index ++
}


/*
	GENERATE: propertyValues, postInitPropertyValues
*/

index = 0
for (var entry of entity.entities) {
	for (var property of entry.properties) {
		await rebuildProperty(property, "propertyValues", TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, index, findEntityCache)
	}

	for (var property of entry.postInitProperties) {
		await rebuildProperty(property, "postInitPropertyValues", TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, index, findEntityCache)
	}
	index ++
}


/*
	REBUILD: propertyOverrides
*/

index = 0
for (var entry of TEMP.propertyOverrides) {
	await rebuildProperty(entry.propertyValue, "propertyValue", TEMP, TBLU, TEMPmeta, TBLUmeta, argsMode, entity, entry, index, findEntityCache, true)
	index++
}


/*
	REINDEX: externalSceneIndexes IN overrides
*/

for (var entry of TEMP.propertyOverrides) {
	entry.propertyOwner.externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == entry.propertyOwner.externalScene)
	delete entry.propertyOwner.externalScene

	if (entry.propertyValue.value["$type"] == "TArray<SEntityTemplateReference>") {
		for (var property2 of entry.propertyValue.value["$val"]) {
			if (typeof property2.externalSceneIndex == "string") {
				property2.externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == property2.externalSceneIndex)
			}
		}
	} else if (entry.propertyValue.value["$type"] == "SEntityTemplateReference") {
		if (typeof entry.propertyValue.value["$val"].externalSceneIndex == "string") {
			entry.propertyValue.value["$val"].externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == entry.propertyValue.value["$val"].externalSceneIndex)
		}
	}
}

for (var entry of TBLU.overrideDeletes) {
	entry.externalSceneIndex = TBLU.externalSceneTypeIndicesInResourceHeader.findIndex(a => TBLUmeta.hash_reference_data[a].hash == entry.externalScene)
	delete entry.externalScene
}


if (game !== "HM2016") {
	for (var entry of TBLU.pinConnectionOverrides) {
		entry.fromEntity.externalSceneIndex = TBLU.externalSceneTypeIndicesInResourceHeader.findIndex(a => TBLUmeta.hash_reference_data[a].hash == entry.fromEntity.externalScene)
		delete entry.fromEntity.externalScene

		entry.toEntity.externalSceneIndex = TBLU.externalSceneTypeIndicesInResourceHeader.findIndex(a => TBLUmeta.hash_reference_data[a].hash == entry.toEntity.externalScene)
		delete entry.toEntity.externalScene
	}

	for (var entry of TBLU.pinConnectionOverrideDeletes) {
		entry.fromEntity.externalSceneIndex = TBLU.externalSceneTypeIndicesInResourceHeader.findIndex(a => TBLUmeta.hash_reference_data[a].hash == entry.fromEntity.externalScene)
		delete entry.fromEntity.externalScene

		entry.toEntity.externalSceneIndex = TBLU.externalSceneTypeIndicesInResourceHeader.findIndex(a => TBLUmeta.hash_reference_data[a].hash == entry.toEntity.externalScene)
		delete entry.toEntity.externalScene
	}
}


/*
	REINDEX: externalSceneIndexes IN TEMP logicalParent, propertyValues
*/

for (var entry of TEMP.subEntities) {
	entry.logicalParent.externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == entry.logicalParent.externalSceneIndex)

	for (var property of entry.propertyValues) {
		if (property.value["$type"] == "TArray<SEntityTemplateReference>") {
			for (var property2 of property.value["$val"]) {
				if (typeof property2.externalSceneIndex == "string") {
					property2.externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == property2.externalSceneIndex)
				}
			}
		} else if (property.value["$type"] == "SEntityTemplateReference") {
			if (typeof property.value["$val"].externalSceneIndex == "string") {
				property.value["$val"].externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == property.value["$val"].externalSceneIndex)
			}
		}
	}

	for (var property of entry.postInitPropertyValues) {
		if (property.value["$type"] == "TArray<SEntityTemplateReference>") {
			for (var property2 of property.value["$val"]) {
				if (typeof property2.externalSceneIndex == "string") {
					property2.externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == property2.externalSceneIndex)
				}
			}
		} else if (property.value["$type"] == "SEntityTemplateReference") {
			if (typeof property.value["$val"].externalSceneIndex == "string") {
				property.value["$val"].externalSceneIndex = TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == property.value["$val"].externalSceneIndex)
			}
		}
	}
}


/*
	REINDEX: externalSceneIndex IN TBLU logicalParent
*/

for (var entry of TBLU.subEntities) {
	entry.logicalParent.externalSceneIndex = TBLU.externalSceneTypeIndicesInResourceHeader.findIndex(a => TBLUmeta.hash_reference_data[a].hash == entry.logicalParent.externalSceneIndex)
}


/*
	ADD: pins
*/

TBLU.pinConnections = []
TBLU.inputPinForwardings = []
TBLU.outputPinForwardings = []

index = 0
for (var entry of entity.entities) {
	if (entry.events) {
		for (var pin of entry.events) {
			TBLU.pinConnections.push({
				"fromID": index,
				"toID": findEntity(findEntityCache, pin.onEntity),
				"fromPinName": pin.onEvent,
				"toPinName": pin.shouldTrigger,
				"constantPinValue": game !== "HM2016" ? {
					"$type": pin.value ? pin.value.type : "void",
					"$val": pin.value ? pin.value.value : null
				} : undefined
			})
		}
	}

	if (entry.inputCopying) {
		for (var pin of entry.inputCopying) {
			TBLU.inputPinForwardings.push({
				"fromID": index,
				"toID": findEntity(findEntityCache, pin.onEntity),
				"fromPinName": pin.whenTriggered,
				"toPinName": pin.alsoTrigger,
				"constantPinValue": game !== "HM2016" ? {
					"$type": pin.value ? pin.value.type : "void",
					"$val": pin.value ? pin.value.value : null
				} : undefined
			})
		}
	}

	if (entry.outputCopying) {
		for (var pin of entry.outputCopying) {
			TBLU.outputPinForwardings.push({
				"fromID": index,
				"toID": findEntity(findEntityCache, pin.onEntity),
				"fromPinName": pin.onEvent,
				"toPinName": pin.propagateEvent,
				"constantPinValue": game !== "HM2016" ? {
					"$type": pin.value ? pin.value.type : "void",
					"$val": pin.value ? pin.value.value : null
				} : undefined
			})
		}
	}

	index ++
}


if (game == "HM2016") {
	TEMP.entityTemplates = TEMP.subEntities
	delete TEMP.subEntities

	TBLU.entityTemplates = TBLU.subEntities
	delete TBLU.subEntities
}

var tempRebuildPath = automateTempPath || requireArg("automateTempPath")
fs.writeFileSync(tempRebuildPath, LosslessJSON.stringify(TEMP))

var tempMetaRebuildPath = automateTempMetaPath || requireArg("automateTempMetaPath")
fs.writeFileSync(tempMetaRebuildPath, LosslessJSON.stringify(TEMPmeta))

var tbluRebuildPath = automateTbluPath || requireArg("automateTbluPath")
fs.writeFileSync(tbluRebuildPath, LosslessJSON.stringify(TBLU))

var tbluMetaRebuildPath = automateTbluMetaPath || requireArg("automateTbluMetaPath")
fs.writeFileSync(tbluMetaRebuildPath, LosslessJSON.stringify(TBLUmeta))

return {
	tempRebuildPath,
	tempMetaRebuildPath,
	tbluRebuildPath,
	tbluMetaRebuildPath
}

}

function patchCheckLosslessNumber(input, output, pointer) {
	if ((input instanceof LosslessJSON.LosslessNumber && output instanceof LosslessJSON.LosslessNumber)) {
		if (input.value !== output.value) {
			return [{op: 'replace', path: pointer.toString(), value: "LN|" + output.value}]
		} else {
			return []
		}
	}
}

async function createPatchJSON(automateQN1Path = false, automateQN2Path = false, automateOutputPath = false) {
	let entity1 = LosslessJSON.parse(String(fs.readFileSync(automateQN1Path || requireArg("automateQN1Path"))))

	let entity2 = LosslessJSON.parse(String(fs.readFileSync(automateQN2Path || requireArg("automateQN2Path"))))

	const findEntityCacheEntity1 = {}
	for (var entry in entity1.entities) {
		findEntityCacheEntity1[entity1.entities[entry].refID] = Number(entry)
	}

	const findEntityCacheEntity2 = {}
	for (var entry in entity2.entities) {
		findEntityCacheEntity2[entity2.entities[entry].refID] = Number(entry)
	}

	for (let entry of entity1.entities) {
		delete entry.refID

		if (entry.parent.ref.value) {
			entry.parent.ref = entity1.entities[findEntityCacheEntity1[entry.parent.ref.value]].entityID
		}

		if (entry.events)
		for (let pin of entry.events) {
			pin.onEntity = entity1.entities[findEntityCacheEntity1[pin.onEntity.value]].entityID
		}

		if (entry.inputCopying)
		for (let pin of entry.inputCopying) {
			pin.onEntity = entity1.entities[findEntityCacheEntity1[pin.onEntity.value]].entityID
		}

		if (entry.outputCopying)
		for (let pin of entry.outputCopying) {
			pin.onEntity = entity1.entities[findEntityCacheEntity1[pin.onEntity.value]].entityID
		}

		if (entry.exposedInterfaces)
		for (let int of entry.exposedInterfaces) {
			int[1] = entity1.entities[findEntityCacheEntity1[int[1]]].entityID
		}

		if (entry.entitySubsets)
		for (let subset of entry.entitySubsets) {
			for (let subSubset in subset[1].entities) {
				subset[1].entities[subSubset] = entity1.entities[findEntityCacheEntity1[subset[1].entities[subSubset]]].entityID
			}
		}

		if (entry.propertyAliases)
		for (let alias of entry.propertyAliases) {
			alias.entityID = entity1.entities[findEntityCacheEntity1[alias.entityID]].entityID
		}

		for (let prop of entry.properties) {
			if (prop.type == "SEntityTemplateReference" && (prop.value.value || (prop.value.ref && prop.value.ref.value))) {
				if (prop.value.value) {
					prop.value = entity1.entities[findEntityCacheEntity1[prop.value.value]].entityID
				} else {
					prop.value.ref = entity1.entities[findEntityCacheEntity1[prop.value.ref.value]].entityID
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (prop.value[subProp].value || prop.value[subProp].ref.value) {
						if (prop.value[subProp].value) {
							prop.value[subProp] = entity1.entities[findEntityCacheEntity1[prop.value[subProp].value]].entityID
						} else {
							prop.value[subProp].ref = entity1.entities[findEntityCacheEntity1[prop.value[subProp].ref.value]].entityID
						}
					}
				}
			}
		}

		entry.properties = Object.fromEntries(entry.properties.map(a=>{ return [a.name, {type: a.type, value: a.value}] }))

		for (let prop of entry.postInitProperties) {
			if (prop.type == "SEntityTemplateReference" && (prop.value.value || (prop.value.ref && prop.value.ref.value))) {
				if (prop.value.value) {
					prop.value = entity1.entities[findEntityCacheEntity1[prop.value.value]].entityID
				} else {
					prop.value.ref = entity1.entities[findEntityCacheEntity1[prop.value.ref.value]].entityID
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (prop.value[subProp].value || prop.value[subProp].ref.value) {
						if (prop.value[subProp].value) {
							prop.value[subProp] = entity1.entities[findEntityCacheEntity1[prop.value[subProp].value]].entityID
						} else {
							prop.value[subProp].ref = entity1.entities[findEntityCacheEntity1[prop.value[subProp].ref.value]].entityID
						}
					}
				}
			}
		}

		entry.postInitProperties = Object.fromEntries(entry.postInitProperties.map(a=>{ return [a.name, {type: a.type, value: a.value}] }))
	}

	for (let entry of entity2.entities) {
		delete entry.refID

		if (entry.parent.ref.value) {
			entry.parent.ref = entity2.entities[findEntityCacheEntity2[entry.parent.ref.value]].entityID
		}

		if (entry.events)
		for (let pin of entry.events) {
			pin.onEntity = entity2.entities[findEntityCacheEntity2[pin.onEntity.value]].entityID
		}

		if (entry.inputCopying)
		for (let pin of entry.inputCopying) {
			pin.onEntity = entity2.entities[findEntityCacheEntity2[pin.onEntity.value]].entityID
		}

		if (entry.outputCopying)
		for (let pin of entry.outputCopying) {
			pin.onEntity = entity2.entities[findEntityCacheEntity2[pin.onEntity.value]].entityID
		}

		if (entry.exposedInterfaces)
		for (let int of entry.exposedInterfaces) {
			int[1] = entity2.entities[findEntityCacheEntity2[int[1]]].entityID
		}

		if (entry.entitySubsets)
		for (let subset of entry.entitySubsets) {
			for (let subSubset in subset[1].entities) {
				subset[1].entities[subSubset] = entity2.entities[findEntityCacheEntity2[subset[1].entities[subSubset]]].entityID
			}
		}

		if (entry.propertyAliases)
		for (let alias of entry.propertyAliases) {
			alias.entityID = entity2.entities[findEntityCacheEntity2[alias.entityID]].entityID
		}

		for (let prop of entry.properties) {
			if (prop.type == "SEntityTemplateReference" && (prop.value.value || (prop.value.ref && prop.value.ref.value))) {
				if (prop.value.value) {
					prop.value = entity2.entities[findEntityCacheEntity2[prop.value.value]].entityID
				} else {
					prop.value.ref = entity2.entities[findEntityCacheEntity2[prop.value.ref.value]].entityID
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (prop.value[subProp].value || prop.value[subProp].ref.value) {
						if (prop.value[subProp].value) {
							prop.value[subProp] = entity2.entities[findEntityCacheEntity2[prop.value[subProp].value]].entityID
						} else {
							prop.value[subProp].ref = entity2.entities[findEntityCacheEntity2[prop.value[subProp].ref.value]].entityID
						}
					}
				}
			}
		}

		entry.properties = Object.fromEntries(entry.properties.map(a=>{ return [a.name, {type: a.type, value: a.value}] }))

		for (let prop of entry.postInitProperties) {
			if (prop.type == "SEntityTemplateReference" && (prop.value.value || (prop.value.ref && prop.value.ref.value))) {
				if (prop.value.value) {
					prop.value = entity2.entities[findEntityCacheEntity2[prop.value.value]].entityID
				} else {
					prop.value.ref = entity2.entities[findEntityCacheEntity2[prop.value.ref.value]].entityID
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (prop.value[subProp].value || prop.value[subProp].ref.value) {
						if (prop.value[subProp].value) {
							prop.value[subProp] = entity2.entities[findEntityCacheEntity2[prop.value[subProp].value]].entityID
						} else {
							prop.value[subProp].ref = entity2.entities[findEntityCacheEntity2[prop.value[subProp].ref.value]].entityID
						}
					}
				}
			}
		}

		entry.postInitProperties = Object.fromEntries(entry.postInitProperties.map(a=>{ return [a.name, {type: a.type, value: a.value}] }))
	}

	let candidate1 = Object.fromEntries(entity1.entities.map(a => [a.entityID, a]))
	if (entity1.entities.length != Object.keys(candidate1).length) {
		throw new Error("The first QuickEntity JSON contains duplicate entity IDs. A patch JSON cannot be created.")
	}

	let candidate2 = Object.fromEntries(entity2.entities.map(a => [a.entityID, a]))
	if (entity2.entities.length != Object.keys(candidate2).length) {
		throw new Error("The second QuickEntity JSON contains duplicate entity IDs. A patch JSON cannot be created.")
	}

	entity1.entities = candidate1
	entity2.entities = candidate2

	delete entity1.quickEntityVersion
	delete entity2.quickEntityVersion

		let patch = rfc6902.createPatch(entity1, entity2, patchCheckLosslessNumber)

	let outputPatchJSON = {
		tempHash: entity2.tempHash,
    	tbluHash: entity2.tbluHash,
		patch: patch
	}

	let outputPath = automateOutputPath || requireArg("automateOutputPath")
	fs.writeFileSync(outputPath, LosslessJSON.stringify(outputPatchJSON))
}

async function applyPatchJSON(automateQNPath = false, automatePatchPath = false, automateOutputPath = false) {
	let entity = LosslessJSON.parse(String(fs.readFileSync(automateQNPath || requireArg("automateQNPath"))))

	let patch = LosslessJSON.parse(String(fs.readFileSync(automatePatchPath || requireArg("automatePatchPath"))))

	const findEntityCache = {}
	for (var entry in entity.entities) {
		findEntityCache[entity.entities[entry].refID] = Number(entry)
	}

	for (let entry of entity.entities) {
		delete entry.refID

		if (entry.parent.ref.value) {
			entry.parent.ref = entity.entities[findEntityCache[entry.parent.ref.value]].entityID
		}

		if (entry.events)
		for (let pin of entry.events) {
			pin.onEntity = entity.entities[findEntityCache[pin.onEntity.value]].entityID
		}

		if (entry.inputCopying)
		for (let pin of entry.inputCopying) {
			pin.onEntity = entity.entities[findEntityCache[pin.onEntity.value]].entityID
		}

		if (entry.outputCopying)
		for (let pin of entry.outputCopying) {
			pin.onEntity = entity.entities[findEntityCache[pin.onEntity.value]].entityID
		}

		if (entry.exposedInterfaces)
		for (let int of entry.exposedInterfaces) {
			int[1] = entity.entities[findEntityCache[int[1]]].entityID
		}

		if (entry.entitySubsets)
		for (let subset of entry.entitySubsets) {
			for (let subSubset in subset[1].entities) {
				subset[1].entities[subSubset] = entity.entities[findEntityCache[subset[1].entities[subSubset]]].entityID
			}
		}

		if (entry.propertyAliases)
		for (let alias of entry.propertyAliases) {
			alias.entityID = entity.entities[findEntityCache[alias.entityID]].entityID
		}

		for (let prop of entry.properties) {
			if (prop.type == "SEntityTemplateReference" && (prop.value.value || (prop.value.ref && prop.value.ref.value))) {
				if (prop.value.value) {
					prop.value = entity.entities[findEntityCache[prop.value.value]].entityID
				} else {
					prop.value.ref = entity.entities[findEntityCache[prop.value.ref.value]].entityID
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (prop.value[subProp].value || prop.value[subProp].ref.value) {
						if (prop.value[subProp].value) {
							prop.value[subProp] = entity.entities[findEntityCache[prop.value[subProp].value]].entityID
						} else {
							prop.value[subProp].ref = entity.entities[findEntityCache[prop.value[subProp].ref.value]].entityID
						}
					}
				}
			}
		}

		entry.properties = Object.fromEntries(entry.properties.map(a=>{ return [a.name, {type: a.type, value: a.value}] }))

		for (let prop of entry.postInitProperties) {
			if (prop.type == "SEntityTemplateReference" && (prop.value.value || (prop.value.ref && prop.value.ref.value))) {
				if (prop.value.value) {
					prop.value = entity.entities[findEntityCache[prop.value.value]].entityID
				} else {
					prop.value.ref = entity.entities[findEntityCache[prop.value.ref.value]].entityID
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (prop.value[subProp].value || prop.value[subProp].ref.value) {
						if (prop.value[subProp].value) {
							prop.value[subProp] = entity.entities[findEntityCache[prop.value[subProp].value]].entityID
						} else {
							prop.value[subProp].ref = entity.entities[findEntityCache[prop.value[subProp].ref.value]].entityID
						}
					}
				}
			}
		}

		entry.postInitProperties = Object.fromEntries(entry.postInitProperties.map(a=>{ return [a.name, {type: a.type, value: a.value}] }))
	}

	let candidate = Object.fromEntries(entity.entities.map(a => [a.entityID, a]))
	if (entity.entities.length != Object.keys(candidate).length) {
		throw new Error("The QuickEntity JSON contains duplicate entity IDs. A patch JSON cannot be applied.")
	}

	entity.entities = candidate

		rfc6902.applyPatch(entity, patch.patch)
	
	let newEntity = LosslessJSON.parse(LosslessJSON.stringify(entity))
	newEntity.entities = []

	var index = 0
	for (let entry of Object.entries(entity.entities)) {
		newEntity.entities.push(entry[1])
		newEntity.entities[index].entityID = entry[0]
		
		index++
	}

	const newFindEntityCache = {}

	for (let entry in newEntity.entities) {
		newEntity.entities[entry].refID = new LosslessJSON.LosslessNumber(entry)
		newFindEntityCache[newEntity.entities[entry].entityID] = entry
	}

	for (let entry of newEntity.entities) {
		if (!entry.parent.ref.startsWith("SPECIAL")) {
			entry.parent.ref = new LosslessJSON.LosslessNumber(newFindEntityCache[entry.parent.ref])
		}

		if (entry.events)
		for (let pin of entry.events) {
			pin.onEntity = new LosslessJSON.LosslessNumber(newFindEntityCache[pin.onEntity])
		}

		if (entry.inputCopying)
		for (let pin of entry.inputCopying) {
			pin.onEntity = new LosslessJSON.LosslessNumber(newFindEntityCache[pin.onEntity])
		}

		if (entry.outputCopying)
		for (let pin of entry.outputCopying) {
			pin.onEntity = new LosslessJSON.LosslessNumber(newFindEntityCache[pin.onEntity])
		}

		if (entry.exposedInterfaces)
		for (let int of entry.exposedInterfaces) {
			int[1] = new LosslessJSON.LosslessNumber(newFindEntityCache[int[1]])
		}

		if (entry.entitySubsets)
		for (let subset of entry.entitySubsets) {
			for (let subSubset in subset[1].entities) {
				subset[1].entities[subSubset] = new LosslessJSON.LosslessNumber(newFindEntityCache[subset[1].entities[subSubset]])
			}
		}

		if (entry.propertyAliases)
		for (let alias of entry.propertyAliases) {
			alias.entityID = new LosslessJSON.LosslessNumber(newFindEntityCache[alias.entityID])
		}

		entry.properties = Object.entries(entry.properties).map(a=>{ return {name: a[0], type: a[1].type, value: a[1].value} })

		for (let prop of entry.properties) {
			if (prop.type == "SEntityTemplateReference") {
				if (typeof prop.value == "string" && !prop.value.startsWith("SPECIAL")) {
					prop.value = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value])
				} else if (typeof prop.value != "string" && !prop.value.ref.startsWith("SPECIAL")) {
					prop.value.ref = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value.ref])
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (typeof prop.value[subProp] == "string" && !prop.value[subProp].startsWith("SPECIAL")) {
						prop.value[subProp] = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value[subProp]])
					} else if (typeof !prop.value[subProp] != "string" && !prop.value[subProp].ref.startsWith("SPECIAL")) {
						prop.value[subProp].ref = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value[subProp].ref])
					}
				}
			}
		}

		entry.postInitProperties = Object.entries(entry.postInitProperties).map(a=>{ return {name: a[0], type: a[1].type, value: a[1].value} })

		for (let prop of entry.postInitProperties) {
			if (prop.type == "SEntityTemplateReference") {
				if (typeof prop.value == "string" && !prop.value.startsWith("SPECIAL")) {
					prop.value = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value])
				} else if (typeof prop.value != "string" && !prop.value.ref.startsWith("SPECIAL")) {
					prop.value.ref = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value.ref])
				}
			} else if (prop.type == "TArray<SEntityTemplateReference>") {
				for (let subProp in prop.value) {
					if (typeof prop.value[subProp] == "string" && !prop.value[subProp].startsWith("SPECIAL")) {
						prop.value[subProp] = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value[subProp]])
					} else if (typeof !prop.value[subProp] != "string" && !prop.value[subProp].ref.startsWith("SPECIAL")) {
						prop.value[subProp].ref = new LosslessJSON.LosslessNumber(newFindEntityCache[prop.value[subProp].ref])
					}
				}
			}
		}
	}

	let outputPath = automateOutputPath || requireArg("automateOutputPath")
	fs.writeFileSync(outputPath, LosslessJSON.stringify(newEntity).replace(/"LN\|((?:[0-9]|\.|-|e)*)"/g, (a,b) => new LosslessJSON.LosslessNumber(b).value))
}

export { convert, generate, createPatchJSON, applyPatchJSON }