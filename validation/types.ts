export type Decision = "present" | "absent" | "uncertain";

export type SmellKey =
  | "longMethod"
  | "complexMethod"
  | "complexConditional"
  | "featureEnvy";

export type DecisionMap = Record<SmellKey, Decision | null>;
export type DecisionTimeMap = Partial<Record<SmellKey, string>>;

export type ValidationSample = {
  sampleId: string;
  datasetMethodId: string;
  project: string;
  file: string;
  functionName: string;
  functionType: string;
  startLine: number;
  endLine: number;
  contextStartLine: number;
  contextEndLine: number;
  sourceSegment: string;
  sourceContext: string;
  segmentSha256: string;
  assignmentId?: string;
  sequenceNo?: number;
  status?: "pending" | "in_progress" | "completed";
  datasetSha256?: string;
  protocolVersion?: string;
};

export type PilotPayload = {
  study: {
    title: string;
    pilotSize: number;
    samplingSeed: string;
    datasetSha256: string;
    csvSchemaVersion: string;
    detectorVersion: string;
    blinded: boolean;
  };
  samples: ValidationSample[];
};

export type AnnotationRecord = {
  annotationId: string;
  validatorId: string;
  sampleId: string;
  datasetMethodId: string;
  datasetSha256: string;
  revision: number;
  decisions: Record<SmellKey, Decision>;
  decisionTimes: Record<SmellKey, string>;
  notes: string;
  startedAt: string;
  submittedAt: string;
  durationSeconds: number;
  mode: "local" | "hosted";
};
