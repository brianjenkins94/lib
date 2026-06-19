import { mergeConfig } from 'vite'
import { defaults } from '../../util/vite/defaults'

// Inherits the repo's shared build defaults (esnext, [name].js, cleaned outDir) and bundles
// main.ts (the customized workbench) + all of its monaco-vscode-api dependencies into a
// self-contained, minified ES build under dist/, so consumers (e.g. @brianjenkins94/game)
// import the finished artifact rather than raw source.
export default mergeConfig(defaults, {
  // Relative base so emitted asset URLs (e.g. the codicon font, `url(./codicon.ttf)`) resolve
  // relative to wherever the bundle is served rather than the origin root. Consumers mount this
  // under a sub-path (the games iframe serves it at `/__vscode__/`); with the default base `/`,
  // `url(/codicon.ttf)` would escape that prefix and 404.
  base: './',
  build: {
    // Minify with vite's own (oxc) minifier — fast and within the default node heap.
    minify: true,
    rollupOptions: {
      input: { main: "main.ts" },
      // Bundle everything; nothing is externalized.
      preserveEntrySignatures: 'strict',
      output: {
        assetFileNames: '[name][extname]'
      }
    }
  },
  plugins: [
    {
      // monaco-vscode-api ships CSS that must be loaded as inline strings, not injected stylesheets.
      name: 'load-vscode-css-as-string',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        const resolved = await this.resolve(source, importer, options)
        if (
          resolved != null &&
          resolved.id.match(/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/)
        ) {
          return { ...resolved, id: resolved.id + '?inline' }
        }
        return undefined
      }
    }
  ],
  resolve: {
    dedupe: ['vscode', 'monaco-editor', '@codingame/monaco-vscode-api']
  }
})
