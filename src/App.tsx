15:56:23.816 Running build in Washington, D.C., USA (East) – iad1
15:56:23.817 Build machine configuration: 2 cores, 8 GB
15:56:23.953 Cloning github.com/GGSORE/ggsore-attendance-pwa (Branch: main, Commit: f7a1d0c)
15:56:24.292 Cloning completed: 339.000ms
15:56:24.511 Restored build cache from previous deployment (4wWCYP41WQCsmVHSv8nteahwtRWd)
15:56:24.783 Running "vercel build"
15:56:26.042 Vercel CLI 50.9.6
15:56:26.586 Installing dependencies...
15:56:31.255 
15:56:31.255 up to date in 4s
15:56:31.256 
15:56:31.256 107 packages are looking for funding
15:56:31.256   run `npm fund` for details
15:56:31.293 Running "npm run build"
15:56:31.555 
15:56:31.555 > ggsore-attendance-pwa@1.0.0 build
15:56:31.555 > vite build
15:56:31.555 
15:56:31.868 [36mvite v5.4.21 [32mbuilding for production...[36m[39m
15:56:31.922 transforming...
15:56:31.969 [32m✓[39m 4 modules transformed.
15:56:34.465 
15:56:34.465 PWA v0.20.5
15:56:34.465 mode      generateSW
15:56:34.466 precache  2 entries (0.00 KiB)
15:56:34.466 files generated
15:56:34.466   dist/sw.js
15:56:34.466   dist/workbox-8c29f6e4.js
15:56:34.466 warnings
15:56:34.467   One of the glob patterns doesn't match any files. Please remove or fix the following: {
15:56:34.467   "globDirectory": "/vercel/path0/dist",
15:56:34.467   "globPattern": "**/*.{js,wasm,css,html}",
15:56:34.467   "globIgnores": [
15:56:34.467     "**/node_modules/**/*",
15:56:34.467     "sw.js",
15:56:34.467     "workbox-*.js"
15:56:34.467   ]
15:56:34.468 }
15:56:34.468 
15:56:34.476 [31mx[39m Build failed in 2.58s
15:56:34.476 [31merror during build:
15:56:34.476 [31m[vite-plugin-pwa:build] [plugin vite-plugin-pwa:build] src/App.tsx (742:2): There was an error during the build:
15:56:34.477   Transform failed with 1 error:
15:56:34.477 /vercel/path0/src/App.tsx:742:2: ERROR: Top-level return cannot be used inside an ECMAScript module
15:56:34.477 Additionally, handling the error in the 'buildEnd' hook caused the following error:
15:56:34.477   Transform failed with 1 error:
15:56:34.477 /vercel/path0/src/App.tsx:742:2: ERROR: Top-level return cannot be used inside an ECMAScript module[31m
15:56:34.478 file: [36m/vercel/path0/src/App.tsx:742:2[31m
15:56:34.478 [33m
15:56:34.478 [33mTop-level return cannot be used inside an ECMAScript module[33m
15:56:34.478 740|    // UI
15:56:34.478 741|    // =========================
15:56:34.478 742|    return (
15:56:34.478    |    ^
15:56:34.478 743|      <div style={{ minHeight: "100vh", background: "#f7f7f8", padding: 16, fontFamily: "Century Gothic, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" }}>
15:56:34.478 744|        <div style={{ maxWidth: 980, margin: "0 auto" }}>
15:56:34.478 [31m
15:56:34.478     at getRollupError (file:///vercel/path0/node_modules/rollup/dist/es/shared/parseAst.js:402:41)
15:56:34.478     at file:///vercel/path0/node_modules/rollup/dist/es/shared/node-entry.js:23441:39
15:56:34.478     at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
15:56:34.478     at async catchUnfinishedHookActions (file:///vercel/path0/node_modules/rollup/dist/es/shared/node-entry.js:22899:16)
15:56:34.479     at async rollupInternal (file:///vercel/path0/node_modules/rollup/dist/es/shared/node-entry.js:23424:5)
15:56:34.479     at async build (file:///vercel/path0/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:65709:14)
15:56:34.479     at async CAC.<anonymous> (file:///vercel/path0/node_modules/vite/dist/node/cli.js:829:5)[39m
15:56:34.503 Error: Command "npm run build" exited with 1
