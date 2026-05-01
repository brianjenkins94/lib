import * as fs from "fs"
import * as path from "path";
import { isBrowser } from "./env";

// FROM: https://github.com/zaaack/keyv-file/blob/master/src/index.ts#L42
export class PersistentStore {
  private options = {
    deserialize: JSON.parse,
    expiredCheckDelay: 24 * 3600 * 1000, // ms
    filename: `.cache/keyv-file.json`,
    serialize: (value) => JSON.stringify(value, undefined, 4),
    writeDelay: 100, // ms
    checkFileLock: false
  };
  private _cache: object;
  private _lastExpire: number

  constructor(options = {}) {
    this.options = { ...this.options, ...options };
    if (!isBrowser && this.options.checkFileLock) {
      this.acquireFileLock()
    }
    try {
      const data = this.options.deserialize(
        fs.readFileSync(this.options.filename, 'utf8')
      )
      this._cache = data.cache
      this._lastExpire = data.lastExpire
    } catch (e) {
      this._cache = {}
      this._lastExpire = Date.now()
    }
  }

  private get _lockFile() {
    return this.options.filename + '.lock'
  }

  acquireFileLock() {
    try {
      let fd = fs.openSync(this._lockFile, "wx");
      fs.closeSync(fd)

      process.on('SIGINT', () => {
        this.releaseFileLock()
        process.exit(0)
      })
      process.on('exit', () => {
        this.releaseFileLock()
      })
    } catch (error) {
      console.error(`[keyv-file] There is another process using this file`)
      throw error;
    }
  }

  releaseFileLock() {
    try {
      fs.unlinkSync(this._lockFile)
    } catch {}
  }

  public has(key: string) {
    const data = this._cache[key];
    if (!data) return false;
    if (this.isExpired(data)) {
      delete this._cache[key];
      void this.save();
      return false;
    }
    return true;
  }

  public get(key: string) {
    try {
      const data = this._cache[key];
      if (this.isExpired(data)) {
        delete this._cache[key]
      }
      return data?.value
    } catch (error) {}
  }

  public set(key: string, value: any, ttl?: number) {
    if (ttl === 0) {
      ttl = undefined
    }
    this._cache[key] = {
      expire: typeof ttl === "number" ? Date.now() + ttl : undefined,
      value: value as any,
    };
    return this.save()
  }

  public *keys() {
    this.clearExpire();

    for (const [key] of Object.entries(this._cache)) yield key;
  }

  public *values() {
    this.clearExpire();

    for (const [, entry] of Object.entries(this._cache)) yield entry.value;
  }

  public *entries() {
    this.clearExpire();

    for (const [key, entry] of Object.entries(this._cache)) {
      yield [key, entry.value];
    }
  }

  public [Symbol.iterator]() {
    return this.entries();
  }

  private isExpired(data) {
    return typeof data.expire === "number" && data.expire <= Date.now()
  }

  private clearExpire() {
    const now = Date.now();
    if (now - this._lastExpire <= this.options.expiredCheckDelay) {
      return;
    }
    for (const [key, value] of Object.entries(this._cache)) {
      if (this.isExpired(value)) {
        delete this._cache[key]
      }
    }
    this._lastExpire = now
  }

  private saveToDisk() {
    const data = this.options.serialize({
      "cache": this._cache,
      "lastExpire": this._lastExpire,
    });

    return new Promise<void>((resolve, reject) => {
      const dirname = path.dirname(this.options.filename);

      if (!(fs.existsSync(dirname))) {
        fs.mkdirSync(dirname, { "recursive": true })
      }

      try {
        fs.writeFileSync(this.options.filename, data)
      } catch (error) {
        reject(error);

        return;
      }

      resolve()
    });
  }

  private _savePromise?: Promise<any> | undefined

  private save() {
    this.clearExpire()
    if (this._savePromise) {
      return this._savePromise
    }
    this._savePromise = isBrowser ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        this.saveToDisk()
          .then(resolve, reject)
          .finally(() => {
            this._savePromise = undefined
          })
      }, this.options.writeDelay)
    });
    return this._savePromise
  }
}
