# ExperDeploy — Copilot Instructions

## What this project is

A VS Code extension that registers a **chat participant** (`@experdeploy`) to guide users through Power Platform ALM workflows (export/import Dataverse solutions, scaffold Vite+Vue projects, initialize Power Apps Code Apps). The entire logic lives in a single file: `src/extension.ts`.

## Build, test, and lint commands

```bash
npm run compile          # Webpack dev build → dist/extension.js
npm run watch            # Webpack in watch mode
npm run package          # Production build (used before publishing)
npm run lint             # ESLint on src/**/*.ts
npm run compile-tests    # tsc → out/ (needed before running tests)
npm test                 # compile-tests + compile + lint + vscode-test
```

Run a single test file (after `compile-tests`):
```bash
npx vscode-test --extensionTestsPath out/test/extension.test.js
```

Tests are in `src/test/` and compiled to `out/test/` via `tsconfig.json`.

## Architecture

```
src/extension.ts        ← entire extension (types, state, handlers, activation)
dist/extension.js       ← webpack output, entry point declared in package.json "main"
src/test/               ← Mocha tests via @vscode/test-cli
```

### State machine pattern

The chat participant is **stateful per conversation thread**. Each thread gets a `SessionALM` object stored in a module-level `Map<string, SessionALM>`. The `etat` field (type `EtatConversation`) drives a `switch` in `gererRequete()` — the main request handler. Every branch either:
- transitions `session.etat` to a new state and prompts for the next input, or
- calls `reinitialiserSession()` to return to `'MENU_PRINCIPAL'`.

Thread identity is derived from `contexte.history[0]` (stringified). This is a simplification — be careful not to break session isolation when refactoring.

### Terminal execution

Commands are sent to a named terminal (`'Power ALM ExperDeploy'`), reused across calls via `obtenirOuCreerTerminal()`. Sequences that must stop on failure use `executerScriptSecurise()`, which wraps each PowerShell command with an `$LASTEXITCODE` check. Single commands use `executerDansTerminal()`.

### Chat participant registration

Registered in `activate()` via `vscode.chat.createChatParticipant('experdeploy.agent', gererRequete)`. The participant ID must match `package.json → contributes.chatParticipants[].id`.

## Key conventions

- **French throughout**: all variable names, comments, UI strings, and markdown responses are in French. Keep this consistent.
- **No LLM model calls**: the agent does not use `request.model` or `vscode.lm`. It is purely menu-driven — responses are hardcoded markdown.
- **`stream.markdown()`** is the only output method used. Never use `stream.push()` or other stream methods.
- **PowerShell assumed**: all terminal commands are written for PowerShell (use `Set-Location`, `$LASTEXITCODE`, `Write-Host` with `-ForegroundColor`, etc.). The extension targets Windows Power Platform developers.
- **`pac` CLI and `npx power-apps`**: these are the two external CLIs orchestrated. They are expected to be available on the user's PATH.
- **`power.config.json`** in the workspace root is the convention for server URL configuration (read by `lireUrlServeur()`).
- ESLint rules enforce: `eqeqeq`, `curly`, `semi`, `no-throw-literal`, and `@typescript-eslint/naming-convention` (imports: camelCase or PascalCase).
- `vscode` is externalized in webpack — never bundle it.
