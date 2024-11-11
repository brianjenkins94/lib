import { createInterface, Interface as ReadlineInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

class ReadLineStream extends Readable {
	private _readStream;

	public constructor(readStream, options = {}) {
		super(options);

		this._readStream = readStream;
		this._readStream._readableState.highWaterMark = 1

		readStream.on("readable", () => {
			super.read(0)
		})
	}

	public override async _read(size: number): Promise<void> {
		const readline = createInterface({
			"input": this._readStream
		})

		readline.on("line", (line) => {
			if (line !== "\n") {
				super.emit("line", line)
			}
		});

		for await (const chunk of this._readStream) {}
	}
}

export function createReadLineStream(readStream, options) {
	return new ReadLineStream(readStream, options);
}

class WriteMemoryStream extends Writable {
	private _decoder = new TextDecoder();
	public data = "";

	public constructor(options = {}) {
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
