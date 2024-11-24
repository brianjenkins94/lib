import * as path from "path";

const NAMESPACE = "vfs";

export function virtualFileSystem(files = {}) {
    return {
        "name": "virtual-file-system",
        "setup": function(build) {
            build.onResolve({ "filter": /.*/u }, function(args) {
                args.path = path.normalize(args.path).replace(/\\/gu, "/");

                if (files[args.path] !== undefined) {
                    return {
                        "path": args.path,
                        "namespace": NAMESPACE
                    }
                }
            });

            build.onLoad({ "filter": /.*/u, "namespace": NAMESPACE }, function(args) {
                if (files[args.path] !== undefined) {
                    return {
                        "contents": files[args.path],
                        "resolveDir": path.dirname(args.path),
                        "loader": build.initialOptions.loader[path.extname(args.path)] ?? path.extname(args.path).substring(1)
                    }
                }
            });
        }
    };
}
