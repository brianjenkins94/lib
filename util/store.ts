import * as fs from "node:fs";
import * as path from "node:path";
import { isBrowser } from "./env";

// FROM: https://github.com/zaaack/keyv-file/blob/master/src/index.ts#L42
export class PersistentStore {
	private readonly options = {
		"deserialize": JSON.parse,
		"expiredCheckDelay": 24 * 3600 * 1000, // ms
		"filename": `.cache/keyv-file.json`,
		"serialize": (value) => JSON.stringify(value, undefined, 2),
		"writeDelay": 100, // ms
		"checkFileLock": false,
		// Cross-process handoff (a listener marks ids that a projector in another process must see on
		// its very next read, and a mark must be on disk before the marking call returns) needs
		// writes that land synchronously and reads that come from disk, not memory. The debounced
		// default gives neither, and existing consumers (caches, session stores) rely on it.
		"sync": false
	};

	private _cache: object;
	private _lastExpire: number;

	constructor(options = {}) {
		this.options = { ...this.options, ...options };
		if (!isBrowser && this.options.checkFileLock) {
			this.acquireFileLock();
		}

		this.load();
	}

	private load() {
		try {
			const data = this.options.deserialize(
				fs.readFileSync(this.options.filename, "utf8")
			);

			this._cache = data.cache;
			this._lastExpire = data.lastExpire;
		} catch (error) {
			// In sync mode only a missing file may read as empty: a torn read of another process's
			// in-flight write would otherwise become `{}` and the next set() would write that back,
			// clobbering every other key.
			if (this.options.sync && error.code !== "ENOENT") {
				throw error;
			}

			this._cache = {};
			this._lastExpire = Date.now();
		}
	}

	// Re-read on every access rather than on mtime change: another process's write can land within
	// the same timestamp tick, and the files this mode is for are small.
	private refresh() {
		if (this.options.sync && !isBrowser) {
			this.load();
		}
	}

	private get _lockFile() {
		return this.options.filename + ".lock";
	}

	acquireFileLock() {
		try {
			const fd = fs.openSync(this._lockFile, "wx");

			fs.closeSync(fd);

			process.on("SIGINT", () => {
				this.releaseFileLock();
				process.exit(0);
			});
			process.on("exit", () => {
				this.releaseFileLock();
			});
		} catch (error) {
			console.error(`[keyv-file] There is another process using this file`);
			throw error;
		}
	}

	releaseFileLock() {
		try {
			fs.unlinkSync(this._lockFile);
		} catch {}
	}

	public has(key: string) {
		this.refresh();

		const data = this._cache[key];

		if (!data) {
			return false;
		}

		if (this.isExpired(data)) {
			delete this._cache[key];
			void this.save();

			return false;
		}

		return true;
	}

	public get(key: string) {
		this.refresh();

		try {
			const data = this._cache[key];

			if (this.isExpired(data)) {
				delete this._cache[key];
			}

			return data?.value;
		} catch (error) {}
	}

	public set(key: string, value: any, ttl?: number) {
		this.refresh();

		if (ttl === 0) {
			ttl = undefined;
		}

		this._cache[key] = {
			"expire": typeof ttl === "number" ? Date.now() + ttl : undefined,
			"value": value
		};

		return this.save();
	}

	public delete(key: string) {
		this.refresh();

		delete this._cache[key];

		return this.save();
	}

	public clear() {
		this._cache = {};

		return this.save();
	}

	public *keys() {
		this.refresh();
		this.clearExpire();

		for (const [key] of Object.entries(this._cache)) { yield key; }
	}

	public *values() {
		this.refresh();
		this.clearExpire();

		for (const [, entry] of Object.entries(this._cache)) { yield entry.value; }
	}

	public *entries() {
		this.refresh();
		this.clearExpire();

		for (const [key, entry] of Object.entries(this._cache)) {
			yield [key, entry.value];
		}
	}

	public [Symbol.iterator]() {
		return this.entries();
	}

	private isExpired(data) {
		return typeof data.expire === "number" && data.expire <= Date.now();
	}

	private clearExpire() {
		const now = Date.now();

		if (now - this._lastExpire <= this.options.expiredCheckDelay) {
			return;
		}

		for (const [key, value] of Object.entries(this._cache)) {
			if (this.isExpired(value)) {
				delete this._cache[key];
			}
		}

		this._lastExpire = now;
	}

	private saveToDisk() {
		const data = this.options.serialize({
			"cache": this._cache,
			"lastExpire": this._lastExpire
		});

		const dirname = path.dirname(this.options.filename);

		if (!(fs.existsSync(dirname))) {
			fs.mkdirSync(dirname, { "recursive": true });
		}

		fs.writeFileSync(this.options.filename, data);
	}

	private _savePromise?: Promise<any> | undefined;

	private save() {
		this.clearExpire();

		// Sync mode: on disk (or thrown) before the caller regains control.
		if (this.options.sync && !isBrowser) {
			this.saveToDisk();

			return Promise.resolve();
		}

		if (this._savePromise) {
			return this._savePromise;
		}

		this._savePromise = isBrowser ? Promise.resolve() : new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				try {
					this.saveToDisk();
					resolve();
				} catch (error) {
					reject(error);
				} finally {
					this._savePromise = undefined;
				}
			}, this.options.writeDelay);
		});

		return this._savePromise;
	}
}
