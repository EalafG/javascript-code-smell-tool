import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCodeThemePreference } from "../app/code-theme";
import { CodeThemeToggle, SyntaxCode } from "../app/code-viewer";
import { getSupabaseClient } from "./supabase";
import type {
  AnnotationRecord,
  Decision,
  DecisionMap,
  DecisionTimeMap,
  PilotPayload,
  SmellKey,
  ValidationSample,
} from "./types";

const EMPTY_DECISIONS: DecisionMap = {
  longMethod: null,
  complexMethod: null,
  complexConditional: null,
  featureEnvy: null,
};

const SMELLS: Array<{
  key: SmellKey;
  label: string;
  cue: string;
}> = [
  {
    key: "longMethod",
    label: "Long Method",
    cue: "Excessive length or multiple responsibilities materially hinder understanding.",
  },
  {
    key: "complexMethod",
    label: "Complex Method",
    cue: "Overall control flow has too many interacting paths or deep structure.",
  },
  {
    key: "complexConditional",
    label: "Complex Conditional",
    cue: "At least one condition is unusually difficult to understand or explain.",
  },
  {
    key: "featureEnvy",
    label: "Feature Envy",
    cue: "The function appears more interested in another provider than its own context.",
  },
];

const DECISIONS: Array<{ value: Decision; label: string }> = [
  { value: "present", label: "Present" },
  { value: "absent", label: "Absent" },
  { value: "uncertain", label: "Uncertain" },
];

const LOCAL_VALIDATOR_KEY = "upm-validation:validator-id";

function asset(fileName: string) {
  return new URL(`../${fileName}`, window.location.href).toString();
}

function csvEscape(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportAnnotations(records: AnnotationRecord[]) {
  const headers = [
    "ANNOTATION_ID",
    "VALIDATOR_ID",
    "SAMPLE_ID",
    "DATASET_METHOD_ID",
    "DATASET_SHA256",
    "REVISION",
    "LONG_METHOD",
    "COMPLEX_METHOD",
    "COMPLEX_CONDITIONAL",
    "FEATURE_ENVY",
    "LONG_METHOD_DECIDED_AT",
    "COMPLEX_METHOD_DECIDED_AT",
    "COMPLEX_CONDITIONAL_DECIDED_AT",
    "FEATURE_ENVY_DECIDED_AT",
    "NOTES",
    "STARTED_AT",
    "SUBMITTED_AT",
    "DURATION_SECONDS",
    "MODE",
  ];
  const rows = records.map((record) => [
    record.annotationId,
    record.validatorId,
    record.sampleId,
    record.datasetMethodId,
    record.datasetSha256,
    record.revision,
    record.decisions.longMethod,
    record.decisions.complexMethod,
    record.decisions.complexConditional,
    record.decisions.featureEnvy,
    record.decisionTimes.longMethod,
    record.decisionTimes.complexMethod,
    record.decisionTimes.complexConditional,
    record.decisionTimes.featureEnvy,
    record.notes,
    record.startedAt,
    record.submittedAt,
    record.durationSeconds,
    record.mode,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "upm-code-smell-validation-annotations.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function localRecordsKey(validatorId: string, datasetSha256: string) {
  return `upm-validation:annotations:${datasetSha256}:${validatorId}`;
}

function readLocalRecords(validatorId: string, datasetSha256: string): AnnotationRecord[] {
  try {
    const value = localStorage.getItem(localRecordsKey(validatorId, datasetSha256));
    return value ? JSON.parse(value) as AnnotationRecord[] : [];
  } catch {
    return [];
  }
}

function writeLocalRecords(validatorId: string, datasetSha256: string, records: AnnotationRecord[]) {
  localStorage.setItem(localRecordsKey(validatorId, datasetSha256), JSON.stringify(records));
}

function normalizeHostedSample(row: Record<string, unknown>): ValidationSample {
  return {
    sampleId: String(row.sample_id),
    datasetMethodId: String(row.dataset_method_id),
    project: String(row.project),
    file: String(row.file_path),
    functionName: String(row.function_name),
    functionType: String(row.function_type),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    contextStartLine: Number(row.context_start_line),
    contextEndLine: Number(row.context_end_line),
    sourceSegment: String(row.source_segment),
    sourceContext: String(row.source_context),
    segmentSha256: String(row.segment_sha256),
    assignmentId: String(row.assignment_id),
    sequenceNo: Number(row.sequence_no),
    status: row.status as ValidationSample["status"],
    datasetSha256: String(row.dataset_sha256),
    protocolVersion: String(row.protocol_version),
  };
}

function parsePilotPayload(value: unknown): PilotPayload {
  if (!value || typeof value !== "object") throw new Error("The selected file is not a validation payload.");
  const payload = value as Partial<PilotPayload>;
  if (!payload.study || typeof payload.study !== "object" || !Array.isArray(payload.samples)) {
    throw new Error("The payload must contain study metadata and a samples array.");
  }

  const study = payload.study as Partial<PilotPayload["study"]>;
  if (
    typeof study.title !== "string" || !study.title.trim() ||
    typeof study.datasetSha256 !== "string" || !study.datasetSha256.trim() ||
    typeof study.pilotSize !== "number" || !Number.isInteger(study.pilotSize)
  ) {
    throw new Error("The study title, dataset hash, or pilot size is invalid.");
  }
  if (study.pilotSize !== payload.samples.length) {
    throw new Error(`The payload declares ${study.pilotSize} samples but contains ${payload.samples.length}.`);
  }

  const requiredTextFields: Array<keyof ValidationSample> = [
    "sampleId",
    "datasetMethodId",
    "project",
    "file",
    "functionName",
    "functionType",
    "sourceSegment",
    "sourceContext",
    "segmentSha256",
  ];
  const seenIds = new Set<string>();
  payload.samples.forEach((sample, index) => {
    if (!sample || typeof sample !== "object") throw new Error(`Sample ${index + 1} is invalid.`);
    for (const field of requiredTextFields) {
      if (typeof sample[field] !== "string") throw new Error(`Sample ${index + 1} has an invalid ${field}.`);
    }
    for (const field of ["startLine", "endLine", "contextStartLine", "contextEndLine"] as const) {
      if (!Number.isInteger(sample[field]) || sample[field] < 1) {
        throw new Error(`Sample ${index + 1} has an invalid ${field}.`);
      }
    }
    if (seenIds.has(sample.sampleId)) throw new Error(`Duplicate sample ID: ${sample.sampleId}.`);
    seenIds.add(sample.sampleId);
  });

  return payload as PilotPayload;
}

function LoginPanel({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setMessage("");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.href },
    });
    setSending(false);
    setMessage(error ? error.message : "Check your email for the secure sign-in link.");
  }

  return (
    <main className="entry-shell">
      <section className="entry-card">
        <img src={asset("upm-logo.jpg")} alt="Universiti Putra Malaysia" />
        <p className="kicker">EXPERT VALIDATION</p>
        <h1>Sign in to your assigned sample</h1>
        <p>
          Use the email address invited to this study. Your authentication UUID is retained as the
          stable validator identifier; detector predictions remain hidden.
        </p>
        <form onSubmit={sendLink}>
          <label htmlFor="validator-email">Email address</label>
          <input
            id="validator-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="validator@example.edu"
          />
          <button className="button button--primary" disabled={sending} type="submit">
            {sending ? "Sending link…" : "Email me a sign-in link"}
          </button>
        </form>
        {message && <p className="entry-message" role="status">{message}</p>}
        <a className="quiet-link" href="../">Return to the detector</a>
      </section>
    </main>
  );
}

function LocalDatasetEntry({ onLoad }: { onLoad: (payload: PilotPayload) => void }) {
  const [error, setError] = useState("");

  async function selectPayload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const payload = parsePilotPayload(JSON.parse(await file.text()) as unknown);
      onLoad(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The validation payload could not be read.");
      event.target.value = "";
    }
  }

  return (
    <main className="entry-shell">
      <section className="entry-card">
        <img src={asset("upm-logo.jpg")} alt="Universiti Putra Malaysia" />
        <p className="kicker">PRIVATE LOCAL VALIDATION</p>
        <h1>Load a blinded validation sample</h1>
        <p>
          Select the JSON payload supplied by the study administrator. Source segments remain on
          this device and are never uploaded by this static website.
        </p>
        <form>
          <label htmlFor="pilot-payload">Blinded sample file</label>
          <input
            id="pilot-payload"
            type="file"
            accept=".json,application/json"
            onChange={selectPayload}
          />
          <p className="field-help">Expected format: the blinded pilot JSON created by the sampling script.</p>
        </form>
        {error && <p className="entry-message" role="alert">{error}</p>}
        <div className="privacy-callout">
          Dataset files and source-derived samples are deliberately excluded from the public GitHub repository.
        </div>
        <a className="quiet-link" href="../">Return to the detector</a>
      </section>
    </main>
  );
}

function LocalEntry({
  study,
  onBegin,
}: {
  study: PilotPayload["study"];
  onBegin: (validatorId: string) => void;
}) {
  const [validatorId, setValidatorId] = useState(() => localStorage.getItem(LOCAL_VALIDATOR_KEY) ?? "");

  function generateId() {
    setValidatorId(`VAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  }

  function begin(event: FormEvent) {
    event.preventDefault();
    const value = validatorId.trim();
    if (!value) return;
    localStorage.setItem(LOCAL_VALIDATOR_KEY, value);
    onBegin(value);
  }

  return (
    <main className="entry-shell">
      <section className="entry-card entry-card--wide">
        <div className="entry-brand">
          <img src={asset("upm-logo.jpg")} alt="Universiti Putra Malaysia" />
          <span>Local pilot · blinded</span>
        </div>
        <p className="kicker">MANUAL DATASET VALIDATION</p>
        <h1>{study.title}</h1>
        <p>
          Independently judge four smells for {study.pilotSize} method-level samples. Metrics,
          detector labels, and sampling strata are not shown.
        </p>
        <div className="entry-facts" aria-label="Pilot facts">
          <div><strong>{study.pilotSize}</strong><span>methods</span></div>
          <div><strong>4</strong><span>smells per method</span></div>
          <div><strong>3</strong><span>decision choices</span></div>
        </div>
        <form onSubmit={begin}>
          <label htmlFor="validator-id">Anonymized validator ID</label>
          <div className="inline-field">
            <input
              id="validator-id"
              required
              minLength={3}
              maxLength={64}
              value={validatorId}
              onChange={(event) => setValidatorId(event.target.value)}
              placeholder="VAL-XXXXXXXX"
            />
            <button className="button button--secondary" type="button" onClick={generateId}>Generate ID</button>
          </div>
          <p className="field-help">Use the same ID on every session. Do not enter your name or email.</p>
          <button className="button button--primary" type="submit">Begin or resume pilot</button>
        </form>
        <div className="privacy-callout">
          Local mode stores the append-only annotation log in this browser. Export the CSV before
          changing devices or clearing browser data.
        </div>
        <a className="quiet-link" href="../">Return to the detector</a>
      </section>
    </main>
  );
}

function CodeViewer({ sample }: { sample: ValidationSample }) {
  const [showContext, setShowContext] = useState(false);
  const [codeTheme, setCodeTheme] = useCodeThemePreference();
  const source = showContext ? sample.sourceContext : sample.sourceSegment;
  const firstLine = showContext ? sample.contextStartLine : sample.startLine;

  return (
    <section className="code-card" aria-labelledby="code-heading">
      <div className="code-card__heading">
        <div>
          <p className="kicker">SOURCE SEGMENT</p>
          <h2 id="code-heading">{sample.functionName}</h2>
          <p>{sample.file} · lines {sample.startLine}–{sample.endLine}</p>
        </div>
        <div className="code-card__actions">
          <CodeThemeToggle theme={codeTheme} onChange={setCodeTheme} />
          <button className="button button--secondary button--small" type="button" onClick={() => setShowContext((value) => !value)}>
            {showContext ? "Show method only" : "Show nearby context"}
          </button>
        </div>
      </div>
      <div className="method-meta">
        <span>{sample.project}</span>
        <span>{sample.functionType}</span>
        <span>{sample.sampleId}</span>
      </div>
      <SyntaxCode
        source={source}
        startLine={firstLine}
        theme={codeTheme}
        label={`JavaScript source for ${sample.functionName}`}
        className="validation-code-view"
      />
      <p className="hash-note">Segment fingerprint · {sample.segmentSha256.slice(0, 16)}…</p>
    </section>
  );
}

type WorkspaceProps = {
  mode: "local" | "hosted";
  validatorId: string;
  samples: ValidationSample[];
  completedSampleIds: Set<string>;
  records: AnnotationRecord[];
  datasetSha256: string;
  onSubmit: (sample: ValidationSample, draft: {
    decisions: Record<SmellKey, Decision>;
    decisionTimes: Record<SmellKey, string>;
    notes: string;
    startedAt: string;
  }) => Promise<void>;
  onExport?: () => void;
  onExit: () => void;
};

function Workspace({
  mode,
  validatorId,
  samples,
  completedSampleIds,
  records,
  datasetSha256,
  onSubmit,
  onExport,
  onExit,
}: WorkspaceProps) {
  const firstPending = Math.max(0, samples.findIndex((sample) => !completedSampleIds.has(sample.sampleId)));
  const [activeIndex, setActiveIndex] = useState(firstPending);
  const [queueFilter, setQueueFilter] = useState<"all" | "remaining" | "completed">("remaining");
  const [search, setSearch] = useState("");
  const [decisions, setDecisions] = useState<DecisionMap>({ ...EMPTY_DECISIONS });
  const [decisionTimes, setDecisionTimes] = useState<DecisionTimeMap>({});
  const [notes, setNotes] = useState("");
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [guidelineOpen, setGuidelineOpen] = useState(false);
  const activeSample = samples[activeIndex];

  function resetDraft() {
    setDecisions({ ...EMPTY_DECISIONS });
    setDecisionTimes({});
    setNotes("");
    setStartedAt(new Date().toISOString());
    setMessage("");
  }

  const completed = completedSampleIds.size;
  const remaining = Math.max(0, samples.length - completed);
  const progress = samples.length ? (completed / samples.length) * 100 : 0;
  const filteredSamples = useMemo(() => {
    const query = search.trim().toLowerCase();
    return samples.filter((sample) => {
      const isCompleted = completedSampleIds.has(sample.sampleId);
      if (queueFilter === "remaining" && isCompleted) return false;
      if (queueFilter === "completed" && !isCompleted) return false;
      return !query || `${sample.sampleId} ${sample.file} ${sample.functionName}`.toLowerCase().includes(query);
    });
  }, [completedSampleIds, queueFilter, samples, search]);

  const allDecided = SMELLS.every(({ key }) => decisions[key]);
  const hasUncertain = SMELLS.some(({ key }) => decisions[key] === "uncertain");
  const canSubmit = allDecided && (!hasUncertain || notes.trim().length > 0) && !submitting;

  function chooseDecision(key: SmellKey, value: Decision) {
    setDecisions((current) => ({ ...current, [key]: value }));
    setDecisionTimes((current) => ({ ...current, [key]: new Date().toISOString() }));
  }

  function chooseSample(sample: ValidationSample) {
    if (mode === "hosted" && completedSampleIds.has(sample.sampleId)) return;
    const index = samples.findIndex((item) => item.sampleId === sample.sampleId);
    if (index >= 0 && index !== activeIndex) {
      resetDraft();
      setActiveIndex(index);
    }
  }

  async function submitCurrent() {
    if (!activeSample || !canSubmit) return;
    setSubmitting(true);
    setMessage("");
    try {
      await onSubmit(activeSample, {
        decisions: decisions as Record<SmellKey, Decision>,
        decisionTimes: decisionTimes as Record<SmellKey, string>,
        notes: notes.trim(),
        startedAt,
      });
      const next = samples.findIndex((sample, index) => index > activeIndex && !completedSampleIds.has(sample.sampleId));
      const wrap = samples.findIndex((sample) => !completedSampleIds.has(sample.sampleId) && sample.sampleId !== activeSample.sampleId);
      const nextIndex = next >= 0 ? next : wrap;
      if (nextIndex >= 0) {
        resetDraft();
        setActiveIndex(nextIndex);
      }
      setMessage("Annotation saved to the blinded log.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The annotation could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!samples.length) {
    return (
      <main className="entry-shell">
        <section className="entry-card">
          <p className="kicker">NO ASSIGNMENTS</p>
          <h1>Your validation queue is empty</h1>
          <p>Ask the study administrator to assign methods to validator {validatorId}.</p>
          <button className="button button--secondary" type="button" onClick={onExit}>Sign out</button>
        </section>
      </main>
    );
  }

  return (
    <div className="validation-app">
      <header className="topbar">
        <a className="brand" href="../" aria-label="Return to JavaScript Code Smell Detection Tool">
          <img src={asset("upm-logo.jpg")} alt="" />
          <span><strong>Code Smell Validation</strong><small>UPM research workspace</small></span>
        </a>
        <div className="topbar__actions">
          <span className={`mode-badge mode-badge--${mode}`}>{mode === "hosted" ? "Hosted study" : "Local pilot"}</span>
          <button className="button button--quiet" type="button" onClick={() => setGuidelineOpen(true)}>Guideline</button>
          {onExport && <button className="button button--quiet" type="button" onClick={onExport}>Export log</button>}
          <button className="button button--quiet" type="button" onClick={onExit}>{mode === "hosted" ? "Sign out" : "Change ID"}</button>
        </div>
      </header>

      <section className="study-strip" aria-label="Study progress">
        <div>
          <p className="kicker">BLINDED ANNOTATION · VALIDATOR {validatorId}</p>
          <h1>Judge the code, not the detector</h1>
        </div>
        <div className="progress-summary">
          <div><strong>{completed}</strong><span>completed</span></div>
          <div><strong>{remaining}</strong><span>remaining</span></div>
          <div><strong>{Math.round(progress)}%</strong><span>progress</span></div>
        </div>
        <div className="progress-bar" aria-label={`${Math.round(progress)} percent complete`}>
          <span style={{ width: `${progress}%` }} />
        </div>
      </section>

      <main className="workspace-grid">
        <aside className="queue-card" aria-label="Method queue">
          <div className="queue-card__heading">
            <div><p className="kicker">DATASET ITEMS</p><h2>Method queue</h2></div>
            <span>{filteredSamples.length}</span>
          </div>
          <input
            className="search-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search file or function"
            aria-label="Search method queue"
          />
          <div className="segmented-control" aria-label="Queue filter">
            {(["remaining", "completed", "all"] as const).map((filter) => (
              <button
                type="button"
                className={queueFilter === filter ? "is-active" : ""}
                onClick={() => setQueueFilter(filter)}
                key={filter}
              >
                {filter}
              </button>
            ))}
          </div>
          <div className="queue-list">
            {filteredSamples.map((sample) => {
              const isCompleted = completedSampleIds.has(sample.sampleId);
              const isActive = activeSample?.sampleId === sample.sampleId;
              return (
                <button
                  type="button"
                  className={`queue-item ${isActive ? "is-active" : ""}`}
                  onClick={() => chooseSample(sample)}
                  disabled={mode === "hosted" && isCompleted}
                  key={sample.sampleId}
                >
                  <span className={`queue-status ${isCompleted ? "is-complete" : ""}`} aria-hidden="true" />
                  <span><strong>{sample.sampleId} · {sample.functionName}</strong><small>{sample.file}</small></span>
                </button>
              );
            })}
            {!filteredSamples.length && <p className="queue-empty">No methods match this filter.</p>}
          </div>
        </aside>

        {activeSample && <CodeViewer sample={activeSample} />}

        <aside className="annotation-card" aria-label="Smell decisions">
          <div className="annotation-card__heading">
            <div><p className="kicker">YOUR JUDGMENT</p><h2>Four independent decisions</h2></div>
            <span>{SMELLS.filter(({ key }) => decisions[key]).length}/4</span>
          </div>
          <p className="annotation-intro">Select one decision for each smell. Use Uncertain only when a defensible judgment needs missing context.</p>
          <div className="smell-list">
            {SMELLS.map((smell, index) => (
              <fieldset className="smell-decision" key={smell.key}>
                <legend><span>{index + 1}</span>{smell.label}</legend>
                <p>{smell.cue}</p>
                <div className="decision-buttons">
                  {DECISIONS.map((choice) => (
                    <button
                      type="button"
                      className={`decision decision--${choice.value} ${decisions[smell.key] === choice.value ? "is-selected" : ""}`}
                      aria-pressed={decisions[smell.key] === choice.value}
                      onClick={() => chooseDecision(smell.key, choice.value)}
                      key={choice.value}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>

          <label className="notes-field">
            <span>Reasoning note {hasUncertain ? <strong>Required for Uncertain</strong> : <small>Optional</small>}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Record the evidence or missing context…"
              rows={3}
            />
          </label>
          <button className="button button--primary submit-button" type="button" disabled={!canSubmit} onClick={submitCurrent}>
            {submitting ? "Saving…" : completedSampleIds.has(activeSample?.sampleId ?? "") ? "Submit new revision" : "Submit and continue"}
          </button>
          {!allDecided && <p className="form-hint">Complete all four decisions to submit.</p>}
          {hasUncertain && !notes.trim() && <p className="form-hint">Explain what context is missing.</p>}
          {message && <p className="save-message" role="status">{message}</p>}
        </aside>
      </main>

      <footer>
        <span>Dataset {datasetSha256.slice(0, 12)}… · raw annotations are append-only</span>
        <span>{mode === "local" ? `${records.length} local log record${records.length === 1 ? "" : "s"}` : "Secure hosted log"}</span>
      </footer>

      {guidelineOpen && (
        <div className="dialog-backdrop">
          <button className="dialog-scrim" type="button" aria-label="Close guideline" onClick={() => setGuidelineOpen(false)} />
          <section className="guideline-dialog" role="dialog" aria-modal="true" aria-labelledby="guideline-title">
            <div className="dialog-heading">
              <div><p className="kicker">PILOT PROTOCOL 1.0.0</p><h2 id="guideline-title">Decision reminders</h2></div>
              <button className="button button--quiet" type="button" onClick={() => setGuidelineOpen(false)}>Close</button>
            </div>
            <div className="guideline-grid">
              {SMELLS.map((smell) => <article key={smell.key}><h3>{smell.label}</h3><p>{smell.cue}</p></article>)}
            </div>
            <div className="decision-guide">
              <p><strong>Present</strong> — sufficient evidence that the smell exists.</p>
              <p><strong>Absent</strong> — sufficient evidence that it does not.</p>
              <p><strong>Uncertain</strong> — essential context is missing or the evidence is genuinely balanced; explain why.</p>
            </div>
            <p className="dialog-note">Nested functions are separate units. Do not count their control flow or foreign accesses as part of the displayed parent.</p>
          </section>
        </div>
      )}
    </div>
  );
}

function HostedApp({ client }: { client: SupabaseClient }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [samples, setSamples] = useState<ValidationSample[]>([]);
  const [validatorCode, setValidatorCode] = useState("");
  const [loadError, setLoadError] = useState("");

  const loadQueue = useCallback(async (activeSession: Session) => {
    setLoading(true);
    const [queueResult, profileResult] = await Promise.all([
      client.from("validator_queue").select("*").order("sequence_no"),
      client.from("profiles").select("validator_code").eq("id", activeSession.user.id).maybeSingle(),
    ]);
    if (queueResult.error) {
      setLoadError(queueResult.error.message);
      setSamples([]);
    } else {
      setSamples((queueResult.data ?? []).map((row) => normalizeHostedSample(row as Record<string, unknown>)));
      setLoadError("");
    }
    setValidatorCode(String(profileResult.data?.validator_code ?? activeSession.user.id.slice(0, 8)));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) loadQueue(data.session);
      else setLoading(false);
    });
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) loadQueue(nextSession);
      else {
        setSamples([]);
        setLoading(false);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [client, loadQueue]);

  if (loading) return <main className="entry-shell"><section className="entry-card"><p className="kicker">LOADING</p><h1>Preparing your blinded queue…</h1></section></main>;
  if (!session) return <LoginPanel client={client} />;
  if (loadError) return <main className="entry-shell"><section className="entry-card"><p className="kicker">CONNECTION ERROR</p><h1>Your queue could not be loaded</h1><p>{loadError}</p><button className="button button--secondary" type="button" onClick={() => loadQueue(session)}>Try again</button></section></main>;

  const completedIds = new Set(samples.filter((sample) => sample.status === "completed").map((sample) => sample.sampleId));
  const datasetSha256 = samples[0]?.datasetSha256 ?? "hosted-study";

  async function submit(sample: ValidationSample, draft: {
    decisions: Record<SmellKey, Decision>;
    decisionTimes: Record<SmellKey, string>;
    notes: string;
    startedAt: string;
  }) {
    if (!sample.assignmentId) throw new Error("This method has no assignment identifier.");
    const { error } = await client.rpc("submit_annotation", {
      p_assignment_id: sample.assignmentId,
      p_long_method: draft.decisions.longMethod,
      p_complex_method: draft.decisions.complexMethod,
      p_complex_conditional: draft.decisions.complexConditional,
      p_feature_envy: draft.decisions.featureEnvy,
      p_notes: draft.notes || null,
      p_decision_times: draft.decisionTimes,
      p_client_started_at: draft.startedAt,
    });
    if (error) throw error;
    setSamples((current) => current.map((item) => item.sampleId === sample.sampleId ? { ...item, status: "completed" } : item));
  }

  return (
    <Workspace
      mode="hosted"
      validatorId={validatorCode}
      samples={samples}
      completedSampleIds={completedIds}
      records={[]}
      datasetSha256={datasetSha256}
      onSubmit={submit}
      onExit={() => client.auth.signOut()}
    />
  );
}

function LocalApp() {
  const [payload, setPayload] = useState<PilotPayload | null>(null);
  const [validatorId, setValidatorId] = useState("");
  const [records, setRecords] = useState<AnnotationRecord[]>([]);

  function begin(value: string) {
    if (!payload) return;
    setValidatorId(value);
    setRecords(readLocalRecords(value, payload.study.datasetSha256));
  }

  if (!payload) return <LocalDatasetEntry onLoad={setPayload} />;
  const activePayload = payload;
  if (!validatorId) return <LocalEntry study={activePayload.study} onBegin={begin} />;

  const latestBySample = new Map<string, AnnotationRecord>();
  for (const record of records) {
    const current = latestBySample.get(record.sampleId);
    if (!current || record.revision > current.revision) latestBySample.set(record.sampleId, record);
  }
  const completedIds = new Set(latestBySample.keys());

  async function submit(sample: ValidationSample, draft: {
    decisions: Record<SmellKey, Decision>;
    decisionTimes: Record<SmellKey, string>;
    notes: string;
    startedAt: string;
  }) {
    const submittedAt = new Date().toISOString();
    const revision = records.filter((record) => record.sampleId === sample.sampleId).length + 1;
    const record: AnnotationRecord = {
      annotationId: crypto.randomUUID(),
      validatorId,
      sampleId: sample.sampleId,
      datasetMethodId: sample.datasetMethodId,
      datasetSha256: activePayload.study.datasetSha256,
      revision,
      decisions: draft.decisions,
      decisionTimes: draft.decisionTimes,
      notes: draft.notes,
      startedAt: draft.startedAt,
      submittedAt,
      durationSeconds: Math.max(0, Math.round((Date.parse(submittedAt) - Date.parse(draft.startedAt)) / 1000)),
      mode: "local",
    };
    const next = [...records, record];
    setRecords(next);
    writeLocalRecords(validatorId, activePayload.study.datasetSha256, next);
  }

  return (
    <Workspace
      mode="local"
      validatorId={validatorId}
      samples={activePayload.samples}
      completedSampleIds={completedIds}
      records={records}
      datasetSha256={activePayload.study.datasetSha256}
      onSubmit={submit}
      onExport={() => exportAnnotations(records)}
      onExit={() => setValidatorId("")}
    />
  );
}

export default function ValidationApp() {
  const client = getSupabaseClient();
  return client ? <HostedApp client={client} /> : <LocalApp />;
}
