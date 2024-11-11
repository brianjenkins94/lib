import { createInterface, Interface as ReadlineInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

class ReadLineStream extends Readable {
	private _iterable;
	private _line;
	private _readline: ReadlineInterface;

	public constructor(iterable, options?) {
		super({
			...options,
			"highWaterMark": 1
		});

		this._iterable = iterable;

		this._readline = createInterface({
			"input": this
		})

		this._readline.on("line", (line) => {
			super.emit("line", line)
		})
	}

	private async _readChunks() {
		for (let chunk of this._iterable) {
			chunk = Buffer.from(chunk, "utf8");

			super.emit("line", this._line);

			if (!this.push(chunk)) {
				return;
			}
		}
	}

	public override _read(size: number): void {
		this._readChunks()
	}
}

export function createReadLineStream(options) {
	return new ReadLineStream(options);
}

class WriteMemoryStream extends Writable {
	private _decoder = new TextDecoder();
	public data = "";

	public constructor(options?) {
		super(options);
	}

	public override _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		try {
			chunk = this._decoder.decode(chunk, { "stream": true });

			this.data += chunk;

			callback();
		} catch (error) {
			callback(error);
		}
	}
}

export function createWriteMemoryStream(options) {
	return new WriteMemoryStream(options);
}
