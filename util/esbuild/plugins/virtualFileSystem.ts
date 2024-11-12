export function virtualFileSystem(vfs = {}) {
    const NAMESPACE = "virtual-file-system";

    return {
        "name": "virtual-file-system",
        "setup": function(build) {
            build.onResolve({ "filter": /.*/u }, function(args) {
                return {
                    "path": args.path,
                    "namespace": NAMESPACE,
                    "pluginData": {
                        [NAMESPACE]: {
                            "resolveDir": args.resolveDir
                        }
                    }
                }
            });

            build.onLoad({ "filter": /.*/u, "namespace": NAMESPACE }, function(args) {
                const { resolveDir } = args.pluginData[NAMESPACE];

                if (vfs[args.path] !== undefined) {
                    return {
                        "contents": vfs[args.path],
                        "resolveDir": resolveDir
                    }
                }
            });
        }
    };
}
