import pytest
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import Response
from fastapi.testclient import TestClient

from comfyfed_agent import comfy, whitelist

COMFY_URL = "http://fake-comfy:8188"


def _make_app():
    app = FastAPI()
    # `history_misses` makes /history return "not finished yet" that many
    # times, so a test can exercise the in-progress polling path;
    # `queue_running` is what /queue reports while that happens.
    # `pending_polls` makes /queue report the prompt as merely *pending*
    # (simulating another workload ahead of it on a shared worker) for that
    # many calls before it starts reporting `queue_running`.
    state = {
        "uploads": {},
        "history_misses": 0,
        "queue_running": [],
        "pending_polls": 0,
        # Cancellation bookkeeping: how many times `POST /interrupt` was
        # called, and every body `POST /queue` received.
        "interrupts": 0,
        "queue_posts": [],
    }

    @app.get("/object_info")
    def object_info():
        return {"KSampler": {}, "CheckpointLoaderSimple": {}, "SaveImage": {}}

    @app.post("/prompt")
    async def prompt(request: Request):
        body = await request.json()
        if body.get("prompt", {}).get("1", {}).get("class_type") == "BadNode":
            return Response(
                content='{"error": "invalid prompt", "node_errors": {"1": "bad"}}',
                media_type="application/json",
                status_code=400,
            )
        return {"prompt_id": "p1"}

    @app.get("/queue")
    def queue():
        if state["pending_polls"] > 0:
            state["pending_polls"] -= 1
            return {"queue_running": [], "queue_pending": [[0, "p1", {}]]}
        return {"queue_running": state["queue_running"], "queue_pending": []}

    @app.post("/interrupt")
    def interrupt():
        state["interrupts"] += 1
        return {}

    @app.post("/queue")
    async def queue_post(request: Request):
        state["queue_posts"].append(await request.json())
        return {}

    @app.get("/history/{prompt_id}")
    def history(prompt_id: str):
        if state["history_misses"] > 0:
            state["history_misses"] -= 1
            return {}
        return {
            prompt_id: {
                "status": {"status_str": "success"},
                "outputs": {
                    "9": {"images": [{"filename": "out.png", "subfolder": "", "type": "output"}]}
                },
            }
        }

    @app.get("/view")
    def view(filename: str, subfolder: str = "", type: str = "output"):
        return Response(content=b"PNGDATA", media_type="image/png")

    @app.post("/upload/image")
    async def upload_image(image: UploadFile = File(...), overwrite: str = Form(...)):
        content = await image.read()
        state["uploads"][image.filename] = (content, overwrite)
        return {"name": image.filename}

    app.state.uploads = state["uploads"]
    app.state.mock = state
    return app


@pytest.fixture()
def client():
    return TestClient(_make_app())


def test_get_object_info_returns_installed_classes(client):
    info = comfy.get_object_info(COMFY_URL, client=client)
    assert set(info.keys()) == {"KSampler", "CheckpointLoaderSimple", "SaveImage"}


def test_upload_input_posts_multipart_with_overwrite(client):
    comfy.upload_input(COMFY_URL, "ref.png", b"hello", client=client)
    content, overwrite = client.app.state.uploads["ref.png"]
    assert content == b"hello"
    assert overwrite == "true"


def test_run_workflow_returns_output_files(client):
    progress_calls = []
    files, exec_seconds = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        on_progress=progress_calls.append,
        client=client,
    )
    assert files == [("out.png", b"PNGDATA", "")]
    assert progress_calls[-1] == 1.0
    # Never observed running in /queue (history was already there on the
    # first poll), so exec_seconds falls back to the span since the local
    # /prompt POST -- a real, positive upper bound, NOT None. None would make
    # the server bill its own assigned->done wall clock, re-admitting the
    # federation queue wait this measurement exists to exclude.
    # `>= 0`, not `> 0`: the mock finishes in microseconds and Windows'
    # time.monotonic ticks at ~15ms, so a genuine measurement can legitimately
    # round to 0.0. The invariant under test is that it is a NUMBER.
    assert exec_seconds is not None
    assert exec_seconds >= 0


def test_run_workflow_raises_on_prompt_error(client):
    with pytest.raises(comfy.ComfyError):
        comfy.run_workflow(COMFY_URL, {"1": {"class_type": "BadNode"}}, client=client)


def test_whitelist_allowed_classes_installed_policy(client):
    allowed = whitelist.allowed_classes("installed", COMFY_URL, [], client=client)
    assert allowed == {"KSampler", "CheckpointLoaderSimple", "SaveImage"}


def test_whitelist_allowed_classes_official_only_intersects_installed(client):
    allowed = whitelist.allowed_classes("official_only", COMFY_URL, [], client=client)
    assert allowed == {"KSampler", "CheckpointLoaderSimple", "SaveImage"}


def test_whitelist_allowed_classes_custom_intersects_installed(client):
    allowed = whitelist.allowed_classes("custom", COMFY_URL, ["KSampler", "NotInstalled"], client=client)
    assert allowed == {"KSampler"}


def test_estimate_progress_ramps_between_floor_and_ceiling():
    # Monotonic ramp from 0.1 toward 0.9, clamped at both ends.
    assert comfy._estimate_progress(0.0, 120) == 0.1
    mid = comfy._estimate_progress(60, 120)
    assert 0.1 < mid < 0.9
    assert comfy._estimate_progress(120, 120) == 0.9
    assert comfy._estimate_progress(10_000, 120) == 0.9
    # A silly-small expected time is floored at 30s, so it still ramps.
    assert comfy._estimate_progress(1, 0) < 0.9


def test_run_workflow_reports_a_moving_estimate_while_queued(client, monkeypatch):
    monkeypatch.setattr(comfy.time, "sleep", lambda _s: None)
    client.app.state.mock["history_misses"] = 3
    client.app.state.mock["queue_running"] = [[0, "p1", {}]]

    progress_calls = []
    files, exec_seconds = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        on_progress=progress_calls.append,
        client=client,
        expected_seconds=60,
    )

    assert files == [("out.png", b"PNGDATA", "")]
    assert progress_calls[0] == 0.0
    assert progress_calls[-1] == 1.0

    interim = progress_calls[1:-1]
    assert len(interim) == 3
    # No longer the old hardcoded 0.5; a bounded, non-decreasing estimate.
    assert all(0.1 <= p <= 0.9 for p in interim)
    assert interim == sorted(interim)
    # Observed under queue_running the whole time it was queued, so the
    # execution window was measured (not None).
    assert exec_seconds is not None


def test_run_workflow_sits_at_ceiling_once_off_the_queue(client, monkeypatch):
    monkeypatch.setattr(comfy.time, "sleep", lambda _s: None)
    client.app.state.mock["history_misses"] = 2
    client.app.state.mock["queue_running"] = []  # already left the queue

    progress_calls = []
    _files, exec_seconds = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        on_progress=progress_calls.append,
        client=client,
    )

    assert progress_calls[1:-1] == [0.9, 0.9]
    assert progress_calls[-1] == 1.0
    # Already off the queue on the first poll (queue_running was empty the
    # whole time), so it was never observed running -- exec_seconds falls
    # back to the span since submission rather than going None.
    # `>= 0`, not `> 0`: the mock finishes in microseconds and Windows'
    # time.monotonic ticks at ~15ms, so a genuine measurement can legitimately
    # round to 0.0. The invariant under test is that it is a NUMBER.
    assert exec_seconds is not None
    assert exec_seconds >= 0


# --- Cancellation ----------------------------------------------------------


class _FlagEvent:
    """Minimal `asyncio.Event`-shaped stand-in whose `is_set()` flips to True
    after `trip_after` calls -- so a test can cancel *mid-poll* rather than
    only before the loop starts."""

    def __init__(self, trip_after: int = 0):
        self._calls = 0
        self._trip_after = trip_after

    def is_set(self) -> bool:
        self._calls += 1
        return self._calls > self._trip_after


def test_interrupt_or_dequeue_interrupts_the_executing_prompt(client):
    client.app.state.mock["queue_running"] = [[0, "p1", {}]]

    result = comfy.interrupt_or_dequeue(COMFY_URL, "p1", client=client)

    assert result == "interrupted"
    assert client.app.state.mock["interrupts"] == 1
    assert client.app.state.mock["queue_posts"] == []


def test_interrupt_or_dequeue_deletes_a_locally_queued_prompt(client):
    # Still merely pending behind other work: interrupting would abort
    # somebody else's currently-executing prompt, so delete ours instead.
    client.app.state.mock["pending_polls"] = 1

    result = comfy.interrupt_or_dequeue(COMFY_URL, "p1", client=client)

    assert result == "dequeued"
    assert client.app.state.mock["queue_posts"] == [{"delete": ["p1"]}]
    assert client.app.state.mock["interrupts"] == 0


def test_interrupt_or_dequeue_does_nothing_when_prompt_is_off_the_queue(client):
    # Neither running nor pending -- it already finished. Interrupting here
    # would kill an unrelated prompt on a shared worker.
    result = comfy.interrupt_or_dequeue(COMFY_URL, "p1", client=client)

    assert result == "absent"
    assert client.app.state.mock["interrupts"] == 0
    assert client.app.state.mock["queue_posts"] == []


def test_run_workflow_reports_prompt_id_to_the_caller(client):
    seen = []
    comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        client=client,
        on_prompt_id=seen.append,
    )
    assert seen == ["p1"]


def test_run_workflow_raises_job_cancelled_when_event_trips_mid_poll(client, monkeypatch):
    monkeypatch.setattr(comfy.time, "sleep", lambda _s: None)
    client.app.state.mock["history_misses"] = 10
    client.app.state.mock["queue_running"] = [[0, "p1", {}]]

    with pytest.raises(comfy.JobCancelled):
        comfy.run_workflow(
            COMFY_URL,
            {"1": {"class_type": "KSampler", "inputs": {}}},
            client=client,
            cancel_event=_FlagEvent(trip_after=2),
        )


def test_run_workflow_raises_job_cancelled_before_submitting_when_already_cancelled(client):
    with pytest.raises(comfy.JobCancelled):
        comfy.run_workflow(
            COMFY_URL,
            {"1": {"class_type": "KSampler", "inputs": {}}},
            client=client,
            cancel_event=_FlagEvent(trip_after=0),
        )


def test_run_workflow_ignores_an_unset_cancel_event(client):
    files, _exec_seconds = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        client=client,
        cancel_event=_FlagEvent(trip_after=10_000),
    )
    assert files == [("out.png", b"PNGDATA", "")]


def test_run_workflow_exec_seconds_excludes_queue_wait(client, monkeypatch):
    """A worker shared with other work (ours or another platform's) can sit
    `queue_pending` for a while before it actually starts running -- billing
    must only count the time from `queue_running` onward, not that wait.

    Uses a tiny real poll interval rather than faking `time.monotonic`
    globally: that function is shared process-wide (also used internally by
    httpx/anyio for the in-process test client), so stubbing it out affects
    far more than this one poll loop.
    """
    monkeypatch.setattr(comfy, "_POLL_INTERVAL_SECONDS", 0.01)

    client.app.state.mock["history_misses"] = 5
    client.app.state.mock["pending_polls"] = 3  # pending for 3 polls first
    client.app.state.mock["queue_running"] = [[0, "p1", {}]]

    submitted_at = comfy.time.monotonic()
    files, exec_seconds = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        client=client,
    )
    total_elapsed = comfy.time.monotonic() - submitted_at

    assert files == [("out.png", b"PNGDATA", "")]
    assert exec_seconds is not None
    # exec_seconds only starts counting once the prompt is first seen under
    # queue_running (after the 3 pending-only polls), so it is strictly less
    # than the elapsed time since submission.
    assert 0 < exec_seconds < total_elapsed
