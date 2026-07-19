import {
	initialize as initializeMonacoService,
	IWorkbenchConstructionOptions,
	LogLevel,
	IEditorOverrideServices
} from '@codingame/monaco-vscode-api'
import getConfigurationServiceOverride, { initUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride, { initUserKeybindings } from '@codingame/monaco-vscode-keybindings-service-override'
import { RegisteredFileSystemProvider, RegisteredMemoryFile, RegisteredReadOnlyFile, createIndexedDBProviders, registerFileSystemOverlay, initFile } from '@codingame/monaco-vscode-files-service-override'
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
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
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
import getRemoteAgentServiceOverride from '@codingame/monaco-vscode-remote-agent-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getTestingServiceOverride from '@codingame/monaco-vscode-testing-service-override'
// AI/chat disabled — re-enable when games configures it:
// import getChatServiceOverride, { ChatEntitlement } from '@codingame/monaco-vscode-chat-service-override'
import getNotebookServiceOverride from '@codingame/monaco-vscode-notebook-service-override'
import getWelcomeServiceOverride from '@codingame/monaco-vscode-welcome-service-override'
import getWalkThroughServiceOverride from '@codingame/monaco-vscode-walkthrough-service-override'
import getUserDataSyncServiceOverride from '@codingame/monaco-vscode-user-data-sync-service-override'
import getUserDataProfileServiceOverride from '@codingame/monaco-vscode-user-data-profile-service-override'
// AI/chat disabled:
// import getAiServiceOverride from '@codingame/monaco-vscode-ai-service-override'
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
// AI/chat disabled (MCP = Model Context Protocol, AI tooling):
// import getMcpServiceOverride from '@codingame/monaco-vscode-mcp-service-override'
import getProcessControllerServiceOverride from '@codingame/monaco-vscode-process-explorer-service-override'
import getImageResizeServiceOverride from '@codingame/monaco-vscode-image-resize-service-override'
import getAssignmentServiceOverride from '@codingame/monaco-vscode-assignment-service-override'
import getViewsServiceOverride, { isEditorPartVisible, Parts, onPartVisibilityChange, isPartVisibile as isPartVisible, attachPart, onDidChangeSideBarPosition, registerCustomView, ViewContainerLocation } from '@codingame/monaco-vscode-views-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions'
import { setUnexpectedErrorHandler } from '@codingame/monaco-vscode-api/monaco'
import { EnvironmentOverride } from '@codingame/monaco-vscode-api/workbench'
import { openNewCodeEditor } from './demo/src/features/editor'
import { Worker } from './demo/src/tools/fakeWorker'
import { TerminalBackend } from './demo/src/features/terminal'
import 'vscode/localExtensionHost'

// Default language / feature extensions (loaded for side effects)
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

/** A file seeded into the workbench's in-memory workspace. */
export interface WorkbenchFile {
	/** Absolute in-workspace path, e.g. "/workspace/test.js". */
	path: string
	contents: string
	/** Register as read-only (default false). */
	readonly?: boolean
}

/** The DOM containers the workbench parts attach into. The host (e.g. the games
 *  `<Workbench/>` component) owns this markup/layout and passes the elements in. */
export interface WorkbenchParts {
	sidebar: HTMLElement
	editors: HTMLElement
	panel: HTMLElement
	statusbar: HTMLElement
	auxbar: HTMLElement
}

export interface BootOptions {
	/** Containers the workbench parts attach into (assembled by the consumer). */
	parts: WorkbenchParts
	/** Where the workbench itself mounts. Default: document.body. */
	container?: HTMLElement
	/** Auto-trust the workspace, suppressing the trust prompt. Default: true. */
	trusted?: boolean
	/** Files seeded into the in-memory workspace. Default: none. */
	files?: WorkbenchFile[]
	/** Files (by path) opened on first layout, one editor column each. Default: none. */
	openEditors?: string[]
	/** VS Code user settings (the settings.json object). Default: {}. */
	configuration?: Record<string, unknown>
	/** Keybinding entries (the keybindings.json array). Default: []. */
	keybindings?: unknown[]
	/** Workspace folder root. Default: "/workspace". */
	workspaceFolder?: string
	/** Product name shown in the title bar / window indicator. Default: "monaco-vscode-api". */
	productName?: string
	/** Called when a document is saved, with its path and new contents — lets the consumer
	 *  forward edits elsewhere (e.g. into an almostnode box's VirtualFS for a live preview). */
	onSave?: (path: string, contents: string) => void
}

// Workers — static; referenced by MonacoEnvironment below.
const workers: Partial<Record<string, Worker>> = {
	editorWorkerService: new Worker(
		new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
		{ type: 'module' }
	),
	extensionHostWorkerMain: new Worker(
		new URL('@codingame/monaco-vscode-api/workers/extensionHost.worker', import.meta.url),
		{ type: 'module' }
	),
	TextMateWorker: new Worker(
		new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
		{ type: 'module' }
	),
	OutputLinkDetectionWorker: new Worker(
		new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url),
		{ type: 'module' }
	),
	LanguageDetectionWorker: new Worker(
		new URL(
			'@codingame/monaco-vscode-language-detection-worker-service-override/worker',
			import.meta.url
		),
		{ type: 'module' }
	),
	NotebookEditorWorker: new Worker(
		new URL('@codingame/monaco-vscode-notebook-service-override/worker', import.meta.url),
		{ type: 'module' }
	),
	LocalFileSearchWorker: new Worker(
		new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url),
		{ type: 'module' }
	)
}

window.MonacoEnvironment = {
	getWorkerUrl(_, label) {
		return workers[label]?.url.toString()
	},
	getWorkerOptions(_, label) {
		return workers[label]?.options
	}
}

const envOptions: EnvironmentOverride = {
	// Otherwise, VSCode detect it as the first open workspace folder
	// which make the search result extension fail as it's not able to know what was detected by VSCode
	userHome: vscode.Uri.file('/')
}

const commonServices: IEditorOverrideServices = {
	...getAuthenticationServiceOverride(),
	...getLogServiceOverride(),
	...getExtensionServiceOverride({
		enableWorkerExtensionHost: true
	}),
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
			// AI/chat disabled — `chat.setupContext` seeding removed (was pre-enabling Copilot).
		}
	}),
	...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
	...getLifecycleServiceOverride(),
	...getEnvironmentServiceOverride(),
	...getWorkspaceTrustOverride(),
	...getWorkingCopyServiceOverride(),
	...getScmServiceOverride(),
	...getTestingServiceOverride(),
	// AI/chat disabled — re-enable when games configures it:
	// ...getChatServiceOverride({
	// 	defaultAccount: {
	// 		entitlementsData: {
	// 			access_type_sku: 'unused',
	// 			assigned_date: 'unused',
	// 			can_signup_for_limited: false,
	// 			copilot_plan: 'enterprise',
	// 			organization_login_list: [],
	// 			analytics_tracking_id: 'unused',
	// 			chat_enabled: true
	// 		},
	// 		accountName: 'unused',
	// 		authenticationProvider: { id: 'unused', name: 'unused', enterprise: true },
	// 		enterprise: true,
	// 		sessionId: 'unused'
	// 	}
	// }),
	...getNotebookServiceOverride(),
	...getWelcomeServiceOverride(),
	...getWalkThroughServiceOverride(),
	...getUserDataProfileServiceOverride(),
	...getUserDataSyncServiceOverride(),
	// AI/chat disabled:
	// ...getAiServiceOverride(),
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
			{ locale: 'en', languageName: 'English' }
		]
	}),
	...getSecretStorageServiceOverride(),
	...getTelemetryServiceOverride(),
	// AI/chat disabled (MCP = Model Context Protocol):
	// ...getMcpServiceOverride(),
	...getProcessControllerServiceOverride(),
	...getImageResizeServiceOverride(),
	...getAssignmentServiceOverride()
}

/**
 * Boot the VS Code workbench into consumer-provided containers.
 *
 * The consumer owns the host markup/layout (the part containers + their arrangement) and the
 * workspace contents (`files`/`openEditors`), so this component carries no demo specifics — it
 * wires services, seeds the in-memory workspace, mounts the workbench, and attaches each part
 * into `options.parts`. Workspace trust is auto-granted by default (`trusted`).
 */
export async function boot(options: BootOptions): Promise<void> {
	const {
		parts,
		container = document.body,
		trusted = true,
		files = [],
		openEditors = [],
		configuration = {},
		keybindings = [],
		workspaceFolder = '/workspace',
		productName = 'monaco-vscode-api',
		onSave
	} = options

	await createIndexedDBProviders()

	const fileSystemProvider = new RegisteredFileSystemProvider(false)

	for (const file of files) {
		const uri = vscode.Uri.file(file.path)

		if (file.readonly) {
			const content = new TextEncoder().encode(file.contents)
			fileSystemProvider.registerFile(new RegisteredReadOnlyFile(uri, async () => content, content.length))
		} else {
			fileSystemProvider.registerFile(new RegisteredMemoryFile(uri, file.contents))
		}
	}

	registerFileSystemOverlay(1, fileSystemProvider)

	// Set configuration before initializing the service so it's directly available (especially
	// the theme, to prevent a flicker).
	await Promise.all([
		initUserConfiguration(JSON.stringify(configuration)),
		initUserKeybindings(JSON.stringify(keybindings))
	])

	const constructOptions: IWorkbenchConstructionOptions = {
		// trusted → disable the workspace-trust feature entirely (no prompt).
		enableWorkspaceTrust: !trusted,
		windowIndicator: {
			label: productName,
			tooltip: '',
			command: ''
		},
		workspaceProvider: {
			trusted,
			async open() {
				window.open(window.location.href)
				return true
			},
			workspace: {
				// Single-folder workspace → the explorer shows just this folder by its basename
				// (e.g. "war2") with its contents at the root, rather than a multi-root wrapper.
				folderUri: monaco.Uri.file(workspaceFolder)
			}
		},
		developmentOptions: {
			logLevel: LogLevel.Info
		},
		configurationDefaults: {
			'window.title': productName + '${separator}${dirty}${activeEditorShort}'
		},
		defaultLayout: {
			editors: openEditors.map((path, index) => ({
				uri: monaco.Uri.file(path),
				viewColumn: index + 1
			})),
			layout: openEditors.length > 0
				? { editors: { orientation: 0, groups: openEditors.map(() => ({ size: 1 })) } }
				: undefined,
			force: true
		},
		productConfiguration: {
			nameShort: productName,
			nameLong: productName,
			extensionsGallery: {
				serviceUrl: 'https://open-vsx.org/vscode/gallery',
				resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
				extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest', // https://github.com/eclipse/openvsx/issues/1036#issuecomment-2476449435
				controlUrl: '',
				nlsBaseUrl: ''
			}
		}
	}

	await initializeMonacoService(
		{
			...commonServices,
			...getViewsServiceOverride(openNewCodeEditor, undefined),
			...getQuickAccessServiceOverride({
				isKeybindingConfigurationVisible: isEditorPartVisible,
				shouldUseGlobalPicker: (_editor, isStandalone) => !isStandalone && isEditorPartVisible()
			})
		},
		container,
		constructOptions,
		envOptions
	)

	setUnexpectedErrorHandler((e) => {
		console.info('Unexpected error', e)
	})

	for (const config of [
		{ part: Parts.SIDEBAR_PART, element: parts.sidebar, onDidElementChange: onDidChangeSideBarPosition },
		{ part: Parts.PANEL_PART, element: parts.panel, onDidElementChange: undefined },
		{ part: Parts.EDITOR_PART, element: parts.editors, onDidElementChange: undefined },
		{ part: Parts.STATUSBAR_PART, element: parts.statusbar, onDidElementChange: undefined },
		{ part: Parts.AUXILIARYBAR_PART, element: parts.auxbar, onDidElementChange: onDidChangeSideBarPosition }
	]) {
		attachPart(config.part, config.element)

		config.onDidElementChange?.(() => {
			attachPart(config.part, config.element)
		})

		if (!isPartVisible(config.part)) {
			config.element.style.display = 'none'
		}

		onPartVisibilityChange(config.part, (visible) => {
			config.element.style.display = visible ? 'block' : 'none'
		})
	}

	if (onSave != null) {
		vscode.workspace.onDidSaveTextDocument((document) => {
			onSave(document.uri.path, document.getText())
		})
	}
}

// Re-exported so the consumer (games) can register its own extension(s) and set the default API:
//   registerExtension({ name, publisher, version, engines }, ExtensionHostKind.LocalProcess).setAsDefaultApi()
export { ExtensionHostKind, registerExtension, registerFileSystemOverlay }

// Custom views re-exported so a consumer can render arbitrary DOM into a view (renderBody) placed in the
// sidebar / panel / auxiliary bar (ViewContainerLocation) — real DOM, not a sandboxed webview iframe, so it
// composites everywhere. (silo's review burndown; mirrors the @codingame demo's customView feature.)
export { registerCustomView, ViewContainerLocation } from '@codingame/monaco-vscode-views-service-override'

// Filesystem primitives re-exported so consumers can build + register custom overlay providers
// (e.g. games' CDN-backed node_modules resolver) without depending on @codingame packages directly.
export {
	FileType,
	FileChangeType,
	FileSystemProviderCapabilities,
	FileSystemProviderError,
	FileSystemProviderErrorCode
} from '@codingame/monaco-vscode-files-service-override'
export type {
	IFileSystemProviderWithFileReadWriteCapability,
	IStat,
	IFileChange
} from '@codingame/monaco-vscode-files-service-override'
