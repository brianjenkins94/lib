import { sleep } from "@brianjenkins94/util/sleep";
import net from "node:net";

export class Tunnel {
	private readonly sockets = new Set();
	private readonly localUrl;
	private readonly subdomain;
	private remotePort;
	private closed = false;
	private ready = false;
	public url;

	constructor(localUrl, subdomain) {
		this.localUrl = localUrl;
		this.subdomain = subdomain;
	}

	async open(n = 10) {
		if (this.closed) {
			return;
		}

		if (n !== 1 && this.url !== undefined && this.ready && !(await this.forwarding())) {
			this.teardownSockets();
			this.url = undefined;
			this.remotePort = undefined;
			this.ready = false;
		}

		if (this.url === undefined) {
			const response = await (await fetch("http://localtunnel.me/" + (this.subdomain ?? "?new"))).json();

			this.remotePort = response.port;
			this.url = response.url;

			// A requested subdomain is best-effort: if it's taken (or declined) the server
			// hands back a random one, so re-creation is no longer stable — surface that.
			if (this.subdomain !== undefined && new URL(this.url).hostname.split(".")[0] !== this.subdomain) {
				console.warn(`[tunnel] requested subdomain "${this.subdomain}" unavailable; using ${this.url}`);
			}
		}

		for (let x = 0; x < n; x++) {
			const { hostname, port } = new URL(this.localUrl);

			let local;

			const remote = net.connect({ "host": "localtunnel.me", "port": this.remotePort, "keepAlive": true }, () => {
				local = net.connect({ "host": hostname, "port": parseInt(port || "80") }, () => {
					remote.pipe(local).pipe(remote);
				});

				local.once("error", (error) => {
					console.error("[tunnel] Local error:", error.message);

					local.removeAllListeners();
					local.destroy();
					this.sockets.delete(local);

					remote.removeAllListeners();
					remote.destroy();
					this.sockets.delete(remote);
				});

				local.once("end", () => {
					if (!remote.destroyed) {
						remote.end();
					}
				});

				local.once("close", () => {
					this.sockets.delete(local);
				});

				this.sockets.add(local);
			});

			remote.once("error", (error) => {
				remote.removeAllListeners();
				remote.destroy();
				this.sockets.delete(remote);

				if (local !== undefined && !local.destroyed) {
					local.removeAllListeners();
					local.destroy();
					this.sockets.delete(local);
				}
			});

			remote.once("end", () => {
				if (local !== undefined && !local.destroyed) {
					local.end();
				}
			});

			remote.once("close", () => {
				if (!this.closed) {
					this.open(1);
				}
			});

			this.sockets.add(remote);
		}

		if (!this.ready) {
			await this.waitUntilForwarding();

			this.ready = true;
		}

		return this.url;
	}

	private async waitUntilForwarding(attempts = 20) {
		for (let x = 0; x < attempts; x++) {
			if (await this.forwarding()) {
				return;
			}

			await sleep(1000);
		}
	}

	private async forwarding() {
		try {
			const response = await fetch(this.url, {
				"redirect": "manual",
				"headers": { "bypass-tunnel-reminder": "1" },
				"signal": AbortSignal.timeout(4000)
			});

			// Anything other than a gateway error means the local server answered.
			return ![408, 502, 503, 504].includes(response.status);
		} catch {
			// Not reachable - dead, or not up yet.
			return false;
		}
	}

	private teardownSockets() {
		for (const socket of this.sockets) {
			try {
				socket.removeAllListeners();
				socket.destroy();
			} catch {
				// Best effort
			}
		}

		this.sockets.clear();
	}

	close() {
		this.closed = true;

		const allSettled = Promise.allSettled([...this.sockets].map(function(socket) {
			socket.end();

			return new Promise<void>(function(resolve, reject) {
				const timeout = setTimeout(function() {
					if (!socket.destroyed) {
						socket.removeAllListeners();
						socket.destroy();
					}

					resolve();
				}, 1000);

				socket.once("close", function() {
					clearTimeout(timeout);

					resolve();
				});
			});
		}));

		this.sockets.clear();

		return allSettled;
	}
}
