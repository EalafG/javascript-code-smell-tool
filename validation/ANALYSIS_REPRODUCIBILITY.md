# Validation analysis and reproducibility

Open `/validation/?analysis=1`. Files remain in the browser; this feature does not upload annotation data to a server.

## Workflow

1. Import the private detector manifest and all annotation CSV files.
2. Confirm the reviewer mapping. Each source-file/exported-ID pair receives a suggested reviewer identity. Assign the same identity across files only for the same person's revisions. Reused exported IDs never silently collapse different files. Original IDs remain in the data and exports.
3. Use **Original available ratings** to reproduce the collected pilot analysis. A reference requires at least two eligible nominal ratings and a strict majority; ties remain unresolved. An ineligible report is not an Absent vote. A single objection does not automatically exclude the whole method.
4. Record researcher eligibility decisions, or import an eligibility CSV. Switch to **Researcher-screened subset** to apply them to all summary metrics and bootstrap inputs. Raw ratings are unchanged. Later include decisions revoke earlier exclusions. Imported decisions must match both dataset hash and sample ID.
5. Run bootstrap intervals, then export the reproducible analysis JSON. Export the original and screened analyses separately. Changing population, reviewer mapping, files, eligibility or bootstrap settings invalidates current intervals and cancels active work.

Eligibility CSV columns:

```csv
DATASET_SHA256,SAMPLE_ID,DISPOSITION,REASON,REVIEWER,REVIEWED_AT
dataset-hash,V-00005,exclude,Bundled library,Researcher,2026-11-19
```

Dates are ISO dates or timestamps; disposition is `include` or `exclude`. A record needs a reason and reviewer. The audit retains all entries in recorded order. Search and outcome filters only affect the visible method list, never the analysis population. Reloading the page clears the local session; export before leaving.

## Statistical policy

- Minimum two eligible ratings; strict majority of Present/Absent/Uncertain. Uncertain majority results, ties and insufficient ratings do not enter binary performance metrics. Detector predictions never vote.
- F1 is `2TP / (2TP + FP + FN)`, zero when errors exist but TP is zero, and undefined when that entire denominator is zero. Other zero-denominator estimates remain undefined, not zero.
- Agreement uses original eligible ratings on methods with at least two ratings. Krippendorff's nominal alpha supports unequal rating counts. Standard Fleiss' kappa is omitted when counts differ across units. It is not computed on majority labels.
- The bootstrap samples methods with replacement within each fixed dataset/project stratum, preserving each stratum's selected size. All smell ratings and detector predictions of a method travel together. Repeated sampled method IDs are not deduplicated. Reference/tie policies therefore remain unchanged in each replicate.
- Default: 10,000 repetitions, seed 20261117, 95% percentile intervals with linear quantile interpolation. Undefined repetitions are counted and excluded separately per metric. Empty distributions produce undefined limits. Macro-F1 requires all four smell F1 values to be defined.
- The versioned browser generator is **Mulberry32-v1**, not NumPy PCG64 used by the earlier paper analysis. Identical seeds across these generators do not produce identical replicates. Treat browser intervals as separately computed, not exact reproductions of earlier Python endpoints. The original Python evidence remains authoritative for those published endpoints.
- Intervals are exploratory and conditional on the selected projects and enriched sample. They do not correct selection bias, establish correctness of the reference labels, or support population prevalence estimates.

## Export and replay

The JSON includes input-file SHA-256 fingerprints, original IDs and ratings, confirmed reviewer mapping, detector records, optional source segments, eligibility audit, original and selected summaries, software version, Git base revision, source fingerprint, bootstrap settings, project sizes, interval estimates, defined/undefined counts and full repetitions. Treat this as private research data. Git revision alone may identify the base of an uncommitted build; use the analysis source fingerprint and corresponding source archive too.

From the matching source version, replay an export with:

```sh
node --experimental-strip-types scripts/replay-validation-analysis.ts exported-analysis.json reproduced.json
```

The script verifies the saved summary and every bootstrap repetition. It fails on unsupported versions or differences. It does not independently verify that exported annotations match the original files; retain those files alongside their recorded hashes.

The merged comparison CSV is a convenience export of the selected population; use the JSON for audit and reproduction. The eligibility-only JSON is an audit export; eligibility import currently uses CSV.

## Tests

`pnpm test`, `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build` cover the calculation layer and production build. Research-analysis tests cover reviewer collisions/revisions, minimum ratings, ties/pluralities, zero-F1 behavior, mismatched hashes, eligibility reversals, unequal-rating kappa, deterministic stratified bootstrap and undefined repetitions. A real-pilot verification was run separately without placing private annotations in the repository.
