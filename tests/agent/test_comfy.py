import pytest
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import Response
from fastapi.testclient import TestClient

from comfyfed_agent import comfy, whitelist

COMFY_URL = "http://fake-comfy:8188"


def _make_app():
    app = FastAPI()
    state = {"uploads": {}}

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

    @app.get("/history/{prompt_id}")
    def history(prompt_id: str):
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
