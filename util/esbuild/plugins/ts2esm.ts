import * as path from "path";

import * as fs from "../../fs"
import { replaceRequires } from "ts2esm/dist/src/converter/replacer/replaceRequire"
import { replaceModuleExports } from "ts2esm/dist/src/converter/replacer/replaceModuleExports"
import { Project, getCompilerOptionsFromTsConfig } from "ts-morph";

let project;

export function _ts2esm(file, config) {
    project ??= new Project({
        "compilerOptions": getCompilerOptionsFromTsConfig(config["tsconfig"]).options,
        "skipAddingFilesFromTsConfig": true,
        "useInMemoryFileSystem": true
    });

    const sourceFile = project.createSourceFile("temp.ts", file, { "overwrite": true });

    replaceRequires(sourceFile)
    replaceModuleExports(sourceFile)

    return sourceFile.getFullText();
}

export function ts2esm(config) {
    return {
        "name": "ts2esm",
        "setup": function(build) {
            build.onLoad({ "filter": /.*/u }, async function(args) {
                if (path.extname(args.path).endsWith(".js")) {
                    return {
                        "contents": _ts2esm(await fs.readFile(args.path), config),
                        "loader": path.extname(args.path).substring(1)
                    }
                }
            });
        }
    }
}
