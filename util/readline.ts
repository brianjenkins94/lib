import * as readline from "node:readline";
import * as fs from "node:fs";
import * as stream from "node:stream";

export class FakeReadStream extends stream.Readable {
	private buffer;
	public input = {
		"path": undefined
	};

	public static createReadStream(filePath, options = { "highWaterMark": 1 }) {
		return new this(filePath, options);
	}

	private constructor(filePath, options) {
		super(options);

		this.input.path = filePath;

		this.buffer = fs.readFileSync(filePath, { "encoding": "utf8" }).split(/\r?\n/gu);
	}

	public pause() {
		return this;
	}

	public resume() {
		if (this.buffer.length === 0) {
			this.emit("close");
		} else {
			this.emit("line", this.buffer.pop(), this);
		}

        return this;
	}
}

export class FakeWriteStream extends stream.Writable {
	public buffer = [];
	public input = {
		"path": undefined
	};

	public static createWriteStream(filePath) {
		return new this(filePath);
	}

	private constructor(filePath) {
        super();

		this.input.path = filePath;
	}

	public write(chunk) {
		this.buffer.push(chunk);

        return true;
	}

	public flush() {
		fs.writeFileSync(this.input.path, this.buffer.reverse().join(""));
	}
}

export function createInterface(options: readline.ReadLineOptions) {
    if (typeof options.input === "string") {
        options.input = FakeReadStream.createReadStream(options.input)
    }

	return readline.createInterface(options);
}
