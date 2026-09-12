"""Job submission, listing, and assessment API."""

from __future__ import annotations

import json
import os
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from . import assess, auth, db, storage
from .workers import verify_agent

_JOB_INPUTS_DIRNAME = "job_inputs"


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def _job_dict(job: db.Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "progress": job.progress,
        "worker_id": job.worker_id,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "error": job.error,
        "result_files": json.loads(job.result_files or "[]"),
        "input_assets": json.loads(job.input_assets or "[]"),
        "est_vram_gb": job.est_vram_gb,
    }


def _job_dict_full(job: db.Job) -> dict:
    d = _job_dict(job)
    d["workflow_json"] = json.loads(job.workflow_json)
    d["requirements"] = json.loads(job.requirements or "{}")
    d["required_nodes"] = json.loads(job.required_nodes or "[]")
    d["required_models"] = json.loads(job.required_models or "[]")
    d["started_at"] = job.started_at.isoformat() if job.started_at else None
    d["finished_at"] = job.finished_at.isoformat() if job.finished_at else None
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

        needs = assess.extract(workflow)

        uploaded_names = []
        for upload in assets:
            filename = os.path.basename(upload.filename or "")
            if not filename or filename != upload.filename:
                raise _error(400, "jobs.bad_asset_name", f"Invalid asset filename: {upload.filename!r}")
            uploaded_names.append(filename)

        missing = sorted(needs.assets - set(uploaded_names))
        if missing:
            raise _error(
                400,
                "jobs.missing_assets",
                f"Workflow references assets that were not uploaded: {', '.join(missing)}",
            )

        with db.get_session() as session:
            all_workers = session.query(db.Worker).all()
            est_vram_gb = assess.estimate_vram(needs.models, all_workers)

            job = db.Job(
                workflow_json=workflow_json,
                requirements=json.dumps(requirements_dict),
                required_nodes=json.dumps(sorted(needs.nodes)),
                required_models=json.dumps(sorted(needs.models)),
                est_vram_gb=est_vram_gb,
                input_assets=json.dumps(uploaded_names),
            )
            session.add(job)
            session.commit()
            job_id = job.id

        job_dir = os.path.join(data_dir, _JOB_INPUTS_DIRNAME, job_id)
        os.makedirs(job_dir, exist_ok=True)
        for upload in assets:
            filename = os.path.basename(upload.filename or "")
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
            return _job_dict_full(job)

    @r.get("/api/jobs/{job_id}/assessment")
    def get_job_assessment(job_id: str, _payload: dict = Depends(auth.require_admin)):
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            if job is None:
                raise _error(404, "jobs.not_found", "Job not found.")

            try:
                nodes = set(json.loads(job.required_nodes or "[]"))
            except (TypeError, ValueError):
                nodes = set()
            try:
                models = set(json.loads(job.required_models or "[]"))
            except (TypeError, ValueError):
                models = set()
            needs = assess.JobNeeds(nodes=nodes, models=models, est_vram_gb=job.est_vram_gb, assets=set())

            try:
                requirements_override = json.loads(job.requirements or "{}")
            except (TypeError, ValueError):
                requirements_override = {}

            all_workers = session.query(db.Worker).filter(db.Worker.disabled == False).all()  # noqa: E712

            results = []
            for worker in all_workers:
                v = assess.verdict(worker, needs, requirements_override, all_workers)
                results.append(
                    {
                        "worker_id": worker.id,
                        "name": worker.name,
                        "verdict": v.kind,
                        "reasons": v.reasons,
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
            if job.worker_id != worker.id or job.status not in ("assigned", "running"):
                raise _error(403, "jobs.not_assigned", "Job is not assigned to this worker.")

        form = await request.form()
        file = form.get("file")
        if file is None or not hasattr(file, "file"):
            raise _error(400, "jobs.bad_asset_name", "Missing 'file' field.")

        store = storage.get_store(data_dir)
        try:
            stored = store.put(job_id, file.filename or "", file.file)
        except ValueError:
            raise _error(400, "jobs.bad_asset_name", f"Invalid artifact filename: {file.filename!r}")

        return {"stored": stored}

    @r.get("/api/jobs/{job_id}/artifacts/{filename}")
    def get_job_artifact(job_id: str, filename: str, _payload: dict = Depends(auth.require_admin)):
        store = storage.get_store(data_dir)
        try:
            f = store.open(job_id, filename)
        except (FileNotFoundError, ValueError):
            raise _error(404, "jobs.artifact_not_found", "Artifact not found.")
        with f:
            content = f.read()
        return Response(content=content, media_type="application/octet-stream")

    return r
