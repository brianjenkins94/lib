import * as path from "path";

const NAMESPACE = "vfs";

export function virtualFileSystem(files = {}, resolveDir) {
    return {
        "name": "virtual-file-system",
        "setup": function(build) {
            build.onResolve({ "filter": /.*/u }, function(args) {
                const fileName = path.relative(resolveDir, path.join(args.resolveDir, args.path)).replace(/\\/gu, "/")

                if (files[fileName] !== undefined) {
                    return {
                        "path": fileName,
                        "namespace": NAMESPACE,
                        "pluginData": {
                            [NAMESPACE]: {
                                "resolveDir": resolveDir
                            }
                        }
                    }
                }
            });

            build.onLoad({ "filter": /.*/u, "namespace": NAMESPACE }, function(args) {
                if (files[args.path] !== undefined) {
                    return {
                        "contents": files[args.path],
                        "resolveDir": path.dirname(path.join(resolveDir, args.path))
                    }
                }
            });
        }
    };
}
