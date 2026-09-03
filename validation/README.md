# JavaScript Code Smell Validation Workspace

This directory contains the blinded manual-validation phase for the JavaScript
code-smell dataset. It is separate from the detector so that expert judgments
are not influenced by detector metrics or labels.

## Pilot design

- **Pilot size:** 120 unique methods/functions.
- **Unit of judgment:** one method/function; all four smells are judged
  independently.
- **Choices:** `Present`, `Absent`, or `Uncertain / insufficient context`.
- **Blinding:** detector metrics, sampling strata, and detector labels are not
  included in the browser payload.
- **Coverage:** 40 project-balanced random methods, 15 positive candidates per
  smell, and 5 near-threshold candidates per smell.
- **Source population:** production source only. Tests, fixtures, examples,
  demos, benchmarks, maintenance scripts, generated/bundled code, parse
  failures, and files with no detected methods are recorded and excluded.
- **Minified-layout safeguard:** files containing a physical line longer than
  5,000 characters and documented project-specific third-party trees are
  excluded as review-hostile generated/vendor code.
- **Ambiguous rows:** methods that cannot be uniquely identified by the current
  CSV's file/name/type/line tuple are excluded from the pilot. A later detector
  schema should export start/end columns or byte offsets.

The pilot is intended to calibrate the guideline, interface, and inter-rater
agreement. It is not the final validation sample. After the pilot, freeze the
revised protocol and draw the main sample (recommended starting range:
1,200–1,500 unique methods, subject to the pilot's precision analysis).

## Validator eligibility and declaration

Before viewing any sample, each validator completes declaration version
`1.0.0`. The entry page records an anonymized validator ID, categorical
JavaScript experience, code-review frequency, code-smell familiarity, the
accepted declaration IDs, and an ISO timestamp. Validators must confirm that
they can assess JavaScript method-level code, will work independently and
blindly, will handle source samples confidentially, and will use `Uncertain`
with a note when essential context is missing.

This is an operational research declaration, not a substitute for the
participant information sheet, informed-consent form, ethics approval, or
withdrawal procedure required by the applicable UPM protocol. The final study
protocol should state explicit inclusion/exclusion criteria and preserve the
approved participant materials separately.

## Reproduce the pilot

From the repository root:

```powershell
python validation/scripts/create_validation_sample.py `
  --dataset "C:\path\to\javascript-code-smell-dataset.csv" `
  --source-root "C:\path\to\Sample" `
  --seed "UPM-JS-VALIDATION-2026"
```

The script never changes the source dataset. It writes:

- `data/exclusion-manifest.csv` — one row per selected JavaScript file with an
  explicit include/exclude decision and reason.
- `data/sampling-manifest.csv` — the 120 selected methods, their sampling
  strata, and conditional inclusion probabilities.
- `data/pilot-sample.csv` — the administrator copy containing code segments,
  detector metrics, and detector labels.
- `data/sampling-report.json` — hashes, version/threshold snapshot, population
  counts, and sample composition.
- `public/validation/pilot-sample.json` — the private blinded payload that the
  validator selects in local mode or the administrator imports into the
  hosted study.

The generated `validation/data/` directory and blinded JSON payload are
ignored by Git. Keep them in private research storage and distribute them to
authorized validators through an approved secure channel; never commit them
to the public website repository.

The same dataset, source tree, seed, and repository commit produce the same
selection and sample order.

## Run the validation website

Use the repository's normal development command and open `/validation/`:

```powershell
pnpm dev
```

When no backend variables are present, the site runs in **local pilot mode**.
The validator first selects the private blinded JSON payload, then creates or
accepts an anonymized validator ID, supplies categorical experience metadata,
and accepts the versioned participation declaration. The file is read only in
the browser, progress is stored on that device, and annotations can be exported
as an append-only CSV. Declaration version, acceptance time, and experience
categories are repeated on each exported annotation row for auditability. This
mode is useful for testing and offline annotation.

For a multi-validator study, create a Supabase project, run
`database/schema.sql`, import the frozen pilot rows, and set:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
```

Only the public anonymous key belongs in the browser. Never expose a Supabase
service-role key. Hosted mode uses passwordless email sign-in; the Supabase
Auth UUID is the validator's stable identifier. Configure the site URL and
redirect URL for both the local `/validation/` URL and the deployed GitHub
Pages `/validation/` URL.

## Study workflow

1. Freeze the dataset hash, source revision, detector/schema/parser versions,
   thresholds, exclusions, seed, protocol, and site version.
2. Train validators on examples that are not in the pilot or main sample.
3. Double-code every pilot method independently and while blinded.
4. Discuss disagreements only after both initial judgments are submitted.
5. Revise the guideline, then freeze it before drawing the main sample.
6. Double-code the main sample; use a third expert for adjudication.
7. Export raw annotations and consensus/adjudicated labels separately.
8. Report per-smell agreement and performance, retaining `Uncertain` as an
   explicit outcome rather than silently converting it to clean or smelly.

See [annotation-guidelines.md](protocol/annotation-guidelines.md) and
[sampling-plan.md](protocol/sampling-plan.md) for the operational protocol.
