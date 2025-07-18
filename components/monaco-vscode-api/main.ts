import { initialize as initializeMonacoService, IWorkbenchConstructionOptions, LogLevel, IEditorOverrideServices } from '@codingame/monaco-vscode-api'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import { BrowserStorageService } from '@codingame/monaco-vscode-storage-service-override'
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions'
import getViewsServiceOverride, { isEditorPartVisible, Parts, attachPart, onDidChangeSideBarPosition } from '@codingame/monaco-vscode-views-service-override'
import { openNewCodeEditor } from './demo/src/features/editor'
import getConfigurationServiceOverride, { IStoredWorkspace, initUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride, { initUserKeybindings } from '@codingame/monaco-vscode-keybindings-service-override'
import { RegisteredFileSystemProvider, RegisteredMemoryFile, RegisteredReadOnlyFile, createIndexedDBProviders, registerHTMLFileSystemProvider, registerFileSystemOverlay, initFile } from '@codingame/monaco-vscode-files-service-override'
import * as monaco from 'monaco-editor'
import * as vscode from 'vscode'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getBannerServiceOverride from '@codingame/monaco-vscode-view-banner-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
import getLanguageDetectionWorkerServiceOverride from '@codingame/monaco-vscode-language-detection-worker-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getRemoteAgentServiceOverride from '@codingame/monaco-vscode-remote-agent-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getTestingServiceOverride from '@codingame/monaco-vscode-testing-service-override'
import getChatServiceOverride from '@codingame/monaco-vscode-chat-service-override'
import getNotebookServiceOverride from '@codingame/monaco-vscode-notebook-service-override'
import getWelcomeServiceOverride from '@codingame/monaco-vscode-welcome-service-override'
import getWalkThroughServiceOverride from '@codingame/monaco-vscode-walkthrough-service-override'
import getUserDataSyncServiceOverride from '@codingame/monaco-vscode-user-data-sync-service-override'
import getUserDataProfileServiceOverride from '@codingame/monaco-vscode-user-data-profile-service-override'
import getAiServiceOverride from '@codingame/monaco-vscode-ai-service-override'
import getTaskServiceOverride from '@codingame/monaco-vscode-task-service-override'
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override'
import getTimelineServiceOverride from '@codingame/monaco-vscode-timeline-service-override'
import getCommentsServiceOverride from '@codingame/monaco-vscode-comments-service-override'
import getEditSessionsServiceOverride from '@codingame/monaco-vscode-edit-sessions-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'
import getInteractiveServiceOverride from '@codingame/monaco-vscode-interactive-service-override'
import getIssueServiceOverride from '@codingame/monaco-vscode-issue-service-override'
import getMultiDiffEditorServiceOverride from '@codingame/monaco-vscode-multi-diff-editor-service-override'
import getPerformanceServiceOverride from '@codingame/monaco-vscode-performance-service-override'
import getRelauncherServiceOverride from '@codingame/monaco-vscode-relauncher-service-override'
import getShareServiceOverride from '@codingame/monaco-vscode-share-service-override'
import getSpeechServiceOverride from '@codingame/monaco-vscode-speech-service-override'
import getSurveyServiceOverride from '@codingame/monaco-vscode-survey-service-override'
import getUpdateServiceOverride from '@codingame/monaco-vscode-update-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getLocalizationServiceOverride from '@codingame/monaco-vscode-localization-service-override'
import getTreeSitterServiceOverride from '@codingame/monaco-vscode-treesitter-service-override'
import getTelemetryServiceOverride from '@codingame/monaco-vscode-telemetry-service-override'
import getMcpServiceOverride from '@codingame/monaco-vscode-mcp-service-override'
import { EnvironmentOverride } from '@codingame/monaco-vscode-api/workbench'
import { Worker } from './demo/src/tools/crossOriginWorker'
import defaultKeybindings from './demo/src/user/keybindings.json'
import defaultConfiguration from './demo/src/user/configuration.json'
import { TerminalBackend } from './demo/src/features/terminal'
import { workerConfig } from './demo/src/tools/extHostWorker'
import 'vscode/localExtensionHost'

const url = new URL(document.location.href)
const params = url.searchParams
const remoteAuthority = params.get('remoteAuthority') ?? undefined
const connectionToken = params.get('connectionToken') ?? undefined
const remotePath = remoteAuthority != null ? (params.get('remotePath') ?? undefined) : undefined
const resetLayout = params.has('resetLayout')
const useHtmlFileSystemProvider = params.has('htmlFileSystemProvider')
const disableShadowDom = params.has('disableShadowDom')
params.delete('resetLayout')

window.history.replaceState({}, document.title, url.href)

let workspaceFile = monaco.Uri.file('/workspace.code-workspace')

const userDataProvider = await createIndexedDBProviders()

if (useHtmlFileSystemProvider) {
	workspaceFile = monaco.Uri.from({ scheme: 'tmp', path: '/test.code-workspace' })
	await initFile(
		workspaceFile,
		JSON.stringify(
			<IStoredWorkspace>{
				folders: []
			},
			null,
			2
		)
	)

	registerHTMLFileSystemProvider()
} else {
	const fileSystemProvider = new RegisteredFileSystemProvider(false)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			vscode.Uri.file('/workspace/test.js'),
			`// import anotherfile
let variable = 1
function inc () {
  variable++
}

while (variable < 5000) {
  inc()
  console.log('Hello world', variable);
}`
		)
	)

	const content = new TextEncoder().encode('This is a readonly static file')
	fileSystemProvider.registerFile(
		new RegisteredReadOnlyFile(
			vscode.Uri.file('/workspace/test_readonly.js'),
			async () => content,
			content.length
		)
	)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			vscode.Uri.file('/workspace/jsconfig.json'),
			`{
  "compilerOptions": {
    "target": "es2020",
    "module": "esnext",
    "lib": [
      "es2021",
      "DOM"
    ]
  }
}`
		)
	)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			vscode.Uri.file('/workspace/index.html'),
			`
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>monaco-vscode-api demo</title>
    <link rel="stylesheet" href="test.css">
  </head>
  <body>
    <style type="text/css">
      h1 {
        color: DeepSkyBlue;
      }
    </style>

    <h1>Hello, world!</h1>
  </body>
</html>`
		)
	)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			vscode.Uri.file('/workspace/test.md'),
			`
***Hello World***

Math block:
$$
\\displaystyle
\\left( \\sum_{k=1}^n a_k b_k \\right)^2
\\leq
\\left( \\sum_{k=1}^n a_k^2 \\right)
\\left( \\sum_{k=1}^n b_k^2 \\right)
$$

# Easy Math

2 + 2 = 4 // this test will pass
2 + 2 = 5 // this test will fail

# Harder Math

230230 + 5819123 = 6049353
`
		)
	)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			vscode.Uri.file('/workspace/test.customeditor'),
			`
Custom Editor!`
		)
	)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			vscode.Uri.file('/workspace/test.css'),
			`
h1 {
  color: DeepSkyBlue;
}`
		)
	)

	// Use a workspace file to be able to add another folder later (for the "Attach filesystem" button)
	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			workspaceFile,
			JSON.stringify(
				<IStoredWorkspace>{
					folders: [
						{
							path: '/workspace'
						}
					]
				},
				null,
				2
			)
		)
	)

	fileSystemProvider.registerFile(
		new RegisteredMemoryFile(
			monaco.Uri.file('/workspace/tsconfig.json'),
			`{
				"compilerOptions": {
					"esModuleInterop": true,
					"skipLibCheck": true,
					"alwaysStrict": true,
					//"exactOptionalPropertyTypes": true,
					"forceConsistentCasingInFileNames": false,
					"isolatedModules": true,
					"jsx": "react-jsx",
					"lib": [
						"dom",
						"dom.iterable",
						"esnext"
					],
					"module": "ESNext",
					"moduleResolution": "Node",
					"noEmit": true,
					//"noImplicitAny": true,
					"noImplicitOverride": true,
					"noImplicitReturns": true,
					//"noImplicitThis": true,
					"noPropertyAccessFromIndexSignature": true,
					"resolveJsonModule": true,
					"strict": false,
					"strictBindCallApply": true,
					"strictFunctionTypes": true,
					//"strictNullChecks": true,
					//"strictPropertyInitialization": true,
					//"useUnknownInCatchVariables": true
					"target": "ESNext",
					"experimentalDecorators": true
				}
			}`
		)
	)

	registerFileSystemOverlay(1, fileSystemProvider)
}

// Workers
type WorkerLoader = () => Worker

const workerLoaders: Partial<Record<string, WorkerLoader>> = {
	TextEditorWorker: () =>
		new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
			type: 'module'
		}),
	TextMateWorker: () =>
		new Worker(
			new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
			{ type: 'module' }
		),
	OutputLinkDetectionWorker: () =>
		new Worker(
			new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url),
			{ type: 'module' }
		),
	LanguageDetectionWorker: () =>
		new Worker(
			new URL(
				'@codingame/monaco-vscode-language-detection-worker-service-override/worker',
				import.meta.url
			),
			{ type: 'module' }
		),
	NotebookEditorWorker: () =>
		new Worker(
			new URL('@codingame/monaco-vscode-notebook-service-override/worker', import.meta.url),
			{ type: 'module' }
		),
	LocalFileSearchWorker: () =>
		new Worker(
			new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url),
			{ type: 'module' }
		)
}

window.MonacoEnvironment = {
	getWorker: function(moduleId, label) {
		const workerFactory = workerLoaders[label]
		if (workerFactory != null) {
			return workerFactory()
		}
		throw new Error(`Unimplemented worker ${label} (${moduleId})`)
	}
}

// Set configuration before initializing service so it's directly available (especially for the theme, to prevent a flicker)
await Promise.all([
	initUserConfiguration(defaultConfiguration),
	initUserKeybindings(defaultKeybindings)
])

const constructOptions: IWorkbenchConstructionOptions = {
	remoteAuthority,
	enableWorkspaceTrust: true,
	connectionToken,
	windowIndicator: {
		label: 'monaco-vscode-api',
		tooltip: '',
		command: ''
	},
	workspaceProvider: {
		trusted: true,
		async open() {
			window.open(window.location.href)
			return true
		},
		workspace:
			remotePath == null
				? {
					workspaceUri: workspaceFile
				}
				: {
					folderUri: monaco.Uri.from({
						scheme: 'vscode-remote',
						path: remotePath,
						authority: remoteAuthority
					})
				}
	},
	developmentOptions: {
		logLevel: LogLevel.Info // Default value
	},
	configurationDefaults: {
		'window.title': 'Monaco-Vscode-Api${separator}${dirty}${activeEditorShort}'
	},
	defaultLayout: {
		editors: useHtmlFileSystemProvider
			? undefined
			: [
				{
					uri: monaco.Uri.file('/workspace/test.js'),
					viewColumn: 1
				},
				{
					uri: monaco.Uri.file('/workspace/test.md'),
					viewColumn: 2
				}
			],
		layout: useHtmlFileSystemProvider
			? undefined
			: {
				editors: {
					orientation: 0,
					groups: [{ size: 1 }, { size: 1 }]
				}
			},
		views: [
			{
				id: 'custom-view'
			}
		],
		force: resetLayout
	},
	welcomeBanner: {
		message: 'Welcome in monaco-vscode-api demo'
	},
	productConfiguration: {
		nameShort: 'monaco-vscode-api',
		nameLong: 'monaco-vscode-api',
		extensionsGallery: {
			serviceUrl: 'https://open-vsx.org/vscode/gallery',
			resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
			extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest', // https://github.com/eclipse/openvsx/issues/1036#issuecomment-2476449435
			controlUrl: '',
			nlsBaseUrl: ''
		}
	}
}

const envOptions: EnvironmentOverride = {
	// Otherwise, VSCode detect it as the first open workspace folder
	// which make the search result extension fail as it's not able to know what was detected by VSCode
	// userHome: vscode.Uri.file('/')
}

const commonServices: IEditorOverrideServices = {
	...getAuthenticationServiceOverride(),
	...getLogServiceOverride(),
	...getExtensionServiceOverride(workerConfig),
	...getExtensionGalleryServiceOverride({ webOnly: false }),
	...getModelServiceOverride(),
	...getNotificationServiceOverride(),
	...getDialogsServiceOverride(),
	...getConfigurationServiceOverride(),
	...getKeybindingsServiceOverride(),
	...getTextmateServiceOverride(),
	...getTreeSitterServiceOverride(),
	...getThemeServiceOverride(),
	...getLanguagesServiceOverride(),
	...getDebugServiceOverride(),
	...getPreferencesServiceOverride(),
	...getOutlineServiceOverride(),
	...getTimelineServiceOverride(),
	...getBannerServiceOverride(),
	...getStatusBarServiceOverride(),
	...getTitleBarServiceOverride(),
	...getSnippetServiceOverride(),
	...getOutputServiceOverride(),
	...getTerminalServiceOverride(new TerminalBackend()),
	...getSearchServiceOverride(),
	...getMarkersServiceOverride(),
	...getAccessibilityServiceOverride(),
	...getLanguageDetectionWorkerServiceOverride(),
	...getStorageServiceOverride({
		fallbackOverride: {
			'workbench.activity.showAccounts': false
		}
	}),
	...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
	...getLifecycleServiceOverride(),
	...getEnvironmentServiceOverride(),
	...getWorkspaceTrustOverride(),
	...getWorkingCopyServiceOverride(),
	...getScmServiceOverride(),
	...getTestingServiceOverride(),
	...getChatServiceOverride(),
	...getNotebookServiceOverride(),
	...getWelcomeServiceOverride(),
	...getWalkThroughServiceOverride(),
	...getUserDataProfileServiceOverride(),
	...getUserDataSyncServiceOverride(),
	...getAiServiceOverride(),
	...getTaskServiceOverride(),
	...getCommentsServiceOverride(),
	...getEditSessionsServiceOverride(),
	...getEmmetServiceOverride(),
	...getInteractiveServiceOverride(),
	...getIssueServiceOverride(),
	...getMultiDiffEditorServiceOverride(),
	...getPerformanceServiceOverride(),
	...getRelauncherServiceOverride(),
	...getShareServiceOverride(),
	...getSpeechServiceOverride(),
	...getSurveyServiceOverride(),
	...getUpdateServiceOverride(),
	...getExplorerServiceOverride(),
	...getLocalizationServiceOverride({
		async clearLocale() {
			const url = new URL(window.location.href)
			url.searchParams.delete('locale')
			window.history.pushState(null, '', url.toString())
		},
		async setLocale(id) {
			const url = new URL(window.location.href)
			url.searchParams.set('locale', id)
			window.history.pushState(null, '', url.toString())
		},
		availableLanguages: [
			{
				locale: 'en',
				languageName: 'English'
			},
			{
				locale: 'cs',
				languageName: 'Czech'
			},
			{
				locale: 'de',
				languageName: 'German'
			},
			{
				locale: 'es',
				languageName: 'Spanish'
			},
			{
				locale: 'fr',
				languageName: 'French'
			},
			{
				locale: 'it',
				languageName: 'Italian'
			},
			{
				locale: 'ja',
				languageName: 'Japanese'
			},
			{
				locale: 'ko',
				languageName: 'Korean'
			},
			{
				locale: 'pl',
				languageName: 'Polish'
			},
			{
				locale: 'pt-br',
				languageName: 'Portuguese (Brazil)'
			},
			{
				locale: 'qps-ploc',
				languageName: 'Pseudo Language'
			},
			{
				locale: 'ru',
				languageName: 'Russian'
			},
			{
				locale: 'tr',
				languageName: 'Turkish'
			},
			{
				locale: 'zh-hans',
				languageName: 'Chinese (Simplified)'
			},
			{
				locale: 'zh-hant',
				languageName: 'Chinese (Traditional)'
			},
			{
				locale: 'en',
				languageName: 'English'
			}
		]
	}),
	...getSecretStorageServiceOverride(),
	...getTelemetryServiceOverride(),
	...getMcpServiceOverride()
}

// Override services
await initializeMonacoService(
	{
		...commonServices,
		...getViewsServiceOverride(openNewCodeEditor, undefined),

		...getQuickAccessServiceOverride({
			isKeybindingConfigurationVisible: isEditorPartVisible,
			shouldUseGlobalPicker: (_editor, isStandalone) => !isStandalone && isEditorPartVisible()
		})
	},
	document.body,
	constructOptions,
	envOptions
)

for (const config of [
	{
		part: Parts.SIDEBAR_PART,
		get element() {
			return '#sidebar'
		},
		onDidElementChange: onDidChangeSideBarPosition
	},
	{ part: Parts.PANEL_PART, element: '#console' },
	{ part: Parts.EDITOR_PART, element: '#editors' },
	{ part: Parts.STATUSBAR_PART, element: '#statusbar' },
	{
		part: Parts.AUXILIARYBAR_PART,
		get element() {
			return '#auxbar'
		},
		onDidElementChange: onDidChangeSideBarPosition
	}
]) {
	attachPart(config.part, document.querySelector<HTMLDivElement>(config.element)!)
}

await registerExtension(
	{
		name: 'demo',
		publisher: 'codingame',
		version: '1.0.0',
		engines: {
			vscode: '*'
		}
	},
	ExtensionHostKind.LocalProcess
).setAsDefaultApi()

import '@codingame/monaco-vscode-clojure-default-extension'
import '@codingame/monaco-vscode-coffeescript-default-extension'
import '@codingame/monaco-vscode-configuration-editing-default-extension'
import '@codingame/monaco-vscode-cpp-default-extension'
import '@codingame/monaco-vscode-csharp-default-extension'
import '@codingame/monaco-vscode-css-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
import '@codingame/monaco-vscode-diff-default-extension'
import '@codingame/monaco-vscode-emmet-default-extension'
import '@codingame/monaco-vscode-fsharp-default-extension'
import '@codingame/monaco-vscode-go-default-extension'
import '@codingame/monaco-vscode-groovy-default-extension'
import '@codingame/monaco-vscode-html-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-ipynb-default-extension'
import '@codingame/monaco-vscode-java-default-extension'
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-julia-default-extension'
import '@codingame/monaco-vscode-lua-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'
import '@codingame/monaco-vscode-markdown-language-features-default-extension'
import '@codingame/monaco-vscode-markdown-math-default-extension'
import '@codingame/monaco-vscode-media-preview-default-extension'
import '@codingame/monaco-vscode-npm-default-extension'
import '@codingame/monaco-vscode-objective-c-default-extension'
import '@codingame/monaco-vscode-perl-default-extension'
import '@codingame/monaco-vscode-php-default-extension'
import '@codingame/monaco-vscode-powershell-default-extension'
import '@codingame/monaco-vscode-python-default-extension'
import '@codingame/monaco-vscode-r-default-extension'
import '@codingame/monaco-vscode-references-view-default-extension'
import '@codingame/monaco-vscode-ruby-default-extension'
import '@codingame/monaco-vscode-rust-default-extension'
import '@codingame/monaco-vscode-scss-default-extension'
import '@codingame/monaco-vscode-search-result-default-extension'
import '@codingame/monaco-vscode-shellscript-default-extension'
import '@codingame/monaco-vscode-sql-default-extension'
import '@codingame/monaco-vscode-swift-default-extension'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-theme-seti-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-vb-default-extension'
import '@codingame/monaco-vscode-xml-default-extension'
import '@codingame/monaco-vscode-yaml-default-extension'

export { ExtensionHostKind, registerExtension };

const { registerFileUrl, getApi } = registerExtension({
	"name": "humanify",
	"displayName": "humanify",
	"description": "",
	"publisher": "vscode-samples",
	"engines": {
		"vscode": "^1.84.0"
	},
	"categories": [
		"Other"
	],
	"activationEvents": [
		"onCommand:renameableSymbols.list"
	],
	"browser": "./extension.js",
	"contributes": {
		"commands": [
			{
				"command": "renameableSymbols.list",
				"title": "List Renameable Symbols"
			}
		]
	}
}, ExtensionHostKind.LocalWebWorker);

registerFileUrl('/extension.js', new URL('./extensions/humanify/extension.ts', import.meta.url).toString())
registerFileUrl('/package.json', new URL('./extensions/humanify/package.json', import.meta.url).toString())
