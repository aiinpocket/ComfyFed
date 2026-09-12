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
    state = {"uploads": {}, "history_misses": 0, "queue_running": []}

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
        return {"queue_running": state["queue_running"], "queue_pending": []}

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
    files = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        on_progress=progress_calls.append,
        client=client,
    )
    assert files == [("out.png", b"PNGDATA")]
    assert progress_calls[-1] == 1.0


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
    files = comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        on_progress=progress_calls.append,
        client=client,
        expected_seconds=60,
    )

    assert files == [("out.png", b"PNGDATA")]
    assert progress_calls[0] == 0.0
    assert progress_calls[-1] == 1.0

    interim = progress_calls[1:-1]
    assert len(interim) == 3
    # No longer the old hardcoded 0.5; a bounded, non-decreasing estimate.
    assert all(0.1 <= p <= 0.9 for p in interim)
    assert interim == sorted(interim)


def test_run_workflow_sits_at_ceiling_once_off_the_queue(client, monkeypatch):
    monkeypatch.setattr(comfy.time, "sleep", lambda _s: None)
    client.app.state.mock["history_misses"] = 2
    client.app.state.mock["queue_running"] = []  # already left the queue

    progress_calls = []
    comfy.run_workflow(
        COMFY_URL,
        {"1": {"class_type": "KSampler", "inputs": {}}},
        on_progress=progress_calls.append,
        client=client,
    )

    assert progress_calls[1:-1] == [0.9, 0.9]
    assert progress_calls[-1] == 1.0
