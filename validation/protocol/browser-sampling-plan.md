# Browser Validation Sampling Protocol — Version 2.0.0

## Purpose

The detector's Validation Sample Builder creates a reproducible, method-level
sample for blind expert validation of Long Method, Complex Method, Complex
Conditional, and Feature Envy. Sampling runs locally in the browser after an
analysis. The detector does not send source code to a sampling backend.

The detector prediction is multi-label: one method may exhibit zero to four
smells. Consequently, an overall predicted-smelly percentage is not a
substitute for per-smell coverage. The builder records both the overall class
design and four independent detector-positive coverage minima.

## Presets

### Pilot calibration

- Defaults to 120 methods or the available population if smaller.
- Uses a 60% predicted-smelly target.
- Requests detector-positive coverage for each smell, multi-smell cases, and
  detector-negative boundary cases.
- Uses approximately equal project allocation.
- Intended to refine instructions, test the interface, estimate annotation
  burden, and identify disagreement before freezing the main protocol.

### Representative

- Defaults to 400 methods or the available population if smaller.
- Preserves the eligible population's natural predicted-label distribution.
- Uses project-proportional allocation without positive or boundary quotas.
- Intended for estimating validation outcomes for the defined source
  population. Sample size should ultimately follow the study's precision and
  power analysis rather than the interface default.

### Detector audit

- Defaults to 400 methods or the available population if smaller.
- Uses a 50% predicted-smelly target, per-smell minima, and clean boundary
  enrichment.
- Uses approximately equal project allocation.
- Intended for error analysis and estimating class-conditional detector
  performance, not raw population prevalence.

Every preset is editable. A changed preset becomes the recorded study design;
the generated private report is authoritative.

## Configurable design controls

The browser records:

- study title and phase;
- requested sample size and deterministic seed;
- natural or controlled predicted-smelly/clean distribution;
- project grouping and proportional or equal allocation;
- included projects plus minimum and maximum per-project counts;
- minimum detector-positive coverage for each of the four smells;
- minimum multi-smell count and detector-negative boundary percentage;
- included source categories and minimum substantive LOC;
- generated/example/empty-function exclusions and exact-source deduplication;
- whether nearby source context is included; and
- validator count and required independent annotations per method.

Automatic project grouping uses the detector's `PROJECT` field when it already
contains multiple values. It uses the first relative-path folder when there
are multiple top-level folders. For a recognized umbrella such as `Sample`,
`projects`, or `repositories`, it can use the second folder. The resolved mode
and project counts are always written to the private report and should be
checked before distribution.

## Eligibility and exclusions

Production source is the preset default. Tests, fixtures, vendor code,
benchmarks, and maintenance scripts can be included explicitly. Generated,
bundled, external, minified, example, sample, demo, playground, and debug paths
are excluded by default. Empty bodies and exact duplicate source segments are
also excluded by default.

The minimum LOC default is 1. Do not impose a global three- or five-line cutoff
without a smell-specific rationale: a short method can still contain a Complex
Conditional or Feature Envy. Every excluded detector row and its rule ID is
preserved in `private/exclusion-manifest.csv`.

Parse failures are outside the eligible method population because they produce
no method rows. Their count is frozen in the sampling report; the detector's
separate parse-failure CSV should be retained with the study archive.

## Selection and assignment

Selection is without replacement. Eligible rows are ordered by deterministic
FNV-1a ranks derived from the seed, selection role, and method ID, with method
ID as a stable tie-breaker. Quota roles are selected before the final fill, so
a method selected for one role may also contribute to other smell-coverage
counts. The presentation order is independently seed-ranked.

Project targets respect the selected proportional or equal allocation and any
feasible minimum/maximum bounds. Smell, class, or boundary constraints can
make the achieved project allocation differ from its target; this is recorded
as a design warning rather than hidden.

Validator assignment is deterministic and balanced. Each method is assigned
to the configured number of distinct validators, up to the total validator
count, and each validator receives an independently ordered JSON payload.

## Blinding and package structure

Validator JSON exposes only:

- blinded sample ID;
- sampling project, relative file path, function name/type, and line range;
- exact source segment and optional fixed two-line context on each side;
- segment SHA-256; and
- protocol/study identifiers needed by the validator website.

It does not expose detector labels, metrics, thresholds, sampling role,
stratum, population weights, or original dataset method ID. In the public
payload, `datasetMethodId` deliberately repeats the blinded sample ID for
validator-tool compatibility.

The restricted `private/` directory contains:

- `sampling-manifest.csv` — original IDs, metrics, predictions, roles,
  conditional role/project selection probabilities, and integrity metadata;
- `assignment-manifest.csv` — sample-to-validator mapping and sequence;
- `exclusion-manifest.csv` — one row per excluded detector method; and
- `sampling-report.json` — the complete configuration, population and sample
  distributions, target allocations, threshold/version snapshot, hashes, and
  warnings.

Conditional probabilities in the manifest describe the sequential
role/project pool recorded at selection time. They are not automatically a
complete marginal inclusion probability for a multi-stage enriched design.
Consult a statistician before using them for design-based prevalence
estimation.

## Reproducibility and study conduct

The report stores a SHA-256 tree fingerprint of canonical detector rows,
detector/schema/parser versions, threshold snapshot, file and parse-failure
counts, configuration, seed, and selection algorithm. Each source segment has
its own SHA-256. The same detector results, settings, and seed reproduce the
same selected records, assignments, and presentation order.

Keep generated packages out of the public repository. Freeze the package,
annotation guideline, participation materials, application version, and
analysis plan before expert annotation. Train validators on examples outside
the frozen sample; collect independent judgments before discussion; retain
`Uncertain` explicitly; and store raw annotations separately from consensus or
adjudicated labels.
