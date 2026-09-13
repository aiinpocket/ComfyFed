"""Job submission, listing, and assessment API."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from . import agentws, assess, auth, db, dispatch, model_guide, model_manifest, storage
from .workers import verify_agent

_JOB_INPUTS_DIRNAME = "job_inputs"


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


class MissingAssetsError(Exception):
    """A workflow references input assets the caller did not make available.

    Carries the sorted missing filenames so each caller can render it in its
    own error dialect -- the console's `{"error": {"code", "message"}}`
    envelope, or the ComfyUI-compatible `{"error": {...}, "node_errors": {}}`
    shape in `comfyapi.py`.
    """

    def __init__(self, missing: list[str]):
        super().__init__(", ".join(missing))
        self.missing = missing


def job_inputs_dir(data_dir: str, job_id: str) -> str:
    """Directory holding a job's staged input assets."""
    return os.path.join(data_dir, _JOB_INPUTS_DIRNAME, job_id)


def _online_enabled_workers(session) -> list:
    """Workers eligible to be asked to auto-fetch: online and not disabled.

    Same definition `comfyapi._online_enabled_workers` uses -- kept as its own
    small query here rather than imported cross-module to avoid a
    jobs<->comfyapi import cycle (comfyapi already imports this module).
    """
    return (
        session.query(db.Worker)
        .filter(db.Worker.disabled == False)  # noqa: E712
        .filter(db.Worker.status != "offline")
        .all()
    )


def unfetchable_missing_models(needs: assess.JobNeeds, data_dir: str) -> set[str]:
    """The console submit predicate: fleet-wide missing models that are ALSO
    not fetchable by anyone (see `assess.partition_fleet_fetchable`).

    Shared by `POST /api/jobs` (the 400 gate below) and nothing else yet --
    a standalone function rather than inlined in the route so a future
    caller (or a test) can ask "would this submit be rejected" without
    going through HTTP.
    """
    with db.get_session() as session:
        all_workers = session.query(db.Worker).all()
        online_workers = _online_enabled_workers(session)

    missing_models, _missing_nodes = assess.fleet_wide_gaps(needs, all_workers)
    if not missing_models:
        return set()

    fetchable_map = {e["name"]: e["size_bytes"] for e in model_manifest.entries(data_dir)}
    _fetchable, unfetchable = assess.partition_fleet_fetchable(
        missing_models, fetchable_map, online_workers
    )
    return unfetchable


def create_job(
    workflow_json_text: str,
    workflow: dict,
    *,
    requirements: Optional[dict] = None,
    available_assets: Optional[set[str]] = None,
    origin: str = "console",
) -> str:
    """Assess a workflow and persist a queued Job row. Returns the job id.

    The single assess-and-persist path, shared by the console's
    `POST /api/jobs` and the ComfyUI-compatible `POST /comfy/api/prompt`, so
    the two entry points can never drift on what a job records (required
    nodes/models, VRAM estimate, declared input assets).

    `available_assets` is the set of input filenames the caller can actually
    supply; anything the workflow references beyond it raises
    `MissingAssetsError` before anything is written. Storing the asset bytes
    is the caller's job (they arrive as uploads in one case and from staging
    in the other).

    `origin` records who submitted the job -- `"console"` (the default, for
    ComfyFed's own `POST /api/jobs`) or `"panel"` (stamped explicitly by
    `comfyapi.post_prompt`). It is what lets the panel's own controls
    (`/comfy/api/interrupt`, `/comfy/api/queue`, panel history) act only on
    jobs the panel itself submitted.
    """
    needs = assess.extract(workflow)
    available = set(available_assets or ())

    missing = sorted(needs.assets - available)
    if missing:
        raise MissingAssetsError(missing)

    with db.get_session() as session:
        all_workers = session.query(db.Worker).all()
        est_vram_gb = assess.estimate_vram(needs.models, all_workers)

        job = db.Job(
            workflow_json=workflow_json_text,
            requirements=json.dumps(requirements or {}),
            required_nodes=json.dumps(sorted(needs.nodes)),
            required_models=json.dumps(sorted(needs.models)),
            est_vram_gb=est_vram_gb,
            input_assets=json.dumps(sorted(available)),
            origin=origin,
        )
        session.add(job)
        session.commit()
        return job.id


def _job_dict(job: db.Job) -> dict:
    d = {
        "id": job.id,
        "status": job.status,
        "origin": job.origin,
        "progress": job.progress,
        "worker_id": job.worker_id,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "error": job.error,
        "result_files": json.loads(job.result_files or "[]"),
        "input_assets": json.loads(job.input_assets or "[]"),
        "est_vram_gb": job.est_vram_gb,
    }
    # Phase 2.1: transient model-auto-fetch progress (stage/fetch_pct/
    # fetch_model), NOT a Job column -- see agentws._fetch_progress's
    # docstring. Added only while the job is actually in that phase, so an
    # ordinary job's dict shape is unchanged.
    fetch_progress = agentws.get_fetch_progress(job.id)
    if fetch_progress:
        d.update(fetch_progress)
    return d


def _receipt_dict(receipt: db.Receipt) -> dict:
    return {
        "gpu_seconds": receipt.gpu_seconds,
        "kind": receipt.kind,
        "billable": receipt.billable,
        "basis": receipt.basis,
        # Same "acked" name/semantics as reports.py's per-receipt listing:
        # the worker has countersigned this receipt (dual-signature flow in
        # agentws.py) once `worker_sig` is set.
        "acked": receipt.worker_sig is not None,
    }


def _job_dict_full(job: db.Job, receipt: Optional["db.Receipt"] = None) -> dict:
    d = _job_dict(job)
    d["workflow_json"] = json.loads(job.workflow_json)
    d["requirements"] = json.loads(job.requirements or "{}")
    d["required_nodes"] = json.loads(job.required_nodes or "[]")
    d["required_models"] = json.loads(job.required_models or "[]")
    d["started_at"] = job.started_at.isoformat() if job.started_at else None
    d["finished_at"] = job.finished_at.isoformat() if job.finished_at else None
    d["result_hashes"] = json.loads(job.result_hashes or "{}")
    d["receipt"] = _receipt_dict(receipt) if receipt is not None else None
    return d


def create_router(data_dir: str) -> APIRouter:
    r = APIRouter()

    @r.post("/api/jobs")
    async def submit_job(
        workflow_json: str = Form(...),
        requirements: Optional[str] = Form(default=None),
        assets: list[UploadFile] = File(default=[]),
        _payload: dict = Depends(auth.require_csrf),
    ):
        try:
            workflow = json.loads(workflow_json)
        except (TypeError, ValueError):
            raise _error(400, "jobs.invalid_workflow", "workflow_json is not valid JSON.")

        requirements_dict: dict = {}
        if requirements:
            try:
                requirements_dict = json.loads(requirements)
            except (TypeError, ValueError):
                raise _error(400, "jobs.invalid_workflow", "requirements is not valid JSON.")

        uploaded_names = []
        for upload in assets:
            try:
                filename = storage.sanitize_path_component(
                    upload.filename or "", what="asset filename"
                )
            except ValueError:
                raise _error(400, "jobs.bad_asset_name", f"Invalid asset filename: {upload.filename!r}")
            uploaded_names.append(filename)

        needs = assess.extract(workflow)
        unfetchable = unfetchable_missing_models(needs, data_dir)
        if unfetchable:
            names = sorted(unfetchable)
            raise _error(
                400,
                "jobs.missing_models",
                model_guide.guidance_message(names, data_dir),
            )

        try:
            job_id = create_job(
                workflow_json,
                workflow,
                requirements=requirements_dict,
                available_assets=set(uploaded_names),
                origin="console",
            )
        except MissingAssetsError as exc:
            raise _error(
                400,
                "jobs.missing_assets",
                f"Workflow references assets that were not uploaded: {', '.join(exc.missing)}",
            )

        job_dir = job_inputs_dir(data_dir, job_id)
        os.makedirs(job_dir, exist_ok=True)
        for upload, filename in zip(assets, uploaded_names):
            dest = os.path.join(job_dir, filename)
            content = await upload.read()
            with open(dest, "wb") as f:
                f.write(content)

        return {"job_id": job_id}

    @r.get("/api/jobs")
    def list_jobs(status: Optional[str] = None, _payload: dict = Depends(auth.require_admin)):
        with db.get_session() as session:
            query = session.query(db.Job)
            if status:
                statuses = [s.strip() for s in status.split(",") if s.strip()]
                if statuses:
                    query = query.filter(db.Job.status.in_(statuses))
            jobs = query.order_by(db.Job.created_at.asc()).all()
            return [_job_dict(j) for j in jobs]

    @r.get("/api/jobs/{job_id}")
    def get_job(job_id: str, _payload: dict = Depends(auth.require_admin)):
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")
            # A retried job can accumulate more than one receipt across
            # attempts; the newest one is what the detail page should show.
            receipt = (
                session.query(db.Receipt)
                .filter(db.Receipt.job_id == job_id)
                .order_by(db.Receipt.created_at.desc())
                .first()
            )
            return _job_dict_full(job, receipt)

    @r.get("/api/jobs/{job_id}/assessment")
    def get_job_assessment(job_id: str, _payload: dict = Depends(auth.require_admin)):
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")

            needs = assess.needs_from_job(job)

            try:
                requirements_override = json.loads(job.requirements or "{}")
            except (TypeError, ValueError):
                requirements_override = {}

            all_workers = session.query(db.Worker).filter(db.Worker.disabled == False).all()  # noqa: E712

        # Phase 2.1: same signed manifest dispatch/submission use, so the
        # assessment display's eligible_after_fetch column matches what would
        # actually happen at dispatch time -- built once, outside the session
        # above (model_manifest.entries opens its own).
        fetchable_models = {e["name"]: e["size_bytes"] for e in model_manifest.entries(data_dir)}

        results = []
        for worker in all_workers:
            v = assess.verdict(worker, needs, requirements_override, all_workers, fetchable_models)
            results.append(
                {
                    "worker_id": worker.id,
                    "name": worker.name,
                    "verdict": v.kind,
                    "reasons": v.reasons,
                    "warnings": v.warnings,
                    "missing_models": v.missing_models,
                }
            )
        return {"workers": results}

    @r.get("/api/agent/jobs/{job_id}/inputs/{filename}")
    def get_job_input(job_id: str, filename: str, worker: db.Worker = Depends(verify_agent)):
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")
            if job.worker_id != worker.id:
                raise _error(403, "jobs.not_assigned", "Job is not assigned to this worker.")
            try:
                input_assets = json.loads(job.input_assets or "[]")
            except (TypeError, ValueError):
                input_assets = []
            if filename not in input_assets:
                raise _error(404, "jobs.asset_not_found", "Asset not found for this job.")

        path = os.path.join(data_dir, _JOB_INPUTS_DIRNAME, job_id, filename)
        if not os.path.isfile(path):
            raise _error(404, "jobs.asset_not_found", "Asset not found for this job.")
        return FileResponse(path)

    @r.post("/api/agent/jobs/{job_id}/artifacts")
    async def upload_job_artifact(
        job_id: str,
        request: Request,
        worker: db.Worker = Depends(verify_agent),
    ):
        # Deliberately NOT declared as `file: UploadFile = File(...)`: FastAPI
        # parses declared File/Form params via `request.form()` *before* any
        # dependency runs, which would consume the body stream ahead of
        # `verify_agent`'s `request.body()` signature check (needed to
        # authenticate this multipart request) and blow up with "Stream
        # consumed". Parsing the form here, after verify_agent has already
        # cached the body, works because Starlette replays the cached body.
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")
            # Ownership OR the blip re-adoption window: a worker that went
            # offline mid-run and got requeued (dispatch.requeue_stale sets
            # status back to "queued" and records last_worker_id) may still
            # be uploading the result it produced before it dropped. This
            # check is deliberately read-only -- it does not flip ownership
            # itself; only a subsequent job_done's dispatch.try_readopt does
            # that (see agentws._handle_job_done).
            owns_it = job.worker_id == worker.id and job.status in ("assigned", "running")
            in_blip_window = job.status == "queued" and job.last_worker_id == worker.id
            if not (owns_it or in_blip_window):
                raise _error(403, "jobs.not_assigned", "Job is not assigned to this worker.")

        form = await request.form()
        file = form.get("file")
        if file is None or not hasattr(file, "file"):
            raise _error(400, "jobs.bad_asset_name", "Missing 'file' field.")

        try:
            artifact_name = storage.sanitize_path_component(
                file.filename or "", what="artifact filename"
            )
        except ValueError:
            raise _error(400, "jobs.bad_asset_name", f"Invalid artifact filename: {file.filename!r}")

        # Hash the bytes ourselves rather than trusting the agent's claim: this
        # is what lets a corrupted-in-transit or swapped artifact be caught
        # before it's persisted. `file.file` is a SpooledTemporaryFile already
        # fully buffered by `request.form()` above, so reading it through once
        # and seeking back to 0 costs no extra I/O round trip and leaves
        # `store.put` free to stream it to disk exactly as before.
        hasher = hashlib.sha256()
        for chunk in iter(lambda: file.file.read(1024 * 1024), b""):
            hasher.update(chunk)
        computed_sha256 = hasher.hexdigest()
        file.file.seek(0)

        # The header is optional for backward compatibility with older agents
        # that don't send it yet; when present, a mismatch means the bytes the
        # platform received are not the bytes the worker produced (corruption
        # or a swap in transit), so the upload is rejected outright.
        claimed_sha256 = request.headers.get("X-Artifact-SHA256")
        if claimed_sha256 and claimed_sha256.strip().lower() != computed_sha256:
            raise _error(
                400,
                "artifact.hash_mismatch",
                "Uploaded artifact does not match the declared X-Artifact-SHA256.",
            )

        store = storage.get_store(data_dir)
        stored = store.put(job_id, artifact_name, file.file)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is not None:
                try:
                    hashes = json.loads(job.result_hashes or "{}")
                except (TypeError, ValueError):
                    hashes = {}
                hashes[stored] = computed_sha256
                job.result_hashes = json.dumps(hashes)
                session.commit()

        return {"stored": stored, "sha256": computed_sha256}

    @r.get("/api/jobs/{job_id}/artifacts/{filename}")
    def get_job_artifact(job_id: str, filename: str, _payload: dict = Depends(auth.require_admin)):
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")

        store = storage.get_store(data_dir)
        try:
            # Streamed rather than read into memory: a job's artifact can be a
            # multi-hundred-MB video, and FileResponse also gives the browser
            # range requests and a correct Content-Length for free.
            path = store.path(job_id, filename)
        except (FileNotFoundError, ValueError):
            raise _error(404, "jobs.artifact_not_found", "Artifact not found.")
        return FileResponse(
            path, media_type="application/octet-stream", filename=os.path.basename(path)
        )

    @r.post("/api/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str, _payload: dict = Depends(auth.require_csrf)):
        """Cancel a queued/assigned/running job from the console.

        404 for an unknown job, 409 (with the terminal status in the body)
        for one that already finished, was already cancelled, or failed --
        cancelling twice, or cancelling something that finished moments
        before the request landed, must not stomp on a real result.

        The terminal case is decided by `cancel_and_notify`'s own return
        rather than by a separate status read beforehand: that read and the
        cancel were two decisions about the same job taken at two different
        moments, so a job finishing in between answered `{"status":
        "cancelled"}` for a job it had not cancelled. The status is only read
        back afterwards, to say *which* terminal state the caller lost to.
        """
        with db.get_session() as session:
            if session.get(db.Job, job_id) is None:
                raise _error(404, "jobs.not_found", "Job not found.")

        if not await agentws.cancel_and_notify(job_id, reason="cancelled by admin"):
            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                if job is None:
                    raise _error(404, "jobs.not_found", "Job not found.")
                status = job.status
            return JSONResponse(
                status_code=409,
                content={
                    "error": {
                        "code": "jobs.already_terminal",
                        "message": f"Job is already {status}.",
                    },
                    "status": status,
                },
            )

        return {"status": "cancelled"}

    @r.post("/api/jobs/{job_id}/retry")
    def retry_job(job_id: str, _payload: dict = Depends(auth.require_csrf)):
        """Requeue a failed job, clearing the previous attempt's outcome.

        Only `failed` jobs are retryable: anything queued/assigned/running is
        still in flight, and re-running a `done` job would orphan its receipt.
        """
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")
            if job.status != "failed":
                raise _error(409, "jobs.not_retryable", "Only failed jobs can be retried.")

            job.status = "queued"
            job.worker_id = None
            job.error = None
            job.progress = 0
            job.started_at = None
            job.finished_at = None
            session.commit()

        return {"ok": True, "job_id": job_id}

    return r
