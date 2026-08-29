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

The interface accepts individual `.js`, `.mjs`, `.cjs`, and `.jsx` files, a complete folder with preserved relative paths, or a pasted JavaScript snippet. Folder rules can skip `node_modules`, `dist`, `build`, and `coverage`. Optional category rules can exclude tests/specs, fixtures, vendor code, benchmarks, and maintenance scripts. Every included method is assigned a reproducible `CODE_CATEGORY` value.

## Method-level metrics

Every function declaration, function expression, arrow function, object method, and ES6 class method becomes one deterministic dataset row. Nested functions are independent rows and are excluded from their parent's AST-traversal metrics. Their declaration source remains part of the parent's physical/code line counts because it is textually inside the parent segment.

The exported metrics are:

- `LOC`: nonblank, non-comment source lines for the function or method segment; lines containing code plus a trailing comment count as code
- `SPAN_LOC`: inclusive physical source lines from the segment start to end
- `COMMENT_LINES`: nonblank lines containing only comment text
- `BLANK_LINES`: blank or whitespace-only lines
- `CYCLO`: extended McCabe-style cyclomatic complexity with a baseline of 1; JavaScript short-circuit `&&` and `||` operators contribute execution paths
- `MAXNESTING`: maximum control-structure nesting depth; an `else if` chain remains at one nesting level
- `NOP`: number of parameters
- `NOLV`: number of local bindings introduced by variable declarations and catch parameters; destructured identifiers are counted individually
- `CONDOPS_MAX`: maximum relevant operator count in a single condition
- `COND_NESTING`: maximum nesting depth of Boolean condition-bearing constructs; switch case labels are excluded and `else if` remains at the parent level
- `NUM_CONDITIONS`: number of explicit condition sites
- `ATD`: number of distinct local and foreign `(inferred object type, property)` coupling tuples
- `ATFD`: number of distinct foreign `(inferred object type, property)` coupling tuples
- `LOCAL_ACCESS_COUNT`: exact numerator used for LAA and the Feature Envy locality comparison
- `LAA`: distinct local tuples divided by all distinct coupling tuples; `1.0` when there are no accesses
- `LAA_EXACT`: reproducible `LOCAL_ACCESS_COUNT/ATD` fraction (`1/1` when there are no accesses)
- `FDP`: number of distinct inferred foreign provider types
- `FOREIGN_PROVIDERS`: sorted inferred foreign provider types
- `COUPLING_TUPLES`: sorted, explicit `L:type#property` and `F:type#property` tuples used to reproduce ATD, ATFD, LAA, and FDP
- `TYPE_INFERENCE_COVERAGE`: resolved coupling tuples divided by all coupling tuples; `1.0` when there are no accesses
- `UNKNOWN_ACCESS_COUNT`: number of distinct foreign tuples whose base type could not be resolved
- `FE_INFERENCE_MODE`: versioned inference provenance (`project-static-object-type-inference-v2`)
- `FE_MAX_ITERATIONS`: deterministic fixed-point iteration bound (`12`)
- `FE_TYPE_SET_LIMIT`: maximum concrete types retained in one inferred type set before adding `unknown:widened` (`12`)
- `FE_SCOPE`: inference scope (`project`)
- `FE_INDEXED_FILE_COUNT`: all successfully parsed project files indexed by the inference model
- `FE_BATCH_ID`, `FE_BATCH_FILE_COUNT`, and `FE_BATCH_SIZE_LIMIT`: backward-compatible provenance columns; project-wide exports use `P-0001`, the project file count, and `0` (unbounded)
- `FOREIGN_MEMBER_CALLS`: occurrence count of direct foreign member calls; calls also contribute their distinct property tuple to ATD/ATFD
- `FOREIGN_CALL_PROVIDERS`: sorted inferred foreign provider types used by direct member calls

## Detection rules

Defaults are visible and editable in the interface:

- Long Method: `LOC >= 31`, where `LOC` excludes blank and comment-only lines
- Optional compound Long Method: `LOC >= 31 AND (CYCLO >= 10 OR MAXNESTING >= 5)`
- Complex Method: `CYCLO >= 10`
- Complex Conditional: `CONDOPS_MAX >= 5`
- Feature Envy: `ATFD > FEW AND 3 × LOCAL_ACCESS_COUNT < ATD AND FDP <= FEW`, with `FEW = 3`. The integer comparison is exactly equivalent to `LAA < 1/3` without decimal-rounding ambiguity.

### Feature Envy inference methodology

Feature Envy follows the ATFD/LAA/FDP rule used in *Determining Dynamic Coupling in JavaScript Using Object Type Inference* (Nicolay et al., SCAM 2013), adapted to deterministic in-browser static analysis:

- Files are sorted by relative path and indexed into one deterministic project-wide inference model. Object types are inferred across successfully parsed files from allocation sites, object and array literals, constructor calls, ES classes, constructor/prototype assignments, imports/`require`, aliases, property assignments, return values, and resolvable call-site argument flow.
- Class `extends` and `Object.create(Parent.prototype)` relationships build prototype hierarchies.
- An access is local when its inferred base type belongs to the active `this` hierarchy. Syntactic `this`/`super` accesses remain local. This means an access such as `other.x` can be local when `other` is inferred as the same type as `this`.
- ATD and ATFD count **distinct** `(inferred type, property, locality)` coupling tuples, not repeated AST occurrences. FDP counts distinct foreign inferred types, not variable names.
- Direct member calls are coupling accesses, matching the paper's treatment of member expressions in operator position. `FOREIGN_MEMBER_CALLS` remains as an additional occurrence diagnostic.
- Computed array indices are normalized to one `IDX` property per inferred array type.
- A statically identifiable first property addition is excluded; a later read or update of that property is eligible coupling.
- Nested functions are analyzed independently and never add Feature Envy tuples to their parent.
- The fixed-point solve is bounded to 12 iterations. Each inferred type set retains up to 12 deterministic concrete types and then adds `unknown:widened`; widened tuples lower `TYPE_INFERENCE_COVERAGE` and contribute to `UNKNOWN_ACCESS_COUNT`.

The paper uses JIPDA abstract interpretation and runtime-address abstractions. That full interpreter is not suitable for the modern, large, JSX-capable corpus handled by this browser tool, and the paper itself reports limitations on real-world programs. This application therefore labels its method as `project-static-object-type-inference-v2`, exports project provenance, inference coverage, unresolved counts, and every coupling tuple for expert validation. It must be described in research outputs as a **paper-inspired project-wide static object-type-inference approximation**, not as a reproduction of JIPDA.

## CSV schema

CSV exports use one row per method and a fixed column order:

```text
ID,PROJECT,FILE,CODE_CATEGORY,FUNCTION,FUNCTION_TYPE,START_LINE,END_LINE,LOC,SPAN_LOC,COMMENT_LINES,BLANK_LINES,CYCLO,MAXNESTING,NOP,NOLV,CONDOPS_MAX,COND_NESTING,NUM_CONDITIONS,ATD,ATFD,LOCAL_ACCESS_COUNT,LAA,LAA_EXACT,FDP,FOREIGN_PROVIDERS,COUPLING_TUPLES,TYPE_INFERENCE_COVERAGE,UNKNOWN_ACCESS_COUNT,FE_INFERENCE_MODE,FE_MAX_ITERATIONS,FE_TYPE_SET_LIMIT,FE_BATCH_ID,FE_BATCH_FILE_COUNT,FE_BATCH_SIZE_LIMIT,FE_SCOPE,FE_INDEXED_FILE_COUNT,FOREIGN_MEMBER_CALLS,FOREIGN_CALL_PROVIDERS,CSV_SCHEMA_VERSION,DETECTOR_VERSION,PARSER_VERSION,FILES_SELECTED,FILES_ANALYZED,PARSE_FAILURE_COUNT,LONG_LOC_THRESHOLD,LONG_COMPOUND_ENABLED,LONG_CYCLO_THRESHOLD,LONG_NESTING_THRESHOLD,COMPLEX_CYCLO_THRESHOLD,CONDITIONAL_OPS_THRESHOLD,FEW_THRESHOLD,is_long_method,is_complex_method,is_complex_conditional,is_feature_envy,is_smelly,SMELL_COUNT,SMELL_TYPES
```

Binary labels use `0` and `1`. Multi-valued providers and smell types use `|`. Values containing commas, quotes, or line breaks are escaped according to CSV conventions. Each dataset row repeats the schema version, detector version, parser version, file counts, parse-failure count, and active thresholds so the labels can be reproduced independently. Parsing failures can also be exported as a separate deterministic CSV manifest.

## Reliability checks

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The tests cover duplicate avoidance, nested-function isolation, JSX, optional chaining, empty and anonymous functions, metric calculations, distinct coupling tuples, call-site parameter flow, `this`-hierarchy locality, aliases, array-index normalization, property additions/updates, inference uncertainty, deterministic IDs, the browser-local Acorn bundle, and CSV escaping.
