import json
import uuid
from datetime import datetime, timezone as dt_timezone
from functools import wraps

import requests
from django.conf import settings
from django.contrib.auth.views import LoginView
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from .models import SimulationRun, SimulatorActionReceipt
from .src.simulator_engine import engine


def operator_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse({"ok": False, "message": "Simulator controls require login."}, status=401)
        if not request.user.is_staff:
            return JsonResponse({"ok": False, "message": "Simulator controls require operator access."}, status=403)
        return view(request, *args, **kwargs)

    return wrapped


def index(request):
    return render(
        request,
        "simulator_app/index.html",
        {"can_control": bool(request.user.is_authenticated and request.user.is_staff)},
    )


def _target_url():
    host = getattr(settings, "SIMULATOR_NIFI_HOST", "180.75.0.10")
    port = getattr(settings, "SIMULATOR_NIFI_PORT", 9080)
    path = str(getattr(settings, "SIMULATOR_NIFI_PATH", "aviat")).strip("/")
    return f"http://{host}:{port}/{path}"


@require_GET
def simulator_config(request):
    can_control = bool(request.user.is_authenticated and request.user.is_staff)
    ftp_by_vendor = getattr(settings, "SIMULATOR_FTP_BY_VENDOR", {})
    return JsonResponse({
        "vendors": ["aviat", "cambium"],
        "target": _target_url(),
        "rate": {"minimum_eps": 0.1, "maximum_eps": getattr(settings, "SIMULATOR_MAX_RATE_EPS", 100)},
        "modes": ["continuous", "bounded"],
        "profiles": ["ftp", "end_to_end_acceptance"],
        "controls_authenticated": can_control,
        "can_control": can_control,
        "source_profiles": {
            vendor: {"remote_dir": cfg.get("REMOTE_DIR"), "archive_dir": cfg.get("ARCHIVE_DIR")}
            for vendor, cfg in ftp_by_vendor.items()
        },
    })


@require_POST
@operator_required
def start_simulator(request):
    try:
        payload = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"ok": False, "message": "Invalid JSON body."}, status=400)

    profile = str(payload.get("profile") or "ftp").strip().lower()
    if profile not in {"ftp", "end_to_end_acceptance"}:
        return JsonResponse({"ok": False, "message": "Unknown simulator profile."}, status=400)

    vendor = str(payload.get("vendor") or ("aviat" if profile == "end_to_end_acceptance" else "")).strip().lower()
    if vendor not in {"aviat", "cambium"}:
        return JsonResponse({"ok": False, "message": "Vendor must be 'aviat' or 'cambium'."}, status=400)
    try:
        rate_eps = float(payload.get("rate_eps", payload.get("rate")))
        maximum = float(getattr(settings, "SIMULATOR_MAX_RATE_EPS", 100))
        if not 0.1 <= rate_eps <= maximum:
            raise ValueError
    except (TypeError, ValueError):
        return JsonResponse({"ok": False, "message": f"Rate must be between 0.1 and {maximum:g} events/sec."}, status=400)

    run_mode = str(payload.get("run_mode") or ("bounded" if profile == "end_to_end_acceptance" else "continuous")).strip().lower()
    if run_mode not in {"continuous", "bounded"}:
        return JsonResponse({"ok": False, "message": "Run mode must be continuous or bounded."}, status=400)
    event_limit = payload.get("event_limit")
    if profile == "end_to_end_acceptance":
        run_mode = "bounded"
        event_limit = 2
    if run_mode == "bounded":
        try:
            event_limit = int(event_limit)
            if event_limit < 1:
                raise ValueError
        except (TypeError, ValueError):
            return JsonResponse({"ok": False, "message": "A positive event limit is required for bounded runs."}, status=400)
    else:
        event_limit = None

    run_id = str(payload.get("run_id") or uuid.uuid4())
    try:
        run_uuid = uuid.UUID(run_id)
    except (ValueError, AttributeError):
        run_uuid = uuid.uuid4()
    cycle_id = str(payload.get("cycle_id") or f"agenticnoc_{vendor}-cycle-{run_uuid.hex[:24]}")[:96]
    config = {
        "run_id": run_id,
        "cycle_id": cycle_id,
        "vendor": vendor,
        "profile": profile,
        "rate_eps": rate_eps,
        "run_mode": run_mode,
        "event_limit": event_limit,
    }
    row = SimulationRun.objects.create(
        run_id=run_id,
        vendor=vendor,
        rate_eps=rate_eps,
        run_mode=run_mode,
        event_limit=event_limit,
        target=_target_url(),
        status="starting",
        cycle_id=cycle_id,
        profile=profile,
        started_at=timezone.now(),
        operator=request.user,
    )
    ok, message = engine.start(config)
    if not ok:
        row.status = "rejected"
        row.last_error = message
        row.stopped_at = timezone.now()
        row.save(update_fields=["status", "last_error", "stopped_at"])
    return JsonResponse({"ok": ok, "message": message, "run_id": run_id, "cycle_id": cycle_id, "profile": profile}, status=200 if ok else 409)


@require_POST
@operator_required
def stop_simulator(request):
    del request
    ok, message = engine.stop()
    return JsonResponse({"ok": ok, "message": message}, status=200 if ok else 409)


@require_GET
def simulator_status(request):
    del request
    return JsonResponse(engine.get_status())


def _internal_authorized(request):
    expected = str(getattr(settings, "SIMULATOR_INTERNAL_TOKEN", "") or "").strip()
    if not expected:
        return True
    received = request.headers.get("Authorization", "")
    return received == f"Bearer {expected}"


SUPPORTED_ACTIONS = {
    "ACM_MODULATION_HOLD", "CONFIG_ROLLBACK", "VERIFY_STANDBY_AND_REPAIR_PRIMARY",
    "HOLD_DOWN_AND_CONNECTOR_CHECK", "CAPACITY_OPTIMIZATION_RECOMMENDATION",
    "ENVIRONMENTAL_FIELD_INSPECTION", "ATPC_POWER_BOOST", "DISPATCH_RECOMMENDATION",
}


def _action_authorized(request):
    """Actions fail closed even when the read-only probe token is unset."""
    expected = str(getattr(settings, "SIMULATOR_INTERNAL_TOKEN", "") or "").strip()
    return bool(expected) and request.headers.get("Authorization", "") == f"Bearer {expected}"


@require_POST
def simulator_action(request):
    """Accept an already-approved, simulator-only action exactly once."""
    if not _action_authorized(request):
        return JsonResponse({"execution_state": "rejected", "rejection_reason": "invalid or unconfigured simulator action token"}, status=403)
    try:
        payload = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"execution_state": "rejected", "rejection_reason": "invalid JSON body"}, status=400)
    required = ("approval_id", "incident_id", "scenario", "action_type", "idempotency_key", "target_resources")
    missing = [key for key in required if payload.get(key) in (None, "", [])]
    if missing:
        return JsonResponse({"execution_state": "rejected", "rejection_reason": f"missing required field(s): {', '.join(missing)}"}, status=400)
    if payload.get("approval_status") and str(payload.get("approval_status")).lower() != "approved":
        return JsonResponse({"execution_state": "rejected", "rejection_reason": "approval is not approved"}, status=409)
    if payload.get("approval_expires_at"):
        try:
            expiry = datetime.fromisoformat(str(payload["approval_expires_at"]).replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=dt_timezone.utc)
            if expiry <= datetime.now(dt_timezone.utc):
                return JsonResponse({"execution_state": "rejected", "rejection_reason": "approval is expired"}, status=409)
        except ValueError:
            return JsonResponse({"execution_state": "rejected", "rejection_reason": "approval expiry is invalid"}, status=400)
    action_type = str(payload.get("action_type") or "").strip().upper()
    if action_type not in SUPPORTED_ACTIONS:
        return JsonResponse({"execution_state": "rejected", "rejection_reason": "unsupported simulator action"}, status=422)
    targets = payload.get("target_resources")
    if not isinstance(targets, list) or not all(isinstance(item, dict) for item in targets):
        return JsonResponse({"execution_state": "rejected", "rejection_reason": "target_resources must be a list of objects"}, status=400)
    idem = str(payload.get("idempotency_key"))[:160]
    existing = SimulatorActionReceipt.objects.filter(idempotency_key=idem).first()
    if existing:
        if (
            existing.action_type != action_type
            or existing.scenario != str(payload.get("scenario"))[:64]
            or existing.target_resources != targets[:64]
        ):
            return JsonResponse({"execution_state": "rejected", "rejection_reason": "idempotency key is already bound to a different action"}, status=409)
        body = {
            "receipt_id": existing.receipt_id,
            "execution_state": existing.execution_state,
            "accepted_targets": existing.target_resources,
            "generated_evidence_identifiers": existing.generated_evidence_identifiers,
            "expected_verification_deadline": existing.expected_verification_window,
            "idempotent_replay": True,
        }
        return JsonResponse(body, status=200)
    receipt_id = f"simulator-action-{uuid.uuid4()}"
    evidence = [
        f"simulator:{receipt_id}:action-accepted",
        f"simulator:{receipt_id}:alarm-follow-up",
        f"simulator:{receipt_id}:pm-config-follow-up",
    ]
    row = SimulatorActionReceipt.objects.create(
        receipt_id=receipt_id,
        approval_id=str(payload["approval_id"]),
        incident_id=str(payload["incident_id"]),
        scenario=str(payload["scenario"])[:64],
        action_type=action_type,
        target_resources=targets[:64],
        idempotency_key=idem,
        expected_verification_window=payload.get("expected_verification_window") if isinstance(payload.get("expected_verification_window"), dict) else {"value": payload.get("expected_verification_window")},
        execution_state="accepted",
        generated_evidence_identifiers=evidence,
    )
    follow_up_delivery = engine.send_action_followups(
        payload.get("follow_up_events") or [],
        cycle_id=str(payload.get("replay_cycle_id") or "")[:96],
        action_id=row.receipt_id,
    )
    telemetry_follow_up_delivery = engine.send_action_telemetry_followups(
        payload.get("target_resources") or [],
        incident_id=str(payload.get("incident_id") or ""),
        scenario=str(payload.get("scenario") or ""),
        cycle_id=str(payload.get("replay_cycle_id") or "")[:96],
        action_id=row.receipt_id,
    )
    # The receipt records acceptance only.  Follow-up delivery is evidence,
    # not proof of restoration; the normal simulator->NiFi->RabbitMQ path
    # remains the source of truth for lifecycle verification.
    return JsonResponse({
        "receipt_id": row.receipt_id,
        "accepted_targets": row.target_resources,
        "execution_state": row.execution_state,
        "generated_evidence_identifiers": evidence,
        "expected_verification_deadline": row.expected_verification_window,
        "follow_up_delivery": follow_up_delivery,
        "telemetry_follow_up_delivery": telemetry_follow_up_delivery,
    }, status=202)


@require_GET
def simulator_internal_status(request):
    if not _internal_authorized(request):
        return JsonResponse({"status": "unavailable", "error": "invalid internal probe token"}, status=403)
    return JsonResponse(engine.get_status())


@require_GET
def simulator_history(request):
    try:
        minutes = max(1, min(int(request.GET.get("minutes", 30)), 180))
    except (TypeError, ValueError):
        minutes = 30
    return JsonResponse({"buckets": engine.get_history(minutes=minutes)})


@require_GET
def simulator_runs(request):
    del request
    rows = []
    for row in SimulationRun.objects.all()[:50]:
        rows.append({
            "run_id": row.run_id,
            "cycle_id": row.cycle_id,
            "profile": row.profile,
            "vendor": row.vendor,
            "rate_eps": row.rate_eps,
            "run_mode": row.run_mode,
            "event_limit": row.event_limit,
            "target": row.target,
            "status": row.status,
            "started_at": row.started_at.isoformat() if row.started_at else None,
            "stopped_at": row.stopped_at.isoformat() if row.stopped_at else None,
            "stats": {"files_processed": row.files_processed, "alarms_sent": row.alarms_sent, "successful": row.successful, "failed": row.failed},
            "last_error": row.last_error or None,
        })
    return JsonResponse({"runs": rows})


@require_GET
def simulator_pipeline(request):
    del request
    runtime_url = str(getattr(settings, "SIMULATOR_AGENTICNOC_RUNTIME_URL", "") or "").strip()
    if not runtime_url:
        return JsonResponse({"status": "unavailable", "available": False, "error": "AgenticNOC runtime URL is not configured"})
    try:
        response = requests.get(runtime_url, timeout=3)
        payload = response.json()
        if response.status_code != 200:
            return JsonResponse({"status": "unavailable", "available": False, "error": f"AgenticNOC runtime returned HTTP {response.status_code}"}, status=200)
        return JsonResponse(payload, status=200)
    except Exception as exc:  # read-only proxy must never break Simulator UI
        return JsonResponse({"status": "unavailable", "available": False, "error": str(exc)[:240]}, status=200)


@require_GET
def simulator_metrics(request):
    del request
    payload = engine.get_status()
    stats = payload.get("stats") or {}
    rates = payload.get("rates") or {}
    latency = payload.get("latency") or {}
    lines = [
        "# HELP simulator_run_active Whether a simulation run is active.",
        "# TYPE simulator_run_active gauge",
        f"simulator_run_active {1 if payload.get('status') in {'starting', 'running', 'stopping'} else 0}",
        "# TYPE simulator_run_state gauge",
        f"simulator_run_state{{state=\"{payload.get('status') or 'unknown'}\"}} 1",
        "# TYPE simulator_run_completed_total counter",
        f"simulator_run_completed_total {1 if payload.get('status') == 'completed' else 0}",
        "# TYPE simulator_alarms_sent_total counter",
        f"simulator_alarms_sent_total {int(stats.get('alarms_sent') or 0)}",
        "# TYPE simulator_alarms_successful_total counter",
        f"simulator_alarms_successful_total {int(stats.get('successful') or 0)}",
        "# TYPE simulator_alarms_failed_total counter",
        f"simulator_alarms_failed_total {int(stats.get('failed') or 0)}",
        "# TYPE simulator_send_rate_eps gauge",
        f"simulator_send_rate_eps {float(rates.get('send_eps') or 0)}",
        "# TYPE simulator_request_latency_p95_ms gauge",
        f"simulator_request_latency_p95_ms {float(latency.get('p95_ms') or 0)}",
    ]
    return HttpResponse("\n".join(lines) + "\n", content_type="text/plain; version=0.0.4; charset=utf-8")


class SimulatorLoginView(LoginView):
    template_name = "registration/login.html"
