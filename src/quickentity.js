/** @typedef {Object} TEMP
* @property {Number} blueprintIndexInResourceHeader
* @property {Array} externalSceneTypeIndicesInResourceHeader
* @property {Array} propertyOverrides
* @property {Number} rootEntityIndex
* @property {Array} [subEntities]
* @property {Array} [entityTemplates]
* @property {Number} subType
*/

/** @typedef {Object} TBLU
* @property {Array} externalSceneTypeIndicesInResourceHeader
* @property {Array} inputPinForwardings
* @property {Array} outputPinForwardings
* @property {Array} overrideDeletes
* @property {Array} [pinConnectionOverrideDeletes]
* @property {Array} [pinConnectionOverrides]
* @property {Array} pinConnections
* @property {Number} rootEntityIndex
* @property {Array} [subEntities]
* @property {Array} [entityTemplates]
* @property {Number} subType
*/

/** @typedef {Object} HashMeta
* @property {Number} hash_offset
* @property {Array} hash_reference_data
* @property {Number} hash_reference_table_dummy
* @property {Number} hash_reference_table_size
* @property {String} hash_resource_type
* @property {Number} hash_size
* @property {Number} hash_size_final
* @property {Number} hash_size_in_memory
* @property {Number} hash_size_in_video_memory
* @property {String} hash_value
*/

/** @typedef {object} Entity
 * @property {string} tempHash
 * @property {string} tbluHash
 * @property {string} rootEntity
 * @property {Object.<string, SubEntity>} entities
 * @property {string[]} externalScenes
 * @property {object[]} propertyOverrides
 * @property {object[]} overrideDeletes
 * @property {object[]} pinConnectionOverrides
 * @property {object[]} pinConnectionOverrideDeletes
 * @property {number} subType
 * @property {number} quickEntityVersion
 */

/** @typedef {object} SubEntity
 * @property {string} [type]

 * @property {object} parent

 * @property {string} name
 * @property {string} template
 * @property {string} [templateFlag]
 * @property {string} blueprint
 * @property {boolean} editorOnly
 * @property {object[]} platformSpecificPropertyValues
 * @property {array[]|string[]|object[]} entitySubsets

 * @property {Object.<string, { type: string; value: any; }>} properties
 * @property {object[]} [propertyValues]

 * @property {Object.<string, { type: string; value: any; }>} postInitProperties
 * @property {object[]} [postInitPropertyValues]

 * @property {object[]} propertyAliases

 * @property {object[]} [events]
 * @property {string} events.onEvent
 * @property {string} events.shouldTrigger
 * @property {string} events.onEntity
 * @property {object} [events.value]

 * @property {object[]} [inputCopying]
 * @property {string} inputCopying.whenTriggered
 * @property {string} inputCopying.alsoTrigger
 * @property {string} inputCopying.onEntity
 * @property {object} [inputCopying.value]

 * @property {object[]} [outputCopying]
 * @property {string} outputCopying.onEvent
 * @property {string} outputCopying.propagateEvent
 * @property {string} outputCopying.onEntity
 * @property {object} [outputCopying.value]

 * @property {object} exposedEntities
 * @property {object} exposedInterfaces
*/

/**
 * @param {string} name
 * @returns {never}
 */
function requireArg(name) {
	throw new Error(`Missing required argument: ${name}`)
}

const fs = require('fs')
const path = require("path")
const LosslessJSON = require('lossless-json')
const Decimal = require('decimal.js').Decimal
const rfc6902 = require('rfc6902')
const deepEqual = require('lodash.isequal')
const deepMerge = require('lodash.merge')

var THREE = require("three")

const QuickEntityVersion = 2.1

// oi sieni shut up yeah?
// you've got ur select box
// - Atampy26

/**
 * @param {{ exposedEntity: string | any[]; externalSceneIndex: LosslessJSON.LosslessNumber; entityIndex: LosslessJSON.LosslessNumber; entityID: { value: LosslessJSON.LosslessNumber; }; }} reference
 * @param {TEMP} TEMP
 * @param {TBLU} TBLU
 * @param {HashMeta} TEMPmeta
 */
function convertReferenceToQuickEntity(reference, TEMP, TBLU, TEMPmeta) {
	return (reference.exposedEntity.length || reference.externalSceneIndex.value != "-1") ?	{
		"ref": reference.entityIndex.value == "-2" ? new Decimal(reference.entityID.value).toHex().substring(2) : reference.entityIndex.value == "-1" ? null : new Decimal(TBLU.subEntities[Number(reference.entityIndex.value)].entityId.value).toHex().substring(2),
		"externalScene": reference.externalSceneIndex.value == "-1" ? null : TEMPmeta.hash_reference_data[TEMP.externalSceneTypeIndicesInResourceHeader[Number(reference.externalSceneIndex)]].hash,
		"exposedEntity": reference.exposedEntity === "" ? undefined : reference.exposedEntity
	} : reference.entityIndex.value == "-1" ? null : new Decimal(TBLU.subEntities[Number(reference.entityIndex)].entityId.value).toHex().substring(2)
}

/**
 * @param {{ ref: string | null; externalScene: string | null; exposedEntity: string | undefined } | string | null} reference
 * @param {TEMP} TEMP
 * @param {HashMeta} TEMPmeta
 * @param {{}} findEntityCache
 */
function convertReferenceToRT(reference, TEMP, TEMPmeta, findEntityCache) {
	return reference && Object.prototype.hasOwnProperty.call(reference, 'ref') ? {
		"entityID": reference.externalScene ? new LosslessJSON.LosslessNumber(new Decimal("0x" + reference.ref).toFixed()) : new LosslessJSON.LosslessNumber("18446744073709551615"),
		"externalSceneIndex": reference.externalScene ? TEMP.externalSceneTypeIndicesInResourceHeader.findIndex(a => TEMPmeta.hash_reference_data[a].hash == reference.externalScene) : new LosslessJSON.LosslessNumber("-1"),
		"entityIndex": reference.externalScene ? new LosslessJSON.LosslessNumber("-2") : findEntity(findEntityCache, reference.ref),
		"exposedEntity": reference.exposedEntity || ""
	} : {
		"entityID": new LosslessJSON.LosslessNumber("18446744073709551615"),
		"externalSceneIndex": -1,
		"entityIndex": findEntity(findEntityCache, reference),
		"exposedEntity": ""
	}
}

/**
 * @param {{ nPropertyID?: string|number; value: any; }} property
 * @param {TEMP} TEMP
 * @param {TBLU} TBLU
 * @param {HashMeta} TEMPmeta
 * @param {HashMeta} TBLUmeta
 * @param {Entity} entity
 * @param {{ name: string; }} entry
 */
async function parseProperty(property, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry) {
	if (property.value["$type"].startsWith("TArray<")) {
		for (var prop in property.value["$val"]) {
			var usedProp = {}
			usedProp.nPropertyID = ""
			usedProp.value = {
				"$type": property.value["$type"].slice(7, -1),
				"$val": property.value["$val"][prop]
			}

			parseProperty(usedProp, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)

			property.value["$val"][prop] = usedProp.value["$val"]
		}

		return
	}

	if (property.value) {
		switch (property.value["$type"]) {
			case "SEntityTemplateReference":
				try {
					property.value["$val"] = convertReferenceToQuickEntity(property.value["$val"], TEMP, TBLU, TEMPmeta)
				} catch (e) {
					console.log("Error in custom property parse (SEntityTemplateReference type) for " + entry.name + ": " + e)
				}
				break;

			case "ZRuntimeResourceID":
				try {
					if (property.value["$val"]["m_IDLow"] == 4294967295 && property.value["$val"]["m_IDHigh"] == 4294967295) {
						property.value["$val"] = null
					} else {
						if (TEMPmeta["hash_reference_data"][property.value["$val"]["m_IDLow"]].flag != "1F") {
							property.value["$val"] = {
								resource: TEMPmeta["hash_reference_data"][property.value["$val"]["m_IDLow"]].hash,
								flag: TEMPmeta["hash_reference_data"][property.value["$val"]["m_IDLow"]].flag
							}
						} else {
							property.value["$val"] = TEMPmeta["hash_reference_data"][property.value["$val"]["m_IDLow"]].hash
						}
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

/**
 * @param {[name: string|number, value: { type: any; value: any; }]} property
 * @param {string} propertyValues
 * @param {TEMP} TEMP
 * @param {TBLU} TBLU
 * @param {HashMeta} TEMPmeta
 * @param {HashMeta} TBLUmeta
 * @param {Entity} entity
 * @param {any} entry
 * @param {{}} findEntityCache
 * @returns {Promise<{nPropertyID: string|number; value: { $type: string; $val: any }}>}
 */
async function rebuildSpecificProp(property, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, findEntityCache) {
	switch (property[1].type) {
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
				"nPropertyID": property[0],
				"value": {
					"$type": "SColorRGB",
					"$val": {
						"r": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(0,2), 16) / 255).toString()),
						"g": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(2,4), 16) / 255).toString()),
						"b": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(4,6), 16) / 255).toString())
					}
				}
			}
			break
		case "SColorRGBA":
			return {
				"nPropertyID": property[0],
				"value": {
					"$type": "SColorRGBA",
					"$val": {
						"r": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(0,2), 16) / 255).toString()),
						"g": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(2,4), 16) / 255).toString()),
						"b": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(4,6), 16) / 255).toString()),
						"a": new LosslessJSON.LosslessNumber((parseInt(property[1].value.substring(1).slice(6,8), 16) / 255).toString())
					}
				}
			}
			break
		case "ZGuid":
			return {
				"nPropertyID": property[0],
				"value": {
					"$type": "ZGuid",
					"$val": {
						"_a": parseInt(property[1].value.split("-")[0], 16),
						"_b": parseInt(property[1].value.split("-")[1], 16),
						"_c": parseInt(property[1].value.split("-")[2], 16),
						"_d": parseInt(property[1].value.split("-")[3].slice(0,2), 16),
						"_e": parseInt(property[1].value.split("-")[3].slice(2,4), 16),
						"_f": parseInt(property[1].value.split("-")[4].slice(0,2), 16),
						"_g": parseInt(property[1].value.split("-")[4].slice(2,4), 16),
						"_h": parseInt(property[1].value.split("-")[4].slice(4,6), 16),
						"_i": parseInt(property[1].value.split("-")[4].slice(6,8), 16),
						"_j": parseInt(property[1].value.split("-")[4].slice(8,10), 16),
						"_k": parseInt(property[1].value.split("-")[4].slice(10,12), 16)
					}
				}
			}
			break
		case "SMatrix43":
			var matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(new Decimal(property[1].value.rotation.x.value).times(THREE.Math.DEG2RAD), new Decimal(property[1].value.rotation.y.value).times(THREE.Math.DEG2RAD), new Decimal(property[1].value.rotation.z.value).times(THREE.Math.DEG2RAD), "XYZ"))

			return {
				"nPropertyID": property[0],
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
							"x": property[1].value.position.x,
							"y": property[1].value.position.y,
							"z": property[1].value.position.z
						}
					}
				}
			}
			break
		case "SEntityTemplateReference":
			return {
				"nPropertyID": property[0],
				"value": {
					"$type": property[1].type,
					"$val": convertReferenceToRT(property[1].value, TEMP, TEMPmeta, findEntityCache)
				}
			}
			break
		case "ZRuntimeResourceID":
			if (property[1].value === null) {
				return {
					"nPropertyID": property[0],
					"value": {
						"$type": property[1].type,
						"$val": {
							"m_IDHigh": 4294967295,
							"m_IDLow": 4294967295
						}
					}
				}

				break
			}

			if (!TEMPmeta.hash_reference_data.some(a => a.hash == (property[1].value.flag ? property[1].value.resource : property[1].value))) {
				TEMPmeta.hash_reference_data.push({
					"hash": property[1].value.flag ? property[1].value.resource : property[1].value,
					"flag": property[1].value.flag ? property[1].value.flag : "1F"
				})
			}

			return {
				"nPropertyID": property[0],
				"value": {
					"$type": property[1].type,
					"$val": {
						"m_IDHigh": 0,
						"m_IDLow": TEMPmeta["hash_reference_data"].findIndex(a => a.hash == (property[1].value.flag ? property[1].value.resource : property[1].value))
					}
				}
			}
			break
		default:
			return {
				"nPropertyID": property[0],
				"value": property[1].type ? {
					"$type": property[1].type,
					"$val": property[1].value
				} : undefined
			}
			break
	}
}

/**
 * @param {[name: string|number, value: { type: string; value: any; }]} property
 * @param {string} propertyValues
 * @param {TEMP} TEMP
 * @param {TBLU} TBLU
 * @param {HashMeta} TEMPmeta
 * @param {HashMeta} TBLUmeta
 * @param {Entity} entity
 * @param {any} entry
 * @param {number} index
 * @param {{}} findEntityCache
 */
async function rebuildProperty(property, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, index, findEntityCache, isOverrides = false) {
	if (property[1].type.startsWith("TArray<")) {
		var propertyToAdd = {
			"nPropertyID": property[0],
			"value": property[1].type ? {
				"$type": property[1].type,
				"$val": property[1].value
			} : undefined
		}

		for (var prop in propertyToAdd.value["$val"]) {
			var usedProp = []
			usedProp.push("")
			usedProp.push({
				type: property[1].type.slice(7, -1),
				value: propertyToAdd.value["$val"][prop]
			})

			// @ts-ignore
			propertyToAdd.value["$val"][prop] = (await rebuildSpecificProp(usedProp, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, findEntityCache)).value["$val"]
		}

		if (isOverrides) {
			TEMP["propertyOverrides"][index][propertyValues] = propertyToAdd
		} else {
			TEMP.subEntities[index][propertyValues].push(propertyToAdd)
		}

		return
	}

	var propertyToAdd = await rebuildSpecificProp(property, propertyValues, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, findEntityCache)

	// @ts-ignore
	if (!isNaN(parseInt(propertyToAdd.nPropertyID)) && (parseInt(propertyToAdd.nPropertyID).toString(16).length == 8 || parseInt(propertyToAdd.nPropertyID).toString(16).length == 7)) { // Property is a number and a CRC32
		// @ts-ignore
		propertyToAdd.nPropertyID = parseInt(propertyToAdd.nPropertyID)
	}

	if (isOverrides) {
		TEMP["propertyOverrides"][index][propertyValues] = propertyToAdd
	} else {
		TEMP.subEntities[index][propertyValues].push(propertyToAdd)
	}
}

async function convert(automateGame = false, automateTempPath = false, automateTempMetaPath = false, automateTbluPath = false, automateTbluMetaPath = false, automateQNPath = false) {

const tempPath = automateTempPath || requireArg("automateTempPath")

/** @type {TEMP} */
const TEMP = LosslessJSON.parse(String(fs.readFileSync(tempPath)))

/** @type {HashMeta} */
const TEMPmeta = LosslessJSON.parse(String(fs.readFileSync(automateTempMetaPath || requireArg("automateTempMetaPath"))))

const tbluPath = automateTbluPath || requireArg("automateTbluPath")

/** @type {TBLU} */
const TBLU = LosslessJSON.parse(String(fs.readFileSync(tbluPath)))

/** @type {HashMeta} */
const TBLUmeta = LosslessJSON.parse(String(fs.readFileSync(automateTbluMetaPath || requireArg("automateTbluMetaPath"))))

const game = automateGame || requireArg("automateGame")

if (game === "HM2016") {
	TEMP.subEntities = TEMP.entityTemplates
	delete TEMP.entityTemplates

	TBLU.subEntities = TBLU.entityTemplates
	delete TBLU.entityTemplates
}

if (new Set(TBLU.subEntities.map(a=>a.entityId.value)).size != TBLU.subEntities.map(a=>a.entityId.value).length) {
	throw new Error("The entity you're converting contains duplicate entity IDs - QuickEntity can't convert it.")
}

/** @type {Entity} */
var entity =  {
	"tempHash": path.basename(tempPath).slice(0, -10),
	"tbluHash": path.basename(tbluPath).slice(0, -10),
	"rootEntity": new Decimal(TBLU.subEntities[TEMP.rootEntityIndex].entityId.value).toHex().substring(2),
	"entities": {},
	"propertyOverrides": TEMP.propertyOverrides,
	"overrideDeletes": TBLU.overrideDeletes,
	"pinConnectionOverrides": TBLU.pinConnectionOverrides,
	"pinConnectionOverrideDeletes": TBLU.pinConnectionOverrideDeletes,
	"externalScenes": [],
	"subType": TEMP.subType,
	"quickEntityVersion": QuickEntityVersion
}

let index = 0
for (var entry of TEMP.subEntities) {
	try {
		for (let subset of TBLU.subEntities[index].entitySubsets) {
			for (let subSubset in subset[1].entities) {
				subset[1].entities[subSubset] = new Decimal(TBLU.subEntities[subset[1].entities[subSubset]].entityId.value).toHex().substring(2)
			}
		}
	} catch (e) {
		console.log("Error deindexing entitySubsets for entity " + index + ": " + e)
	}

	entity.entities[new Decimal(TBLU.subEntities[index].entityId.value).toHex().substring(2)] = {
		"parent": convertReferenceToQuickEntity(entry.logicalParent, TEMP, TBLU, TEMPmeta),
		"name": TBLU.subEntities[index].entityName,
		"template": TEMPmeta["hash_reference_data"][entry.entityTypeResourceIndex].hash,
		"templateFlag": TEMPmeta["hash_reference_data"][entry.entityTypeResourceIndex].flag != "1F" ? TEMPmeta["hash_reference_data"][entry.entityTypeResourceIndex].flag : undefined,
		"blueprint": TBLUmeta["hash_reference_data"][TBLU.subEntities[index].entityTypeResourceIndex].hash,
		"properties": {},
		"postInitProperties": {},
		"editorOnly": TBLU.subEntities[index].editorOnly,
		"propertyValues": entry.propertyValues,
		"postInitPropertyValues": entry.postInitPropertyValues,
		"platformSpecificPropertyValues": entry.platformSpecificPropertyValues ? entry.platformSpecificPropertyValues : [],
		"propertyAliases": TBLU.subEntities[index].propertyAliases.map(a=>{return {
            "exposeProperty": a.sAliasName,
            "onEntity": new Decimal(TBLU.subEntities[a.entityID].entityId.value).toHex().substring(2),
            "asProperty": a.sPropertyName
        }}),
		"exposedEntities": TBLU.subEntities[index].exposedEntities.map(a=>{ return {
            "name": a.sName,
            "isArray": a.bIsArray,
            "targets": a.aTargets.map(b=>convertReferenceToQuickEntity(b, TEMP, TBLU, TEMPmeta))
        }}),
		"exposedInterfaces": TBLU.subEntities[index].exposedInterfaces.map(a=>[a[0], new Decimal(TBLU.subEntities[a[1]].entityId.value).toHex().substring(2)]),
		"entitySubsets": TBLU.subEntities[index].entitySubsets
	}

	index ++
}

for (let entry of Object.values(entity.entities)) {
	var propertyValues = LosslessJSON.parse(LosslessJSON.stringify(entry.propertyValues))
	for (var property of propertyValues) {
		await parseProperty(property, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)
	}

	entry.properties = {}
	for (var property of propertyValues) {
		entry.properties[property.nPropertyID] = {
			type: property.value ? property.value["$type"] : undefined,
			value: property.value ? property.value["$val"] : undefined
		}
	}

	delete entry.propertyValues
}

for (let entry of Object.values(entity.entities)) {
	var postInitPropertyValues = LosslessJSON.parse(LosslessJSON.stringify(entry.postInitPropertyValues))
	for (var property of postInitPropertyValues) {
		await parseProperty(property, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)
	}

	entry.postInitProperties = {}
	for (var property of postInitPropertyValues) {
		entry.postInitProperties[property.nPropertyID] = {
			type: property.value ? property.value["$type"] : undefined,
			value: property.value ? property.value["$val"] : undefined
		}
	}

	delete entry.postInitPropertyValues
}

for (let entry of Object.values(entity.entities)) {
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
	if (!entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].events) {
		entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].events = []
	}

	entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].events.push({
		onEvent: pin.fromPinName,
		shouldTrigger: pin.toPinName,
		onEntity: new Decimal(TBLU.subEntities[pin.toID].entityId.value).toHex().substring(2),
		value: pin.constantPinValue ? (pin.constantPinValue["$type"] == "void" ? undefined : {
			type: pin.constantPinValue["$type"],
			value: pin.constantPinValue["$val"],
		}) : undefined
	})
}

for (var pin of TBLU.inputPinForwardings) {
	if (!entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].inputCopying) {
		entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].inputCopying = []
	}

	entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].inputCopying.push({
		whenTriggered: pin.fromPinName,
		alsoTrigger: pin.toPinName,
		onEntity: new Decimal(TBLU.subEntities[pin.toID].entityId.value).toHex().substring(2),
		value: pin.constantPinValue ? (pin.constantPinValue["$type"] == "void" ? undefined : {
			type: pin.constantPinValue["$type"],
			value: pin.constantPinValue["$val"],
		}) : undefined
	})
}

for (var pin of TBLU.outputPinForwardings) {
	if (!entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].outputCopying) {
		entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].outputCopying = []
	}

	entity.entities[new Decimal(TBLU.subEntities[pin.fromID].entityId.value).toHex().substring(2)].outputCopying.push({
		onEvent: pin.fromPinName,
		propagateEvent: pin.toPinName,
		onEntity: new Decimal(TBLU.subEntities[pin.toID].entityId.value).toHex().substring(2),
		value: pin.constantPinValue ? (pin.constantPinValue["$type"] == "void" ? undefined : {
			type: pin.constantPinValue["$type"],
			value: pin.constantPinValue["$val"],
		}) : undefined
	})
}

for (var entry of entity.propertyOverrides) {
	entry.entities = [convertReferenceToQuickEntity(entry.propertyOwner, TEMP, TBLU, TEMPmeta)]
	delete entry.propertyOwner

	await parseProperty(entry.propertyValue, TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry)

	entry.properties = {}
	entry.properties[entry.propertyValue.nPropertyID] = {
		type: entry.propertyValue.value ? entry.propertyValue.value["$type"] : undefined,
		value: entry.propertyValue.value ? entry.propertyValue.value["$val"] : undefined
	}
	delete entry.propertyValue
}

let propOverridesTemp = [] // Collect properties
for (var entry of entity.propertyOverrides) {
	if (propOverridesTemp.some(a=>deepEqual(entry.entities, a.entities))) {
		deepMerge(propOverridesTemp.find(a=>deepEqual(entry.entities, a.entities)).properties, entry.properties)
	} else {
		propOverridesTemp.push(entry)
	}
}

let propOverridesTemp2 = [] // Collect entities
for (var entry of propOverridesTemp) {
	if (propOverridesTemp2.some(a=>deepEqual(entry.properties, a.properties))) {
		propOverridesTemp2.find(a=>deepEqual(entry.properties, a.properties)).entities.push(...entry.entities)
	} else {
		propOverridesTemp2.push(entry)
	}
}

entity.propertyOverrides = LosslessJSON.parse(LosslessJSON.stringify(propOverridesTemp2))

for (let entry in entity.overrideDeletes) {
	entity.overrideDeletes[entry] = convertReferenceToQuickEntity(entity.overrideDeletes[entry], TEMP, TBLU, TEMPmeta)
}

if (game !== "HM2016") {
	for (var entry of entity.pinConnectionOverrides) {
		entry.fromEntity = convertReferenceToQuickEntity(entry.fromEntity, TEMP, TBLU, TEMPmeta)
		entry.toEntity = convertReferenceToQuickEntity(entry.toEntity, TEMP, TBLU, TEMPmeta)
	}

	for (var entry of entity.pinConnectionOverrideDeletes) {
		entry.fromEntity = convertReferenceToQuickEntity(entry.fromEntity, TEMP, TBLU, TEMPmeta)
		entry.toEntity = convertReferenceToQuickEntity(entry.toEntity, TEMP, TBLU, TEMPmeta)
	}
} else {
	entity.pinConnectionOverrides = []
	entity.pinConnectionOverrideDeletes = []
}

fs.writeFileSync(automateQNPath || requireArg("automateQNPath"), LosslessJSON.stringify(entity))
}

function findEntity(cache, ref) {
	return ref === null ? -1 : Object.prototype.hasOwnProperty.call(cache, ref) ? cache[ref] : -1
}

async function generate(automateGame = false, automateQNPath = false, automateTempPath = false, automateTempMetaPath = false, automateTbluPath = false, automateTbluMetaPath = false) {

const game = automateGame || requireArg("automateGame")

/** @type {Entity} */
const entity = LosslessJSON.parse(String(fs.readFileSync(automateQNPath || requireArg("automateQNPath"))))

entity.entities = Object.fromEntries(Object.entries(entity.entities).filter(a=>a[1].type != "comment"))


const findEntityCache = {}
let index = 0
for (let entry of Object.keys(entity.entities)) {
	findEntityCache[entry] = index
	index ++
}


/** @type {TEMP} */
var TEMP = {
	"subType": entity.subType,
	"blueprintIndexInResourceHeader": 0,
	"rootEntityIndex": findEntity(findEntityCache, entity.rootEntity),
	"subEntities": [],
	"propertyOverrides": entity.propertyOverrides,
	"externalSceneTypeIndicesInResourceHeader": []
}

/** @type {HashMeta} */
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

/** @type {TBLU} */
var TBLU = {
	"subType": entity.subType,
	"rootEntityIndex": findEntity(findEntityCache, entity.rootEntity),
	"subEntities": [],
	"externalSceneTypeIndicesInResourceHeader": [],
	"overrideDeletes": entity.overrideDeletes,
	"pinConnectionOverrides": game !== "HM2016" ? entity.pinConnectionOverrides : undefined,
	"pinConnectionOverrideDeletes": game !== "HM2016" ? entity.pinConnectionOverrideDeletes : undefined,
	"pinConnections": [],
	"inputPinForwardings": [],
	"outputPinForwardings": []
}

/** @type {HashMeta} */
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

for (let entry of Object.values(entity.entities)) {
	if (!soFarUsedTEMP.has(entry.template)) {
		TEMPmeta.hash_reference_data.push({
			"hash": entry.template,
			"flag": entry.templateFlag || "1F"
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

let soFarUsedTEMPArray = [...soFarUsedTEMP]
let soFarUsedTBLUArray = [...soFarUsedTBLU]

for (let entry of Object.entries(entity.entities)) {
	TEMP.subEntities.push({
		"logicalParent": convertReferenceToRT(entry[1].parent, TEMP, TEMPmeta, findEntityCache),
		"entityTypeResourceIndex": soFarUsedTEMPArray.indexOf(entry[1].template) + tempInitialIndex,
		"propertyValues": [],
		"postInitPropertyValues": [],
		"platformSpecificPropertyValues": entry[1].platformSpecificPropertyValues ? entry[1].platformSpecificPropertyValues : []
	})

	TBLU.subEntities.push({
		"logicalParent": convertReferenceToRT(entry[1].parent, TEMP, TEMPmeta, findEntityCache),
		"entityTypeResourceIndex": soFarUsedTBLUArray.indexOf(entry[1].blueprint) + tbluInitialIndex,
		"entityId": new LosslessJSON.LosslessNumber(new Decimal("0x" + entry[0]).toFixed()),
		"editorOnly": entry[1].editorOnly ? true : false,
		"entityName": entry[1].name,
		"propertyAliases": entry[1].propertyAliases ? entry[1].propertyAliases.map(a=>{return {
            "sAliasName": a.exposeProperty,
            "entityID": findEntity(findEntityCache, a.onEntity),
            "sPropertyName": a.asProperty
        }}) : [],
		"exposedEntities": entry[1].exposedEntities ? entry[1].exposedEntities.map(a=>{ return {
            "sName": a.name,
            "bIsArray": a.isArray,
            "aTargets": a.targets.map(b=>convertReferenceToRT(b, TEMP, TEMPmeta, findEntityCache))
        }}) : [],
		"exposedInterfaces": entry[1].exposedInterfaces ? entry[1].exposedInterfaces.map(a=>[a[0], findEntity(findEntityCache, a[1])]) : [],
		"entitySubsets": entry[1].entitySubsets || []
	})
}


/*
	REINDEX: entitySubsets
*/

index = 0
for (let entry of Object.values(entity.entities)) {
	if (entry.entitySubsets) {
		for (var subset of entry.entitySubsets) {
			for (var item in subset[1]["entities"]) {
				subset[1]["entities"][item] = findEntity(findEntityCache, subset[1]["entities"][item])
			}
		}
	}

	index ++
}


/*
	GENERATE: propertyValues, postInitPropertyValues
*/

index = 0
for (let entry of Object.values(entity.entities)) {
	for (let property of Object.entries(entry.properties)) {
		await rebuildProperty(property, "propertyValues", TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, index, findEntityCache)
	}

	for (let property of Object.entries(entry.postInitProperties)) {
		await rebuildProperty(property, "postInitPropertyValues", TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, index, findEntityCache)
	}
	index ++
}


/*
	REBUILD: overrides
*/

index = 0
let propOvers = TEMP.propertyOverrides
TEMP.propertyOverrides = []
for (let override of propOvers) {
    for (let overridenEntity of override.entities) {
        for (let overridenProperty of Object.entries(override.properties)) {
            TEMP.propertyOverrides.push({
                propertyOwner: convertReferenceToRT(overridenEntity, TEMP, TEMPmeta, findEntityCache)
            })
			await rebuildProperty(overridenProperty, "propertyValue", TEMP, TBLU, TEMPmeta, TBLUmeta, entity, entry, index, findEntityCache, true)
			index++
        }
    }
}

for (let entry in TBLU.overrideDeletes) {
	TBLU.overrideDeletes[entry] = convertReferenceToRT(TBLU.overrideDeletes[entry], TEMP, TEMPmeta, findEntityCache)
}


if (game !== "HM2016") {
	for (var entry of TBLU.pinConnectionOverrides) {
		entry.fromEntity = convertReferenceToRT(entry.fromEntity, TEMP, TEMPmeta, findEntityCache)
		entry.toEntity = convertReferenceToRT(entry.toEntity, TEMP, TEMPmeta, findEntityCache)
	}

	for (var entry of TBLU.pinConnectionOverrideDeletes) {
		entry.fromEntity = convertReferenceToRT(entry.fromEntity, TEMP, TEMPmeta, findEntityCache)
		entry.toEntity = convertReferenceToRT(entry.toEntity, TEMP, TEMPmeta, findEntityCache)
	}
}


/*
	ADD: pins
*/

index = 0
for (let entry of Object.values(entity.entities)) {
	if (entry.events) {
		for (let pin of entry.events) {
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
		for (let pin of entry.inputCopying) {
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
		for (let pin of entry.outputCopying) {
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

	delete entity1.quickEntityVersion
	delete entity2.quickEntityVersion

		// @ts-ignore
	let patch = rfc6902.createPatch(entity1, entity2, patchCheckLosslessNumber)
	
	let outputPatchJSON = {
		tempHash: entity2.tempHash,
    	tbluHash: entity2.tbluHash,
		patch: patch,
		patchVersion: 4
	}

	let outputPath = automateOutputPath || requireArg("automateOutputPath")
	fs.writeFileSync(outputPath, LosslessJSON.stringify(outputPatchJSON))
}

async function applyPatchJSON(automateQNPath = false, automatePatchPath = false, automateOutputPath = false) {
	let entity = LosslessJSON.parse(String(fs.readFileSync(automateQNPath || requireArg("automateQNPath"))))

	let patch = LosslessJSON.parse(String(fs.readFileSync(automatePatchPath || requireArg("automatePatchPath"))))

		rfc6902.applyPatch(entity, patch.patch)

	let outputPath = automateOutputPath || requireArg("automateOutputPath")
	fs.writeFileSync(outputPath, LosslessJSON.stringify(entity).replace(/"LN\|((?:[0-9]|\.|-|e)*)"/g, (a,b) => new LosslessJSON.LosslessNumber(b).value))
}

module.exports = {
	convert,
	generate,
	createPatchJSON,
	applyPatchJSON
}