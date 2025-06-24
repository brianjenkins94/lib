import ProxyServer from "http-proxy";
import * as url from "url";

export function proxy(from, to) {
	return new ProxyServer({
        "target": to,
		"changeOrigin": true
	}).listen(from);
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).toString()) {
    proxy(8080, process.argv[2]);
}