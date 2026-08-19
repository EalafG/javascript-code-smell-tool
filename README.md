# JavaScript Code Smell Detection Tool

A local, browser-based research application for method-level detection of exactly four JavaScript code smells:

- Long Method
- Complex Method
- Complex Conditional
- Feature Envy

The application uses Acorn 8 with JSX support. All parsing, metric extraction, filtering, and CSV generation happen in the browser; source code is not sent to a server.

## Run locally

Prerequisites: Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Open the local URL printed in the terminal in Chrome or Edge. Use `pnpm build` for a production build.

## GitHub Pages deployment

The repository includes `.github/workflows/pages.yml`. Every push to `main` builds the static website and deploys the `dist` artifact through GitHub Pages.

In the GitHub repository, open **Settings → Pages** and set **Source** to **GitHub Actions**. The resulting project site is published at:

```text
https://ealafg.github.io/javascript-code-smell-tool/
```

The production build uses relative asset URLs so the local Acorn parser and UPM logo work from the GitHub Pages repository path.

## Inputs

The interface accepts individual `.js`, `.mjs`, `.cjs`, and `.jsx` files, a complete folder with preserved relative paths, or a pasted JavaScript snippet. Folder rules can skip `node_modules`, `dist`, `build`, and `coverage`.

## Method-level metrics

Every function declaration, function expression, arrow function, object method, and ES6 class method becomes one deterministic dataset row. Nested functions are independent rows and are excluded from their parent's Feature Envy metrics.

The exported metrics are:

- `LOC`: inclusive physical source lines for the function or method segment
- `CYCLO`: McCabe-style cyclomatic complexity with a baseline of 1
- `MAXNESTING`: maximum control-structure nesting depth
- `NOP`: number of parameters
- `NOLV`: number of local variable declarators
- `CONDOPS_MAX`: maximum relevant operator count in a single condition
- `COND_NESTING`: maximum nesting depth of condition-bearing constructs
- `NUM_CONDITIONS`: number of explicit condition sites
- `ATFD`: non-`this` member/property accesses
- `LAA`: local accesses divided by total local and foreign accesses; `1.0` when there are no accesses
- `FDP`: distinct foreign member-access roots
- `FOREIGN_PROVIDERS`: sorted foreign root names

## Detection rules

Defaults are visible and editable in the interface:

- Long Method: `LOC >= 31`
- Optional compound Long Method: `LOC >= 31 AND (CYCLO >= 10 OR MAXNESTING >= 5)`
- Complex Method: `CYCLO >= 10`
- Complex Conditional: `CONDOPS_MAX >= 5`
- Feature Envy: `ATFD > FEW AND LAA < 1/3 AND FDP <= FEW`, with `FEW = 3`

Feature Envy is a transparent JavaScript adaptation: every member access rooted at `this` is local, and every other member-access root is foreign. This static approximation is intentionally explicit so exported labels can be reproduced and manually validated.

## CSV schema

CSV exports use one row per method and a fixed column order:

```text
ID,PROJECT,FILE,FUNCTION,FUNCTION_TYPE,START_LINE,END_LINE,LOC,CYCLO,MAXNESTING,NOP,NOLV,CONDOPS_MAX,COND_NESTING,NUM_CONDITIONS,ATFD,LAA,FDP,FOREIGN_PROVIDERS,is_long_method,is_complex_method,is_complex_conditional,is_feature_envy,is_smelly,SMELL_COUNT,SMELL_TYPES
```

Binary labels use `0` and `1`. Multi-valued providers and smell types use `|`. Values containing commas, quotes, or line breaks are escaped according to CSV conventions.

## Reliability checks

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The tests cover duplicate avoidance, nested-function isolation, JSX, optional chaining, empty and anonymous functions, metric calculations, deterministic IDs, the browser-local Acorn bundle, and CSV escaping.
