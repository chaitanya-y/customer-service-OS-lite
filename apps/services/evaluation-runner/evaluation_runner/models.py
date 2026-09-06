from __future__ import annotations

from enum import StrEnum

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    model_validator,
)


class EvaluationCapability(StrEnum):
    RETRIEVAL = "RETRIEVAL"
    ANSWER = "ANSWER"
    AGENT = "AGENT"
    POLICY = "POLICY"
    SAFETY = "SAFETY"


class EvaluationCase(BaseModel):
    """One reviewed task with explicit inputs and success criteria."""

    model_config = ConfigDict(frozen=True)

    case_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    capability: EvaluationCapability
    input: dict[str, JsonValue]
    expectations: dict[str, JsonValue]
    tags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_tags(self) -> EvaluationCase:
        if len(set(self.tags)) != len(self.tags):
            raise ValueError("Evaluation cases must not contain duplicate tags.")
        return self


class EvaluationDataset(BaseModel):
    """A versioned collection of reviewed evaluation cases."""

    model_config = ConfigDict(frozen=True)

    dataset_id: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    cases: list[EvaluationCase] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_case_ids(self) -> EvaluationDataset:
        case_ids = [case.case_id for case in self.cases]
        if len(set(case_ids)) != len(case_ids):
            raise ValueError("Evaluation datasets must not contain duplicate case IDs.")
        return self


class TraceEventKind(StrEnum):
    MODEL_CALL = "MODEL_CALL"
    RETRIEVAL = "RETRIEVAL"
    TOOL_CALL = "TOOL_CALL"
    HANDOFF = "HANDOFF"
    POLICY_DECISION = "POLICY_DECISION"
    STATE_CHANGE = "STATE_CHANGE"


class TraceEvent(BaseModel):
    """One structured observation from a trial trajectory."""

    model_config = ConfigDict(frozen=True)

    sequence: int = Field(gt=0)
    kind: TraceEventKind
    name: str = Field(min_length=1)
    payload: dict[str, JsonValue] = Field(default_factory=dict)


class EvaluationSample(BaseModel):
    """Observed output, state, trajectory, cost, and versions for one attempt."""

    model_config = ConfigDict(frozen=True)

    output: dict[str, JsonValue]
    final_state: dict[str, JsonValue]
    trace: list[TraceEvent] = Field(default_factory=list)
    latency_ms: float = Field(ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    estimated_cost_usd: float = Field(default=0, ge=0)
    versions: dict[str, str] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_trace_and_versions(self) -> EvaluationSample:
        sequences = [event.sequence for event in self.trace]
        if sequences != sorted(sequences) or len(set(sequences)) != len(sequences):
            raise ValueError(
                "Trace event sequences must be unique and strictly increasing."
            )

        if any(
            not key.strip() or not value.strip() for key, value in self.versions.items()
        ):
            raise ValueError("Version evidence keys and values must not be blank.")

        return self


class GraderResult(BaseModel):
    """One versioned judgment, including whether failure blocks release."""

    model_config = ConfigDict(frozen=True)

    grader_name: str = Field(min_length=1)
    grader_version: str = Field(min_length=1)
    score: float = Field(ge=0, le=1)
    passed: bool
    blocking: bool
    reasons: list[str] = Field(default_factory=list)
    details: dict[str, JsonValue] = Field(default_factory=dict)


class TrialStatus(StrEnum):
    COMPLETED = "COMPLETED"
    SYSTEM_ERROR = "SYSTEM_ERROR"


class TrialResult(BaseModel):
    """The auditable result of one case repetition."""

    model_config = ConfigDict(frozen=True)

    trial_id: str = Field(min_length=1)
    case_id: str = Field(min_length=1)
    repetition: int = Field(gt=0)
    status: TrialStatus
    passed: bool
    sample: EvaluationSample | None = None
    error_message: str | None = None
    grader_results: list[GraderResult]

    @model_validator(mode="after")
    def validate_status_payload(self) -> TrialResult:
        if self.status is TrialStatus.COMPLETED:
            if self.sample is None:
                raise ValueError("A completed trial requires a sample.")
            if self.error_message is not None:
                raise ValueError("A completed trial cannot contain an error.")
        elif (
            self.sample is not None
            or not self.error_message
            or self.passed
            or self.grader_results
        ):
            raise ValueError(
                "A system-error trial requires only an error message and must fail."
            )

        return self


class CaseSummary(BaseModel):
    """Reliability statistics for one case across all repetitions."""

    model_config = ConfigDict(frozen=True)

    case_id: str = Field(min_length=1)
    trial_count: int = Field(gt=0)
    passed_trial_count: int = Field(ge=0)
    pass_rate: float = Field(ge=0, le=1)
    all_trials_passed: bool


class RunSummary(BaseModel):
    """Transparent aggregate counts without mixing unrelated grader scores."""

    model_config = ConfigDict(frozen=True)

    case_count: int = Field(gt=0)
    trial_count: int = Field(gt=0)
    passed_trial_count: int = Field(ge=0)
    pass_rate: float = Field(ge=0, le=1)
    consistent_case_count: int = Field(ge=0)
    consistent_case_rate: float = Field(ge=0, le=1)


class EvaluationRun(BaseModel):
    """One reproducible evaluation experiment and all of its evidence."""

    model_config = ConfigDict(frozen=True)

    run_id: str = Field(min_length=1)
    dataset_id: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    evaluation_version: str = Field(min_length=1)
    repetitions: int = Field(gt=0)
    trials: list[TrialResult] = Field(min_length=1)
    case_summaries: list[CaseSummary] = Field(min_length=1)
    summary: RunSummary
