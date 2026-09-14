import asyncio
import importlib.util

import pytest

from evaluation_runner import ragas_graders
from evaluation_runner.ragas_graders import (
    RagasCollectionsScorer,
    RagasGraderError,
    RagasMetricName,
    create_ragas_collections_scorer,
)


class FakeMetricResult:
    def __init__(self, value) -> None:
        self.value = value


class RecordingCollectionMetric:
    def __init__(self, value=0.875) -> None:
        self.value = value
        self.calls = []

    async def ascore(self, **inputs):
        self.calls.append(inputs)
        return FakeMetricResult(self.value)


def test_collections_scorer_calls_selected_metric_with_keyword_inputs() -> None:
    faithfulness = RecordingCollectionMetric()
    scorer = RagasCollectionsScorer(
        metrics={RagasMetricName.FAITHFULNESS: faithfulness}
    )

    score = asyncio.run(
        scorer.score(
            RagasMetricName.FAITHFULNESS,
            user_input="Can I return a damaged item?",
            response="Please provide damage photos.",
            retrieved_contexts=["Damage photos are required."],
        )
    )

    assert score == 0.875
    assert faithfulness.calls == [
        {
            "user_input": "Can I return a damaged item?",
            "response": "Please provide damage photos.",
            "retrieved_contexts": ["Damage photos are required."],
        }
    ]


def test_collections_scorer_rejects_unconfigured_metric() -> None:
    scorer = RagasCollectionsScorer(
        metrics={RagasMetricName.FAITHFULNESS: RecordingCollectionMetric()}
    )

    with pytest.raises(RagasGraderError, match="not configured"):
        asyncio.run(
            scorer.score(
                RagasMetricName.CONTEXT_RECALL,
                user_input="question",
                retrieved_contexts=["context"],
                reference="reference",
            )
        )


@pytest.mark.parametrize("result", [None, 0.5, FakeMetricResult(None)])
def test_collections_scorer_rejects_result_without_numeric_value(result) -> None:
    class InvalidMetric:
        async def ascore(self, **inputs):
            return result

    scorer = RagasCollectionsScorer(
        metrics={RagasMetricName.FAITHFULNESS: InvalidMetric()}
    )

    with pytest.raises(RagasGraderError, match="numeric value"):
        asyncio.run(
            scorer.score(
                RagasMetricName.FAITHFULNESS,
                user_input="question",
                response="answer",
                retrieved_contexts=["context"],
            )
        )


def test_ragas_factory_configures_all_metrics_with_explicit_clients(
    monkeypatch,
) -> None:
    created = []

    class FakeMetric:
        def __init__(self, **settings) -> None:
            self.settings = settings
            created.append(self)

    monkeypatch.setattr(
        ragas_graders,
        "_load_ragas_metric_types",
        lambda: {metric: FakeMetric for metric in RagasMetricName},
    )
    llm = object()
    embeddings = object()

    scorer = create_ragas_collections_scorer(llm=llm, embeddings=embeddings)

    assert isinstance(scorer, RagasCollectionsScorer)
    assert len(created) == 5
    assert all(metric.settings["llm"] is llm for metric in created)
    answer_relevancy = created[
        list(RagasMetricName).index(RagasMetricName.RESPONSE_RELEVANCY)
    ]
    assert answer_relevancy.settings["embeddings"] is embeddings
    factual_correctness = created[
        list(RagasMetricName).index(RagasMetricName.FACTUAL_CORRECTNESS)
    ]
    assert factual_correctness.settings["mode"] == "precision"
    assert all(
        "embeddings" not in metric.settings
        for metric in created
        if metric is not answer_relevancy
    )


def test_installed_ragas_collections_api_is_loadable() -> None:
    if importlib.util.find_spec("ragas") is None:
        pytest.skip("Install the ragas extra to run the integration smoke test")

    metric_types = ragas_graders._load_ragas_metric_types()

    assert set(metric_types) == set(RagasMetricName)
