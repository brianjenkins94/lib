import net from "net";

export class Tunnel {
    private sockets = new Set();
    private localUrl;
    private remotePort;
    private closed = false;
    public url;

    constructor(localUrl) {
        this.localUrl = localUrl;
    }

    async open(n = 10) {
        if (this.closed) {
            return;
        }

        if (this.url === undefined) {
            const response = await (await fetch("http://localtunnel.me/?new")).json();

            this.remotePort = response.port;
            this.url = response.url;
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

        return this.url;
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
