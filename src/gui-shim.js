// GUI Shim for CLI / Electron environments
let electron, Swal, storage;

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

if (isNode) {
	try {
		// Use dynamic strings to completely hide from bundlers/pkg static analysis
		const electronName = "elec" + "tron";
		electron = module.require(electronName);
	} catch (e) {
		electron = {
			remote: {
				dialog: {
					showOpenDialogSync: () => [],
					showSaveDialogSync: () => ""
				}
			}
		};
	}

	try {
		const swalName = "sweet" + "alert2";
		Swal = module.require(swalName);
	} catch (e) {
		Swal = {
			fire: () => Promise.resolve({ isConfirmed: false })
		};
	}

	try {
		const storageName = "electron-json-" + "storage";
		storage = module.require(storageName);
	} catch (e) {
		storage = {
			getSync: () => ({}),
			set: (key, val, cb) => cb && cb()
		};
	}
} else {
	electron = {};
	Swal = {};
	storage = {};
}

module.exports = {
	electron,
	Swal,
	storage
};
