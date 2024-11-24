import { esbuild, fromString } from "..";
import { kebabCaseToPascalCase } from "../../text";
import { renderToString as render } from "react-dom/server";

const components = {};
const scripts = {};

const stack = [];

function _precompile() {
    return function(build) {
        build.onLoad({ "filter": /components|packages/u }, async function({ "path": filePath }) {
            const fileName = /(?<=(?:components|packages)\/.*?\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")).pop();
            const packageName = (/(?<=components\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")) || []).pop();
            const properName = kebabCaseToPascalCase(packageName ?? fileName);

            const { "outputFiles": [compiledOutput] } = await esbuild({
                "entryPoints": filePath,
                "plugins": [

                ]
            });

            const defaultExport = (await import(URL.createObjectURL(new Blob([compiledOutput.text], { "type": "text/javascript" })) + "?ts=" + Date.now())).default;

            const component = defaultExport();

            let code = compiledOutput.text
                // Replace return
                .replace(new RegExp("(?<=^export default function " + properName + ".*?\\n).*?(?=\\n\\})", "msu"), `return \`${render(component)}\`;`)
                // Remove pre/post-load
                .replace(new RegExp("^" + properName + "\\.(?:pre|post)load = .*?^\\};$", "gmsu"), "");

            if (filePath.includes("packages")) {
                components[properName] = defaultExport?.postload.toString();

                code = `
                    const startTime = performance.now();
                    ${code}
                    document.body.appendChild(document.createRange().createContextualFragment(${properName}()));

                    const Range = ${Range.toString()};

                    const components = ${JSON.stringify(Object.entries(components).reduce(function(object, [key, value]) { return { ...object, [key]: "function(range) {\nreturn (function(range) { return function() {\n" + value.toString().split("\n").slice(1, -1).join("\n") + "\n};\n})(range);\n}" }; }, {}), function(key, value) { return typeof value === "function" ? value.toString() : value; }, 2)
                        // TODO: Find a better way to do this:
                        .replace(/\\n/gu, "\n") // Unescape newlines
                        .replace(/\\t/gu, "\t") // Unescape tabs
                        .replace(/\\"/gu, "\"") // Unescape quotes
                        .replace(/ anonymous\d*/gu, "") // Anonymize
                        .replace(/(?:'|")(function.*?\})(?:'|")(?=,\n {2}|\n\})/gsu, "$1") // Unquote function
                    };

                    const stack = ${JSON.stringify(stack)};

                    function loadAsset({ src, href }) {
                        const id = /(?<=\\/)[\\w-]+(?=\\.[\\w.]+$)/u.exec(src ?? href);

                        let timer;

                        return Promise.race([
                            new Promise<void>(function(resolve, reject) {
                                if (document.getElementById(id)) {
                                    resolve();
                                } else if (src !== undefined) {
                                    const script = document.createElement("script");
                                    script.id = id + "-script";
                                    script.src = src;
                                    script.onload = function() {
                                        resolve();
                                    };

                                    document.head.appendChild(script);
                                } else if (href !== undefined) {
                                    const style = document.createElement("link");
                                    style.id = id + "-stylesheet";
                                    style.href = href;
                                    style.rel = "stylesheet";
                                    style.onload = function() {
                                        resolve();
                                    };

                                    document.head.appendChild(style);
                                }
                            }),
                            new Promise<void>(function(resolve, reject) {
                                timer = setTimeout(function() {
                                    reject("Attempt to load " + (src ?? href) + " failed.");
                                }, 200000);
                            })
                        ]).then(function() {
                            clearTimeout(timer);
                        });
                    }

                    Promise.all(Object.entries(${JSON.stringify(scripts, undefined, 2)}).map(function([component, scripts]) {
                        return Promise.all(scripts.map(loadAsset))
                            .then(components[component](new Range(stack.pop())));
                    }))
                        .then(function() {
                            return Promise.all(${JSON.stringify(defaultExport?.preload?.())}.map(loadAsset));
                        })
                        .then(components["${properName}"]())
                        .then(function() {
                            console.log("Ready in " + (performance.now() - startTime).toFixed(3) + " ms");
                        });
                `.trim();
            }

            return {
                "contents": code,
                "loader": "ts"
            };
        });
    }
}

export function precompile() {
    return {
        "name": "precompile",
        "setup": _precompile
    }
}
