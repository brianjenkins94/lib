import { IStorageService, IWorkbenchLayoutService, getService, initialize as initializeMonacoService } from "vscode/services";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import { BrowserStorageService } from "@codingame/monaco-vscode-storage-service-override";
import { ExtensionHostKind } from "@codingame/monaco-vscode-extensions-service-override";
import { registerExtension } from "vscode/extensions";
import getViewsServiceOverride, {
	Parts,
	attachPart,
	isEditorPartVisible,
	isPartVisibile,
	onPartVisibilityChange
} from "@codingame/monaco-vscode-views-service-override";
import { openNewCodeEditor } from "./demo/src/features/editor";
import "./demo/src/features/customView.views";
import { commonServices, constructOptions, envOptions, remoteAuthority, userDataProvider } from "./demo/src/setup.common";

// Override services
await initializeMonacoService({
	...commonServices,
	...getViewsServiceOverride(openNewCodeEditor, undefined),

	...getQuickAccessServiceOverride({
		"isKeybindingConfigurationVisible": isEditorPartVisible,
		"shouldUseGlobalPicker": (_editor, isStandalone) => !isStandalone && isEditorPartVisible()
	})
}, document.body, constructOptions, envOptions);

for (const config of [
	//{ part: Parts.TITLEBAR_PART, element: '#titleBar' },
	//{ part: Parts.BANNER_PART, element: '#banner' },
	{ "part": Parts.SIDEBAR_PART, "element": "#sidebar" },
	//{ part: Parts.ACTIVITYBAR_PART, get element () { return getSideBarPosition() === Position.LEFT ? '#activityBar' : '#activityBar-right' }, onDidElementChange: onDidChangeSideBarPosition },
	{ "part": Parts.PANEL_PART, "element": "#console" },
	{ "part": Parts.EDITOR_PART, "element": "#editors" },
	{ "part": Parts.STATUSBAR_PART, "element": "#statusbar" },
	{ "part": Parts.AUXILIARYBAR_PART, "element": "#auxbar" }
]) {
	attachPart(config.part, document.querySelector<HTMLDivElement>(config.element)!);

	config.onDidElementChange?.(() => {
		attachPart(config.part, document.querySelector<HTMLDivElement>(config.element)!);
	});

	if (!isPartVisibile(config.part)) {
		document.querySelector<HTMLDivElement>(config.element)!.style.display = "none";
	}

	onPartVisibilityChange(config.part, (visible) => {
		document.querySelector<HTMLDivElement>(config.element)!.style.display = visible ? "block" : "none";
	});
}

await registerExtension({
	"name": "demo",
	"publisher": "codingame",
	"version": "1.0.0",
	"engines": {
		"vscode": "*"
	}
}, ExtensionHostKind.LocalProcess).setAsDefaultApi();

const { registerFileUrl, getApi } = registerExtension({
	"name": "helloworld-web-sample",
	"displayName": "helloworld-web-sample",
	"description": "HelloWorld example for VS Code in the browser",
	"version": "0.0.1",
	"publisher": "vscode-samples",
	"private": true,
	"license": "MIT",
	"repository": "https://github.com/microsoft/vscode-extension-samples/helloworld-web-sample",
	"engines": {
		"vscode": "^1.84.0"
	},
	"categories": [
		"Other"
	],
	"activationEvents": [
		"onLanguage:plaintext"
	],
	"browser": "./extension.js",
	"contributes": {
		"commands": [
			{
				"command": "helloworld-web-sample.helloWorld",
				"title": "Hello World"
			}
		],
		"configuration": [
			{
				"order": 22,
				"id": "lsp-web-extension-sample",
				"title": "lsp-web-extension-sample",
				"properties": {
					"lsp-web-extension-sample.trace.server": {
						"type": "string",
						"scope": "window",
						"enum": [
							"off",
							"messages",
							"verbose"
						],
						"default": "verbose",
						"description": "Traces the communication between VS Code and the lsp-web-extension-sample language server."
					}
				}
			}
		]
	}
}, ExtensionHostKind.LocalWebWorker);

registerFileUrl('/package.json', new URL('./extensions/hello-world/package.json', import.meta.url).toString())
registerFileUrl('/extension.js', new URL('./extensions/hello-world/extension.ts', import.meta.url).toString())
