import * as path from "path";

const NAMESPACE = "vfs";

export function virtualFileSystem(files = {}) {
    return {
        "name": "virtual-file-system",
        "setup": function(build) {
            build.onResolve({ "filter": /.*/u }, function(args) {
                if (files[args.path.replace(/\\/gu, "/")] !== undefined) {
                    return {
                        "path": args.path,
                        "namespace": NAMESPACE
                    }
                }
            });

            build.onLoad({ "filter": /.*/u, "namespace": NAMESPACE }, function(args) {
                if (files[args.path] !== undefined) {
                    return {
                        "contents": files[args.path]
                    }
                }
            });
        }
    };
}
