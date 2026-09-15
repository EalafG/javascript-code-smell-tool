# Sampling Plan — Version 1.0.0 (Pilot)

## Objective

The pilot tests the annotation definitions, workflow, blinding, time burden,
and inter-rater agreement before the main validation sample is frozen. The unit
is a unique JavaScript method/function row.

## Frozen inputs

Every sample generation records:

- source dataset SHA-256;
- detector CSV schema, detector, and parser versions;
- all configured thresholds;
- source and repository revision information;
- file-level exclusion rules and decisions;
- method-level ambiguity exclusions;
- deterministic sampling seed; and
- per-stratum candidate and selected counts.

## File eligibility

The target population is authored production source. The manifest excludes:

- tests/specs and fixtures;
- vendor/external, generated, compiled, bundled, and minified code;
- examples, samples, demos, playgrounds, and debug programs;
- benchmarks and maintenance scripts;
- detector parse failures;
- files with no method/function rows; and
- dependency/build folders ignored by the detector (`node_modules`, `dist`,
  `build`, and `coverage`).

The operational minified-layout rule excludes a file when any physical line is
longer than 5,000 characters. Project-specific third-party runtime trees are
also listed explicitly in the sampling script; this prevents vendored decoders,
Firebase distributions, and generated documentation assets from being treated
as authored project methods.

Each scanned JavaScript file has one explicit decision, rule ID, and reason in
`exclusion-manifest.csv`. Rules must not be changed after sampling without
creating a new protocol version and sample.

## Method eligibility

Eligible methods must belong to an included file and have an available source
segment. Because CSV schema 2.5.0 does not contain AST byte offsets, a row is
excluded when its file, function name, function type, start line, and end line
tuple matches more than one dataset row. This prevents a
validator from receiving an ambiguous line-based segment. The count is reported
as `AMBIGUOUS_LINE_IDENTITY`.

## Pilot allocation (120 unique methods)

| Sampling role | Target |
| --- | ---: |
| Project-balanced random | 40 |
| Detector-positive Long Method | 15 |
| Detector-positive Complex Method | 15 |
| Detector-positive Complex Conditional | 15 |
| Detector-positive Feature Envy | 15 |
| Near-threshold negative Long Method | 5 |
| Near-threshold negative Complex Method | 5 |
| Near-threshold negative Complex Conditional | 5 |
| Near-threshold negative Feature Envy | 5 |

Selection is without replacement. Within each role, candidates are distributed
round-robin across available projects and ranked by a SHA-256 value derived from
the frozen seed and dataset method ID. Boundary strata rank detector-negative
candidates by distance to the relevant threshold, with the hash as the stable
tie-breaker. The final presentation order is independently hash-ranked.

The enrichment ensures enough likely positive and difficult cases to exercise
the guideline. Therefore raw pilot proportions are not estimates of population
prevalence. The manifest records conditional inclusion probabilities within
role/project strata; analyses that estimate population quantities must use an
appropriate design-based weighting strategy and must acknowledge the
sequential, without-replacement design.

## Annotation assignment

- Every pilot item should be independently assigned to at least two validators.
- Item order should differ by validator.
- Detector metrics, labels, and sampling roles remain hidden during the blind
  annotation phase.
- All four smell decisions are required; notes are required for `Uncertain`.
- A third expert adjudicates disagreements after the independent phase.

## Pilot analysis

For each smell, report:

- the full 3×3 agreement table (`Present`, `Absent`, `Uncertain`);
- percent agreement and Cohen's kappa for each validator pair;
- an agreement statistic robust to prevalence imbalance (for example Gwet's
  AC1) as a sensitivity analysis;
- uncertain rate and median annotation time; and
- disagreement themes used to revise the guideline.

After adjudication, compare detector predictions with consensus labels using
precision, recall/sensitivity, specificity, F1, balanced accuracy, and the full
confusion matrix. Report how `Uncertain` cases are handled; never silently map
them to clean or smelly.

## Transition to the main sample

Use the pilot's disagreement rate, positive yield, and annotation time to set
the main sample size and allocation. Revise and freeze the guideline before
drawing the main sample. Keep pilot and main-sample records distinguishable;
do not mix training/calibration judgments into the confirmatory validation set
without explicitly reporting that decision.
