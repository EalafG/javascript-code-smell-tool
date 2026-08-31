# Annotation Guideline — Version 1.0.0 (Pilot)

## Purpose and unit of annotation

The purpose is to obtain independent expert judgments for four JavaScript code
smells at the method/function level: Long Method, Complex Method, Complex
Conditional, and Feature Envy. Annotate the displayed function, not the whole
file or class. Nested functions are separate units when separately sampled.

Judge every smell independently. A method can have none, one, or several
smells. Do not infer one smell from another; for example, a long method is not
automatically complex.

## Decision scale

- **Present** — the evidence is sufficient to conclude that the smell is
  present in the displayed method.
- **Absent** — the evidence is sufficient to conclude that the smell is not
  present.
- **Uncertain / insufficient context** — a defensible judgment cannot be made
  because context is missing, syntax is unfamiliar/ambiguous, generated code
  slipped into the sample, or the evidence is genuinely balanced.

`Uncertain` is not a midpoint between clean and smelly and must not be used as
an easy default. Add a short note explaining what information is missing.

## General decision process

1. Read the complete displayed method and its signature.
2. Identify its main responsibility and control-flow structure.
3. Inspect each condition as an expression, then inspect the method as a whole.
4. Identify accesses to `this` and to foreign object/provider roots.
5. Record all four decisions before submitting.

Detector metrics, thresholds, sampling strata, and predicted labels are hidden
during this process. Do not calculate the detector rule mechanically or inspect
the administrator CSV before annotation.

## Long Method

### Present

Choose `Present` when the method is excessively long for its responsibility and
its length materially harms comprehension, navigation, testing, or change. Look
for multiple separable phases, repeated setup/cleanup, long stretches of
low-level detail, or several responsibilities that could be named and extracted.

### Absent

Choose `Absent` when the method is short/moderate, or when a longer method is a
single coherent sequence whose extraction would not improve clarity. Data
tables, declarative configuration, and readable linear transformations should
not be labelled solely because their physical span is large.

### Important distinction

The detector uses executable LOC as a reproducible candidate rule. Manual
annotation is a semantic validation and must not reproduce a line threshold.
Comments, blank lines, and delimiter-only lines are not evidence of excessive
method responsibility.

## Complex Method

### Present

Choose `Present` when the method's overall decision/control flow is difficult to
understand or test because of many independent paths, interacting branches,
loops, exception paths, or deep structural nesting. Ask whether a reviewer can
confidently enumerate the important paths and invariants without substantial
mental simulation.

### Absent

Choose `Absent` when the method has few paths, or when branches are repetitive,
flat, and easy to scan. Length alone is not sufficient. A method can be long but
not complex, or compact but complex.

### JavaScript constructs to consider

Consider `if`/`else if`, loops, `catch`, non-default `switch` cases, ternaries,
and short-circuit decisions using `&&` or `||`. Do not count a nested function's
control flow as part of its parent method.

## Complex Conditional

### Annotation level

The dataset row and annotation are method-level, but the phenomenon occurs in
individual condition expressions. Choose `Present` for the method when **at
least one** condition in it is unusually difficult to understand.

### Present

Choose `Present` when a condition combines enough boolean/comparison operators,
negation, nesting, mixed `&&`/`||`, or embedded ternaries that its intent is not
immediately clear and a named predicate or intermediate variable would improve
understanding.

### Absent

Choose `Absent` when all conditions are simple or use familiar, cohesive guard
clauses. Several separate simple conditions do not automatically form one
Complex Conditional.

### Boundaries

Pay attention to operator precedence and negated groups. A long condition can
still be clear if it is regular and domain-cohesive; a short condition can be
complex if it mixes subtle negation or nested ternaries.

## Feature Envy

### Present

Choose `Present` when the method appears more interested in the data or behavior
of another object/provider than in its own object or local responsibility. The
foreign interaction should form a meaningful cluster suggesting that behavior
belongs closer to that provider.

Evidence includes repeated reads/calls rooted at the same foreign object,
foreign data used to make the method's decisions, and little use of `this` or
the current object's state.

### Absent

Choose `Absent` when the method mainly uses its own state, or when foreign
accesses are normal for an adapter, mapper, serializer, controller,
orchestration layer, facade, boundary object, or pure function whose explicit
parameters are its intended inputs. A single property chain is not automatically
Feature Envy merely because it contains several member accesses.

### JavaScript-specific guidance

- Treat accesses rooted at `this` as local state.
- Treat distinct parameter/import/local object roots as possible foreign
  providers.
- Consider optional chaining and computed properties when their provider is
  still clear.
- Do not include accesses inside a nested function when judging its parent.
- When dynamic dispatch, aliases, closures, or type uncertainty make ownership
  impossible to determine from the displayed segment, use `Uncertain` and note
  the missing context.

The detector records ATFD, LAA, and FDP separately and uses a rule based on
those metrics. Those values are hidden during manual annotation; the expert
judgment should evaluate the underlying design phenomenon.

## Edge cases

- **Anonymous and arrow functions:** annotate normally; their lack of a declared
  name does not make them non-functions.
- **Empty functions:** normally `Absent` for all four smells unless the displayed
  segment is not the actual function.
- **Callbacks:** judge the callback body as its own method/function unit.
- **Accessors:** concise getters/setters are normally clean; repeated foreign
  navigation can still be Feature Envy.
- **Generated/minified code:** choose `Uncertain`, add a note, and flag the sample
  for exclusion instead of judging generated structure as authored design.
- **Missing helper definitions:** use the visible evidence. Choose `Uncertain`
  only when the missing definition is necessary to distinguish the smell.

## Independence, revisions, and adjudication

Initial annotations must be completed independently. Do not discuss an item
with the second validator until both submissions are locked. The system records
the validator ID, per-choice time, method-open time, submission time, duration,
and revision.

If a correction is necessary, submit a new revision; never overwrite the raw
initial record. Adjudication is a separate third-expert record and does not
delete either initial judgment.
