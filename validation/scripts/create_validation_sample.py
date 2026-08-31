#!/usr/bin/env python3
"""Create a deterministic, method-level validation pilot from a detector CSV.

The script keeps the source dataset unchanged and writes four reproducibility
artifacts: a file exclusion manifest, a selected-method sampling manifest, an
admin pilot CSV with detector metrics, and a blinded JSON file for the browser
validation interface.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable


SUPPORTED_EXTENSIONS = {".js", ".jsx", ".mjs", ".cjs"}
IGNORED_DIRECTORIES = {"node_modules", "dist", "build", "coverage"}
EXAMPLE_DIRECTORIES = {
    "demo",
    "demos",
    "example",
    "examples",
    "playground",
    "sample",
    "samples",
    "debug",
}
GENERATED_DIRECTORIES = {
    "compiled",
    "generated",
    "third-party",
    "third_party",
    "externals",
}
KNOWN_EXTERNAL_PREFIXES = (
    "jspaint/lib/",
    "maptalks.js/packages/transcoders.crn/src/lib/",
    "maptalks.js/packages/transcoders.draco/src/lib/",
    "maptalks.js/packages/transcoders.ktx2/src/lib/",
    "xeokit-sdk/typedocs/assets/",
)
KNOWN_PARSE_FAILURES = {
    "atom/packages/welcome/lib/guide-view.js",
    "atom/spec/fixtures/babel/flow-comment.js",
    "atom/spec/fixtures/babel/flow-slash-comment.js",
    "atom/spec/fixtures/indentation/jsx.jsx",
    "atom/spec/fixtures/indentation/objects_and_array.js",
}

ROLE_QUOTAS = (
    ("positive_long_method", 15),
    ("positive_complex_method", 15),
    ("positive_complex_conditional", 15),
    ("positive_feature_envy", 15),
    ("boundary_long_method", 5),
    ("boundary_complex_method", 5),
    ("boundary_complex_conditional", 5),
    ("boundary_feature_envy", 5),
    ("project_balanced_random", 40),
)

COMPACT_FIELDS = (
    "ID",
    "PROJECT",
    "FILE",
    "CODE_CATEGORY",
    "FUNCTION",
    "FUNCTION_TYPE",
    "START_LINE",
    "END_LINE",
    "LOC",
    "SPAN_LOC",
    "COMMENT_LINES",
    "BLANK_LINES",
    "DELIMITER_LINES",
    "CYCLO",
    "MAXNESTING",
    "NOP",
    "NOLV",
    "CONDOPS_MAX",
    "LOGICAL_OPS_MAX",
    "COND_NESTING",
    "NUM_CONDITIONS",
    "ATD",
    "ATFD",
    "LOCAL_ACCESS_COUNT",
    "LAA",
    "LAA_EXACT",
    "FDP",
    "FOREIGN_PROVIDERS",
    "TYPE_INFERENCE_COVERAGE",
    "UNKNOWN_ACCESS_COUNT",
    "CSV_SCHEMA_VERSION",
    "DETECTOR_VERSION",
    "PARSER_VERSION",
    "LONG_LOC_THRESHOLD",
    "LONG_COMPOUND_ENABLED",
    "LONG_CYCLO_THRESHOLD",
    "LONG_NESTING_THRESHOLD",
    "COMPLEX_CYCLO_THRESHOLD",
    "CONDITIONAL_OPS_THRESHOLD",
    "CONDITIONAL_LOGICAL_OPS_MAX_ALLOWED",
    "FEW_THRESHOLD",
    "is_long_method",
    "is_complex_method",
    "is_complex_conditional",
    "is_complex_conditional_sonar",
    "is_feature_envy",
    "is_smelly",
    "SMELL_COUNT",
    "SMELL_TYPES",
)

PILOT_FIELDS = (
    "SAMPLE_ID",
    "DATASET_METHOD_ID",
    "PROJECT",
    "DATASET_PROJECT",
    "FILE",
    "DATASET_FILE",
    "FUNCTION",
    "FUNCTION_TYPE",
    "START_LINE",
    "END_LINE",
    "CONTEXT_START_LINE",
    "CONTEXT_END_LINE",
    "SOURCE_SEGMENT",
    "SOURCE_CONTEXT",
    "SOURCE_FILE_SHA256",
    "SEGMENT_SHA256",
    "SAMPLE_ROLE",
    "SAMPLING_STRATUM",
    "STRATUM_POOL_N_PROJECT",
    "STRATUM_SELECTED_N_PROJECT",
    "CONDITIONAL_INCLUSION_PROBABILITY",
    "SAMPLING_SEED",
    "DATASET_SHA256",
    "GIT_COMMIT",
    "CSV_SCHEMA_VERSION",
    "DETECTOR_VERSION",
    "PARSER_VERSION",
    "LOC",
    "SPAN_LOC",
    "COMMENT_LINES",
    "BLANK_LINES",
    "DELIMITER_LINES",
    "CYCLO",
    "MAXNESTING",
    "NOP",
    "NOLV",
    "CONDOPS_MAX",
    "LOGICAL_OPS_MAX",
    "COND_NESTING",
    "NUM_CONDITIONS",
    "ATD",
    "ATFD",
    "LOCAL_ACCESS_COUNT",
    "LAA",
    "LAA_EXACT",
    "FDP",
    "FOREIGN_PROVIDERS",
    "TYPE_INFERENCE_COVERAGE",
    "UNKNOWN_ACCESS_COUNT",
    "is_long_method",
    "is_complex_method",
    "is_complex_conditional",
    "is_complex_conditional_sonar",
    "is_feature_envy",
    "is_smelly",
    "SMELL_COUNT",
    "SMELL_TYPES",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="Detector CSV export")
    parser.add_argument("--source-root", type=Path, required=True, help="Root of the analyzed source tree")
    parser.add_argument("--output-dir", type=Path, default=Path("validation/data"))
    parser.add_argument(
        "--public-json",
        type=Path,
        default=Path("public/validation/pilot-sample.json"),
        help="Blinded browser payload",
    )
    parser.add_argument("--pilot-size", type=int, default=120)
    parser.add_argument("--seed", default="UPM-JS-VALIDATION-2026")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_rank(seed: str, role: str, value: str) -> str:
    return hashlib.sha256(f"{seed}|{role}|{value}".encode("utf-8")).hexdigest()


def normalize_dataset_file(value: str, source_root: Path) -> str:
    parts = list(PurePosixPath(value.replace("\\", "/")).parts)
    if parts and parts[0].lower() == source_root.name.lower():
        parts = parts[1:]
    return "/".join(parts)


def project_from_relative_path(relative_path: str) -> str:
    parts = PurePosixPath(relative_path).parts
    return parts[0] if parts else "unknown-project"


def classify_source_category(relative_path: str) -> str:
    normalized = relative_path.replace("\\", "/").lower()
    parts = normalized.split("/")
    file_name = parts[-1] if parts else normalized
    if "fixtures" in parts or "fixture" in parts:
        return "fixture"
    if "vendor" in parts or "vendors" in parts:
        return "vendor"
    if "benchmarks" in parts or "benchmark" in parts or ".bench." in file_name:
        return "benchmark"
    if any(part in {"spec", "specs", "test", "tests", "__tests__"} for part in parts):
        return "test"
    if any(file_name.endswith(suffix) for suffix in (".spec.js", ".spec.jsx", ".test.js", ".test.jsx")):
        return "test"
    if "script" in parts or "scripts" in parts:
        return "maintenance"
    return "production"


def exclusion_for(relative_path: str, method_count: int) -> tuple[str, str, str]:
    normalized = relative_path.lower()
    parts = set(PurePosixPath(normalized).parts)
    file_name = PurePosixPath(normalized).name
    category = classify_source_category(relative_path)

    if normalized in KNOWN_PARSE_FAILURES:
        return "EXCLUDE", "PARSE_FAILURE", "The detector reported a syntax/parser failure for this file."
    if method_count == 0:
        return "EXCLUDE", "NO_METHODS", "No method/function rows were produced for this file."
    if category != "production":
        return "EXCLUDE", f"CATEGORY_{category.upper()}", f"Source category is {category}, not production."
    if any(normalized.startswith(prefix) for prefix in KNOWN_EXTERNAL_PREFIXES):
        return "EXCLUDE", "KNOWN_THIRD_PARTY_TREE", "Project-specific path contains a vendored runtime or generated documentation asset."
    if parts.intersection(GENERATED_DIRECTORIES):
        return "EXCLUDE", "GENERATED_OR_EXTERNAL", "Path indicates generated, compiled, or external code."
    if (
        ".min." in file_name
        or ".bundle." in file_name
        or file_name.endswith("-bundle.js")
        or file_name.endswith(".bundled.js")
        or "generated" in file_name
    ):
        return "EXCLUDE", "GENERATED_OR_BUNDLED", "Filename indicates generated, minified, or bundled code."
    if parts.intersection(EXAMPLE_DIRECTORIES):
        return "EXCLUDE", "EXAMPLE_OR_DEMO", "Path indicates sample, example, demo, playground, or debug code."
    return "INCLUDE", "PRODUCTION_SOURCE", "Eligible production-source file."


def has_minified_layout(path: Path) -> bool:
    """Flag review-hostile generated layouts without parsing or mutable heuristics."""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return any(len(line) > 5000 for line in text.splitlines())


def iter_source_files(source_root: Path) -> Iterable[Path]:
    for path in source_root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        relative_parts = {part.lower() for part in path.relative_to(source_root).parts[:-1]}
        if relative_parts.intersection(IGNORED_DIRECTORIES):
            continue
        yield path


def read_dataset(dataset: Path, source_root: Path) -> tuple[list[dict[str, str]], Counter[str], Counter[tuple[str, ...]], dict[str, str]]:
    rows: list[dict[str, str]] = []
    method_counts: Counter[str] = Counter()
    identity_counts: Counter[tuple[str, ...]] = Counter()
    metadata: dict[str, str] = {}

    with dataset.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [field for field in COMPACT_FIELDS if field not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"Dataset is missing required columns: {', '.join(missing)}")
        for raw in reader:
            compact = {field: raw.get(field, "") for field in COMPACT_FIELDS}
            relative_path = normalize_dataset_file(compact["FILE"], source_root)
            compact["SOURCE_RELATIVE_PATH"] = relative_path
            compact["SOURCE_PROJECT"] = project_from_relative_path(relative_path)
            rows.append(compact)
            method_counts[relative_path] += 1
            identity_counts[(
                relative_path,
                compact["FUNCTION"],
                compact["FUNCTION_TYPE"],
                compact["START_LINE"],
                compact["END_LINE"],
            )] += 1
            if not metadata:
                metadata = {
                    "csvSchemaVersion": compact["CSV_SCHEMA_VERSION"],
                    "detectorVersion": compact["DETECTOR_VERSION"],
                    "parserVersion": compact["PARSER_VERSION"],
                    "longLocThreshold": compact["LONG_LOC_THRESHOLD"],
                    "longCompoundEnabled": compact["LONG_COMPOUND_ENABLED"],
                    "longCycloThreshold": compact["LONG_CYCLO_THRESHOLD"],
                    "longNestingThreshold": compact["LONG_NESTING_THRESHOLD"],
                    "complexCycloThreshold": compact["COMPLEX_CYCLO_THRESHOLD"],
                    "conditionalOpsThreshold": compact["CONDITIONAL_OPS_THRESHOLD"],
                    "conditionalLogicalOpsMaxAllowed": compact["CONDITIONAL_LOGICAL_OPS_MAX_ALLOWED"],
                    "fewThreshold": compact["FEW_THRESHOLD"],
                }
    return rows, method_counts, identity_counts, metadata


def write_csv(path: Path, fieldnames: Iterable[str], rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(fieldnames), extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def as_int(row: dict[str, str], field: str) -> int:
    try:
        return int(row.get(field, "0") or 0)
    except ValueError:
        return 0


def as_float(row: dict[str, str], field: str) -> float:
    try:
        return float(row.get(field, "0") or 0)
    except ValueError:
        return 0.0


def choose_balanced(
    candidates: list[dict[str, str]],
    quota: int,
    seed: str,
    role: str,
    score: Callable[[dict[str, str]], float] | None = None,
) -> tuple[list[dict[str, str]], Counter[str], Counter[str]]:
    groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in candidates:
        groups[row["SOURCE_PROJECT"]].append(row)
    population_by_project = Counter({project: len(values) for project, values in groups.items()})
    for project, values in groups.items():
        values.sort(key=lambda row: (
            score(row) if score else 0,
            stable_rank(seed, role, row["ID"]),
        ))

    project_order = sorted(groups, key=lambda project: stable_rank(seed, role, project))
    selected: list[dict[str, str]] = []
    while len(selected) < quota and project_order:
        next_round: list[str] = []
        for project in project_order:
            if groups[project] and len(selected) < quota:
                selected.append(groups[project].pop(0))
            if groups[project]:
                next_round.append(project)
        project_order = next_round

    if len(selected) != quota:
        raise RuntimeError(f"Sampling role {role!r} requested {quota} rows but only {len(selected)} were available.")
    selected_by_project = Counter(row["SOURCE_PROJECT"] for row in selected)
    return selected, population_by_project, selected_by_project


def candidate_pool(role: str, rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], Callable[[dict[str, str]], float] | None]:
    if role == "positive_long_method":
        return [row for row in rows if row["is_long_method"] == "1"], None
    if role == "positive_complex_method":
        return [row for row in rows if row["is_complex_method"] == "1"], None
    if role == "positive_complex_conditional":
        return [row for row in rows if row["is_complex_conditional"] == "1"], None
    if role == "positive_feature_envy":
        return [row for row in rows if row["is_feature_envy"] == "1"], None
    if role == "boundary_long_method":
        pool = [row for row in rows if row["is_long_method"] == "0" and as_int(row, "LOC") >= 20]
        return pool, lambda row: abs(31 - as_int(row, "LOC"))
    if role == "boundary_complex_method":
        pool = [row for row in rows if row["is_complex_method"] == "0" and as_int(row, "CYCLO") >= 5]
        return pool, lambda row: abs(10 - as_int(row, "CYCLO"))
    if role == "boundary_complex_conditional":
        pool = [row for row in rows if row["is_complex_conditional"] == "0" and as_int(row, "CONDOPS_MAX") >= 2]
        return pool, lambda row: abs(5 - as_int(row, "CONDOPS_MAX"))
    if role == "boundary_feature_envy":
        pool = [
            row for row in rows
            if row["is_feature_envy"] == "0"
            and as_int(row, "ATD") > 0
            and as_int(row, "ATFD") >= 2
        ]
        return pool, lambda row: (
            abs(4 - as_int(row, "ATFD"))
            + abs((1 / 3) - as_float(row, "LAA")) * 6
            + abs(3 - as_int(row, "FDP"))
        )
    if role == "project_balanced_random":
        return rows, None
    raise ValueError(f"Unknown sampling role: {role}")


def current_git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def main() -> None:
    args = parse_args()
    dataset = args.dataset.resolve()
    source_root = args.source_root.resolve()
    if not dataset.is_file():
        raise FileNotFoundError(dataset)
    if not source_root.is_dir():
        raise NotADirectoryError(source_root)
    expected_size = sum(quota for _, quota in ROLE_QUOTAS)
    if args.pilot_size != expected_size:
        raise ValueError(f"This protocol defines {expected_size} pilot rows; received --pilot-size {args.pilot_size}.")

    dataset_sha256 = sha256_file(dataset)
    git_commit = current_git_commit()
    rows, method_counts, identity_counts, metadata = read_dataset(dataset, source_root)

    manifest_rows: list[dict[str, Any]] = []
    decision_by_file: dict[str, str] = {}
    for path in sorted(iter_source_files(source_root), key=lambda item: item.as_posix().lower()):
        relative_path = path.relative_to(source_root).as_posix()
        category = classify_source_category(relative_path)
        decision, rule_id, reason = exclusion_for(relative_path, method_counts[relative_path])
        if decision == "INCLUDE" and has_minified_layout(path):
            decision = "EXCLUDE"
            rule_id = "MINIFIED_LAYOUT"
            reason = "At least one physical line exceeds 5,000 characters, indicating bundled/minified code."
        decision_by_file[relative_path] = decision
        manifest_rows.append({
            "FILE": relative_path,
            "PROJECT": project_from_relative_path(relative_path),
            "CODE_CATEGORY": category,
            "METHOD_COUNT": method_counts[relative_path],
            "DECISION": decision,
            "RULE_ID": rule_id,
            "REASON": reason,
        })

    eligible: list[dict[str, str]] = []
    row_exclusion_counts: Counter[str] = Counter()
    for row in rows:
        relative_path = row["SOURCE_RELATIVE_PATH"]
        if decision_by_file.get(relative_path) != "INCLUDE":
            row_exclusion_counts["FILE_EXCLUDED"] += 1
            continue
        identity = (
            relative_path,
            row["FUNCTION"],
            row["FUNCTION_TYPE"],
            row["START_LINE"],
            row["END_LINE"],
        )
        if identity_counts[identity] > 1:
            row_exclusion_counts["AMBIGUOUS_LINE_IDENTITY"] += 1
            continue
        if not (source_root / relative_path).is_file():
            row_exclusion_counts["SOURCE_FILE_UNAVAILABLE"] += 1
            continue
        eligible.append(row)

    selected_ids: set[str] = set()
    selected_records: list[dict[str, Any]] = []
    role_population_counts: dict[str, int] = {}
    for role, quota in ROLE_QUOTAS:
        remaining = [row for row in eligible if row["ID"] not in selected_ids]
        pool, score = candidate_pool(role, remaining)
        role_population_counts[role] = len(pool)
        chosen, population_by_project, selected_by_project = choose_balanced(pool, quota, args.seed, role, score)
        for row in chosen:
            selected_ids.add(row["ID"])
            project = row["SOURCE_PROJECT"]
            population = population_by_project[project]
            selected_count = selected_by_project[project]
            selected_records.append({
                **row,
                "SAMPLE_ROLE": role,
                "SAMPLING_STRATUM": f"{role}|{project}",
                "STRATUM_POOL_N_PROJECT": population,
                "STRATUM_SELECTED_N_PROJECT": selected_count,
                "CONDITIONAL_INCLUSION_PROBABILITY": f"{selected_count / population:.10f}",
            })

    selected_records.sort(key=lambda row: stable_rank(args.seed, "presentation", row["ID"]))
    source_cache: dict[str, tuple[bytes, str, list[str]]] = {}
    pilot_rows: list[dict[str, Any]] = []
    blinded_samples: list[dict[str, Any]] = []
    for index, row in enumerate(selected_records, start=1):
        relative_path = row["SOURCE_RELATIVE_PATH"]
        if relative_path not in source_cache:
            source_bytes = (source_root / relative_path).read_bytes()
            source_text = source_bytes.decode("utf-8-sig", errors="replace")
            source_cache[relative_path] = (
                source_bytes,
                hashlib.sha256(source_bytes).hexdigest(),
                source_text.splitlines(keepends=True),
            )
        _, file_sha256, source_lines = source_cache[relative_path]
        start_line = as_int(row, "START_LINE")
        end_line = as_int(row, "END_LINE")
        context_start = max(1, start_line - 2)
        context_end = min(len(source_lines), end_line + 2)
        segment = "".join(source_lines[start_line - 1:end_line])
        context = "".join(source_lines[context_start - 1:context_end])
        segment_sha256 = hashlib.sha256(segment.encode("utf-8")).hexdigest()
        sample_id = f"V-{index:04d}"
        pilot_row: dict[str, Any] = {
            **row,
            "SAMPLE_ID": sample_id,
            "DATASET_METHOD_ID": row["ID"],
            "PROJECT": row["SOURCE_PROJECT"],
            "DATASET_PROJECT": row["PROJECT"],
            "FILE": relative_path,
            "DATASET_FILE": row["FILE"],
            "CONTEXT_START_LINE": context_start,
            "CONTEXT_END_LINE": context_end,
            "SOURCE_SEGMENT": segment,
            "SOURCE_CONTEXT": context,
            "SOURCE_FILE_SHA256": file_sha256,
            "SEGMENT_SHA256": segment_sha256,
            "SAMPLING_SEED": args.seed,
            "DATASET_SHA256": dataset_sha256,
            "GIT_COMMIT": git_commit,
        }
        pilot_rows.append(pilot_row)
        blinded_samples.append({
            "sampleId": sample_id,
            "datasetMethodId": row["ID"],
            "project": row["SOURCE_PROJECT"],
            "file": relative_path,
            "functionName": row["FUNCTION"],
            "functionType": row["FUNCTION_TYPE"],
            "startLine": start_line,
            "endLine": end_line,
            "contextStartLine": context_start,
            "contextEndLine": context_end,
            "sourceSegment": segment,
            "sourceContext": context,
            "segmentSha256": segment_sha256,
        })

    sampling_manifest_fields = (
        "SAMPLE_ID",
        "DATASET_METHOD_ID",
        "PROJECT",
        "FILE",
        "FUNCTION",
        "FUNCTION_TYPE",
        "START_LINE",
        "END_LINE",
        "SAMPLE_ROLE",
        "SAMPLING_STRATUM",
        "STRATUM_POOL_N_PROJECT",
        "STRATUM_SELECTED_N_PROJECT",
        "CONDITIONAL_INCLUSION_PROBABILITY",
        "SAMPLING_SEED",
        "DATASET_SHA256",
        "SEGMENT_SHA256",
        "CSV_SCHEMA_VERSION",
        "DETECTOR_VERSION",
        "PARSER_VERSION",
    )
    write_csv(args.output_dir / "exclusion-manifest.csv", (
        "FILE", "PROJECT", "CODE_CATEGORY", "METHOD_COUNT", "DECISION", "RULE_ID", "REASON",
    ), manifest_rows)
    write_csv(args.output_dir / "sampling-manifest.csv", sampling_manifest_fields, pilot_rows)
    write_csv(args.output_dir / "pilot-sample.csv", PILOT_FIELDS, pilot_rows)

    args.public_json.parent.mkdir(parents=True, exist_ok=True)
    args.public_json.write_text(json.dumps({
        "study": {
            "title": "UPM JavaScript Code Smell Validation Pilot",
            "pilotSize": len(blinded_samples),
            "samplingSeed": args.seed,
            "datasetSha256": dataset_sha256,
            "csvSchemaVersion": metadata.get("csvSchemaVersion", "unknown"),
            "detectorVersion": metadata.get("detectorVersion", "unknown"),
            "blinded": True,
        },
        "samples": blinded_samples,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = {
        "protocolVersion": "1.0.0",
        "samplingSeed": args.seed,
        "pilotSize": len(pilot_rows),
        "dataset": {
            "fileName": dataset.name,
            "sha256": dataset_sha256,
            "rowCount": len(rows),
            **metadata,
        },
        "source": {
            "rootName": source_root.name,
            "selectedFileCount": len(manifest_rows),
            "ignoredDirectories": sorted(IGNORED_DIRECTORIES),
        },
        "gitCommit": git_commit,
        "fileDecisions": dict(sorted(Counter(row["DECISION"] for row in manifest_rows).items())),
        "fileExclusionRules": dict(sorted(Counter(row["RULE_ID"] for row in manifest_rows).items())),
        "methodPopulation": {
            "datasetRows": len(rows),
            "eligibleRows": len(eligible),
            "methodExclusions": dict(sorted(row_exclusion_counts.items())),
        },
        "samplingRolePopulation": role_population_counts,
        "samplingRoleSelected": dict(sorted(Counter(row["SAMPLE_ROLE"] for row in pilot_rows).items())),
        "selectedProjects": dict(sorted(Counter(row["PROJECT"] for row in pilot_rows).items())),
        "selectedFunctionTypes": dict(sorted(Counter(row["FUNCTION_TYPE"] for row in pilot_rows).items())),
        "thresholdSnapshot": metadata,
    }
    (args.output_dir / "sampling-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "pilotSize": len(pilot_rows),
        "eligibleRows": len(eligible),
        "includedFiles": sum(row["DECISION"] == "INCLUDE" for row in manifest_rows),
        "datasetSha256": dataset_sha256,
        "outputDir": str(args.output_dir.resolve()),
    }, indent=2))


if __name__ == "__main__":
    main()
