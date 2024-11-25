import { esbuild } from "..";
import { kebabCaseToPascalCase } from "../../text";
import { renderToString as render } from "react-dom/server";
import { precompileComponent } from "./precompileComponent";
import { importFromString } from "module-from-string"

function _precompile(build) {
    build.onLoad({ "filter": /components|packages/u }, async function({ "path": filePath }) {
        const fileName = /(?<=(?:components|packages)\/.*?\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")).pop();
        const packageName = (/(?<=components\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")) || []).pop();
        const properName = kebabCaseToPascalCase(packageName ?? fileName);

        const { "outputFiles": [outputFile] } = await esbuild({
            "entryPoints": [filePath],
            "plugins": [
                precompileComponent()
            ],
            "external": ["react"]
        });

        const module = await importFromString(outputFile.text);

        const defaultExport = module.default;

        const component = defaultExport();

        let code = outputFile.text
            // Replace return
            .replace(new RegExp("(?<=^(?:export default )?function " + properName + ".*?\\n).*?(?=\\n\\})", "msu"), `return \`${render(component)}\`;`)
            // Remove pre/post-load
            .replace(new RegExp("^" + properName + "\\.(?:pre|post)load = .*?^\\};$", "gmsu"), "");

        return {
            "contents": code,
            "loader": "ts"
        };
    });
}

export function precompile() {
    return {
        "name": "precompile",
        "setup": _precompile
    }
}
