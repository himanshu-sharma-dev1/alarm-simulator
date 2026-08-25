"""
Runs the Aviat/Cambium alarm-CSV -> NiFi simulator as a background thread
inside the Django process, so the web UI's Start/Stop buttons control a
real long-running job instead of just flipping CSS classes.

This is a straight port of the standalone script's logic (should_use_file,
post_csv_event, send_file_rows, the polling while-loop) into a class with
start()/stop()/get_status(), so it can report progress back to the browser
via a JSON status endpoint.

Maintains a rolling per-minute success/failed count in Redis so the UI can
render a "last 30 minutes" history chart.

If Redis isn't reachable, history is disabled and no in-memory fallback
is used. The UI can check redis_available to decide whether to show the
history chart.
"""

import csv
from ftplib import FTP, error_perm
import io
import statistics
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

import requests
from django.conf import settings
from django.db import close_old_connections
from django.utils import timezone as django_timezone

try:
    import redis as redis_lib
except ImportError:
    redis_lib = None


ONLY_NAME_CONTAINS = "alarm"
FILE_DELAY_SECONDS = 3.0
IDLE_POLL_SECONDS = 5.0
MAX_LOG_ENTRIES = 200
ACCEPTANCE_PROFILE = "end_to_end_acceptance"

HISTORY_KEY_PREFIX = "simulator:minute:"
HISTORY_BUCKET_TTL_SECONDS = 3600
HISTORY_DEFAULT_MINUTES = 30


class SimulatorEngine:
    """Thread-safe start/stop/status wrapper around the simulator loop."""

    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self._stop_event = threading.Event()
        self._reset_state()

        self._redis = None

        if redis_lib is not None:
            try:
                redis_host = getattr(settings, "REDIS_HOST", "180.75.0.15")
                redis_port = int(getattr(settings, "REDIS_PORT", 6379))
                redis_db = int(getattr(settings, "REDIS_DB", 0))
                client = redis_lib.Redis(
                    host=redis_host,
                    port=redis_port,
                    db=redis_db,
                    decode_responses=True,
                    socket_connect_timeout=0.5,
                )

                client.ping()
                self._redis = client

            except Exception as exc:  # noqa: BLE001
                self._redis = None
                self._log(f"Redis unavailable: {exc}")

        else:
            self._log(
                "Redis unavailable: redis package is not installed."
            )

        self._reconcile_orphaned_runs()

    def _reset_state(self):
        self.status = "stopped"
        self.config = {}
        self.run_id = None
        self.started_at = None
        self.stopped_at = None
        self.stats = {
            "files_processed": 0,
            "files_matched": 0,
            "rows_sampled": 0,
            "alarms_sent": 0,
            "successful": 0,
            "failed": 0,
        }
        self.current_file = None
        self.current_row = None
        self.last_response = None
        self.last_activity = None
        self.error_message = None
        self.logs = []
        self._latencies_ms = []
        self._last_rate_at = None
        self._last_rate_count = 0
        self.completion_reason = None

    def is_running(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self, config):
        """Start one server-managed simulation run."""
        with self._lock:
            if self.is_running():
                return False, "Simulator is already running."

            self._reset_state()
            self.run_id = str(config.get("run_id") or uuid.uuid4())
            self.started_at = django_timezone.now()
            self.config = {
                **config,
                "host": getattr(settings, "SIMULATOR_NIFI_HOST", "180.75.0.10"),
                "port": int(getattr(settings, "SIMULATOR_NIFI_PORT", 9080)),
                "path": getattr(settings, "SIMULATOR_NIFI_PATH", "aviat"),
                "rate": float(config.get("rate_eps") or config.get("rate") or 1),
                "run_mode": config.get("run_mode", "continuous"),
                "event_limit": config.get("event_limit"),
            }
            self.status = "starting"
            self._stop_event.clear()

            # Persist the resolved identity before the worker starts. This
            # prevents a fast FTP/configuration error from being overwritten
            # by the view after the worker has already reached a terminal state.
            self._persist_run()

            self._thread = threading.Thread(
                target=self._run_loop,
                # The request payload does not contain resolved host/port/path
                # settings. Pass the immutable resolved snapshot instead.
                args=(dict(self.config),),
                daemon=True,
            )

            self._thread.start()

            self._log(f"Run {self.run_id} started - {self.config['vendor'].upper()} -> {self._target_url()}")

            self._log(f"Configured rate: {self.config['rate']} alarm(s) per second ({self.config['run_mode']})")

            return True, "Simulator started."

    def stop(self):
        with self._lock:
            if not self.is_running():
                return False, "Simulator is not running."

            self._stop_event.set()
            self.status = "stopping"
            self._log("Stop requested; waiting for the active request to finish.")

        # Give the loop a moment to notice the stop flag and exit cleanly
        # (it checks between rows, so this is normally sub-second) without
        # blocking the HTTP request indefinitely if a POST is mid-flight.
        if self._thread:
            self._thread.join(timeout=5.0)

        with self._lock:
            if self._thread and self._thread.is_alive():
                self._persist_run()
                return True, "Stop requested; the current HTTP request is still finishing."
            if self.status == "stopping":
                self.status = "stopped"
            self.stopped_at = self.stopped_at or django_timezone.now()
            self._log("Simulator stopped.")
            self._persist_run()

        return True, "Simulator stopped."

    def get_status(self):
        with self._lock:
            now = django_timezone.now()
            end = self.stopped_at if self.status in {"completed", "stopped", "error", "interrupted"} else now
            uptime = (end - self.started_at).total_seconds() if self.started_at and end else 0
            elapsed = max(0.001, uptime)
            sent = int(self.stats.get("alarms_sent", 0))
            rates = {"send_eps": round(sent / elapsed, 3) if self.started_at else 0.0}
            latency_values = list(self._latencies_ms)
            return {
                "status": self.status,
                "run_id": self.run_id,
                "cycle_id": self.config.get("cycle_id"),
                "profile": self.config.get("profile", "ftp"),
                "started_at": self.started_at.isoformat() if self.started_at else None,
                "stopped_at": self.stopped_at.isoformat() if self.stopped_at else None,
                "uptime_seconds": round(uptime, 3) if self.started_at else 0,
                "stats": dict(self.stats),
                "vendor": self.config.get("vendor"),
                "run_mode": self.config.get("run_mode"),
                "event_limit": self.config.get("event_limit"),
                "completion_reason": self.completion_reason,
                "target": self._target_url() if self.config else None,
                "rates": rates,
                "latency": {
                    "samples": len(latency_values),
                    "last_ms": round(latency_values[-1], 2) if latency_values else None,
                    "p50_ms": round(statistics.median(latency_values), 2) if latency_values else None,
                    "p95_ms": round(self._percentile(latency_values, 0.95), 2) if latency_values else None,
                    "max_ms": round(max(latency_values), 2) if latency_values else None,
                },
                "current_file": self.current_file,
                "current_row": self.current_row,
                "current_alarm": self.current_row,
                "last_response": self.last_response,
                "last_activity": self.last_activity,
                "error_message": self.error_message,
                "logs": list(self.logs),

                # History depends on Redis only.
                "redis_available": self._redis is not None,
            }

    def _reconcile_orphaned_runs(self):
        """Mark rows from a previous process as interrupted, never running."""
        try:
            close_old_connections()
            from ..models import SimulationRun
            SimulationRun.objects.filter(
                status__in=("starting", "running", "stopping")
            ).update(
                status="interrupted",
                stopped_at=django_timezone.now(),
                last_error="Simulator process restarted before the run completed.",
            )
        except Exception:
            # Startup must remain available even before migrations/database are
            # ready; reconciliation is best effort.
            return

    def _target_url(self):
        if not self.config:
            return None
        return self._build_url(self.config["host"], self.config["port"], self.config["path"])

    @staticmethod
    def _percentile(values, percentile):
        if not values:
            return 0.0
        ordered = sorted(values)
        index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * percentile))))
        return ordered[index]

    def _persist_run(self):
        if not self.run_id:
            return
        try:
            close_old_connections()
            from ..models import SimulationRun

            row = SimulationRun.objects.filter(run_id=self.run_id).first()
            if row:
                row.status = self.status
                row.stopped_at = self.stopped_at
                row.files_processed = self.stats.get("files_processed", 0)
                row.alarms_sent = self.stats.get("alarms_sent", 0)
                row.successful = self.stats.get("successful", 0)
                row.failed = self.stats.get("failed", 0)
                row.last_error = self.error_message or ""
                row.cycle_id = self.config.get("cycle_id", "")
                row.profile = self.config.get("profile", "ftp")
                row.save(update_fields=["status", "stopped_at", "files_processed", "alarms_sent", "successful", "failed", "last_error", "cycle_id", "profile"])
        except Exception:
            return

    def get_history(self, minutes=HISTORY_DEFAULT_MINUTES):
        """Returns oldest -> newest per-minute successful/failed counts."""

        # Redis unavailable -> no history.
        if self._redis is None:
            return []

        now_minute = int(time.time() // 60)
        buckets = []

        for i in range(minutes - 1, -1, -1):
            minute_epoch = now_minute - i

            successful, failed = self._read_bucket(
                minute_epoch
            )

            buckets.append(
                {
                    "time": datetime.fromtimestamp(
                        minute_epoch * 60
                    ).strftime("%H:%M"),
                    "successful": successful,
                    "failed": failed,
                }
            )

        return buckets

    # ------------------------------------------------------------------ #
    # Internal helpers - ported from the standalone script
    # ------------------------------------------------------------------ #

    def _log(self, message):
        self.logs.append(
            {
                "time": datetime.now().strftime("%H:%M:%S"),
                "message": message,
            }
        )

        if len(self.logs) > MAX_LOG_ENTRIES:
            self.logs = self.logs[-MAX_LOG_ENTRIES:]

    def _record_result(self, success: bool):
        """
        Record success/failure history in Redis.

        Redis is mandatory for history.
        If Redis is unavailable, do not create any in-memory history.
        """

        if self._redis is None:
            return

        minute_epoch = int(time.time() // 60)
        field = "successful" if success else "failed"

        try:
            key = f"{HISTORY_KEY_PREFIX}{minute_epoch}"

            self._redis.hincrby(
                key,
                field,
                1,
            )

            self._redis.expire(
                key,
                HISTORY_BUCKET_TTL_SECONDS,
            )

        except Exception as exc:  # noqa: BLE001
            self._redis = None

            self._log(
                f"Redis unavailable: {exc}. History disabled."
            )

    def _read_bucket(self, minute_epoch):
        """
        Read one minute bucket from Redis.

        If Redis is unavailable, return no history data.
        """

        if self._redis is None:
            return 0, 0

        try:
            data = self._redis.hgetall(
                f"{HISTORY_KEY_PREFIX}{minute_epoch}"
            )

            return (
                int(data.get("successful", 0)),
                int(data.get("failed", 0)),
            )

        except Exception as exc:  # noqa: BLE001
            self._redis = None

            self._log(
                f"Redis unavailable: {exc}. History disabled."
            )

            return 0, 0

    @staticmethod
    def _build_url(host, port, path):
        return f"http://{host}:{port}/{str(path).strip('/')}"

    @staticmethod
    def _should_use_file_name(file_name):
        return (
            str(file_name).lower().endswith(".csv")
            and ONLY_NAME_CONTAINS in str(file_name).lower()
        )

    def _connect_ftp(self):
        ftp_config = getattr(settings, "SIMULATOR_FTP", {})
        ftp = FTP()
        ftp.connect(ftp_config["HOST"], timeout=30)
        ftp.login(ftp_config["USERNAME"], ftp_config["PASSWORD"])
        return ftp

    @staticmethod
    def _ftp_join(*parts):
        return "/".join(str(part).strip("/") for part in parts if str(part).strip("/"))

    @staticmethod
    def _ensure_ftp_dir(ftp, remote_dir):
        try:
            ftp.mkd(remote_dir)
        except error_perm as exc:
            if not str(exc).startswith("550"):
                raise

    def _list_ftp_alarm_files(self, ftp, remote_dir):
        ftp.cwd(remote_dir)
        return sorted(
            Path(file_name).name
            for file_name in ftp.nlst()
            if self._should_use_file_name(Path(file_name).name)
        )

    @staticmethod
    def _download_ftp_text(ftp, remote_file):
        buffer = io.BytesIO()
        ftp.retrbinary(f"RETR {remote_file}", buffer.write)
        return buffer.getvalue().decode("utf-8-sig")

    def _archive_ftp_file(self, ftp, remote_dir, archive_dir, file_name):
        self._ensure_ftp_dir(ftp, archive_dir)
        source = "/" + self._ftp_join(remote_dir, file_name)
        target = "/" + self._ftp_join(archive_dir, file_name)
        try:
            ftp.rename(source, target)
        except error_perm:
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            target = "/" + self._ftp_join(archive_dir, f"{timestamp}-{file_name}")
            ftp.rename(source, target)
        self._log(f"Moved {file_name} to {target}")

    @staticmethod
    def _post_csv_event(
        nifi_url,
        payload,
        source_file,
        row_num,
        cycle_id="",
        vendor="aviat",
        timeout=60,
    ):
        headers = {
            "Content-Type": "text/csv",
            "X-Original-Filename": source_file,
            "X-Row-Number": str(row_num),
            "X-Vendor": vendor,
            "cycle_id": cycle_id,
            "source_file": source_file,
            "row_index": str(row_num),
        }

        started = time.perf_counter()
        response = requests.post(
            nifi_url,
            data=payload.encode("utf-8"),
            headers=headers,
            timeout=timeout,
        )

        response.raise_for_status()

        return response.status_code, (time.perf_counter() - started) * 1000

    @staticmethod
    def _action_follow_up_csv(event: dict, *, now: str) -> tuple[str, str]:
        """Serialize one approved-action clear as a normal vendor CSV row."""
        vendor = str(event.get("vendor") or "aviat").strip().lower()
        external_id = str(event.get("external_alarm_id") or event.get("alarm_key") or "").split(":", 1)[-1]
        site_id = str(event.get("site_id") or "")
        node_id = str(event.get("node_id") or event.get("object") or "")
        raised = str(event.get("raised_at") or now)
        if vendor == "cambium":
            header = ["Source", "Message", "Source Type", "Name", "Severity", "Alarm Status", "Raised Time", "Clear Time", "Duration (Sec.)"]
            row = [site_id, str(event.get("event") or "Action follow-up clear"), "Radio", node_id or "RADIO", "Cleared", "Cleared", raised, now, "0"]
        else:
            header = ["Event", "Object", "Site", "Raised", "Event ID", "Device Raised", "Severity", "State", "Cleared"]
            row = [str(event.get("event") or "Action follow-up clear"), node_id or "Radio", site_id, raised, external_id, raised, "Cleared", "Cleared", now]
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(header)
        writer.writerow(row)
        return vendor, output.getvalue()

    def send_action_followups(self, events: list[dict], *, cycle_id: str = "", action_id: str = "") -> list[dict]:
        """Deliver action follow-ups through the configured NiFi CSV ingress.

        This method deliberately has no direct AgenticNOC/database coupling.
        A failed delivery is returned as evidence on the action receipt; the
        simulator still reports the action itself as accepted, while the
        stream remains the authority for restoration verification.
        """
        if not isinstance(events, list) or not events:
            return []
        host = getattr(settings, "SIMULATOR_NIFI_HOST", "180.75.0.10")
        port = getattr(settings, "SIMULATOR_NIFI_PORT", 9080)
        path = str(getattr(settings, "SIMULATOR_NIFI_PATH", "aviat")).strip("/")
        nifi_url = self._build_url(host, port, path)
        now = django_timezone.now().strftime("%Y-%m-%d %H:%M:%S")
        deliveries = []
        for index, event in enumerate(events[:64], start=1):
            if not isinstance(event, dict):
                deliveries.append({"index": index, "status": "rejected", "error": "event must be an object"})
                continue
            try:
                vendor, payload = self._action_follow_up_csv(event, now=now)
                status_code, latency_ms = self._post_csv_event(
                    nifi_url,
                    payload,
                    f"action-follow-up-{action_id or cycle_id or 'simulator'}.csv",
                    index,
                    cycle_id=cycle_id,
                    vendor=vendor,
                    timeout=10,
                )
                deliveries.append({"index": index, "status": "delivered", "vendor": vendor, "http_status": status_code, "latency_ms": round(latency_ms, 2)})
            except Exception as exc:  # source evidence remains truthful on ingress failure
                deliveries.append({"index": index, "status": "failed", "error": str(exc)[:500]})
        return deliveries

    def send_action_telemetry_followups(
        self,
        target_resources: list[dict],
        *,
        incident_id: str = "",
        scenario: str = "",
        cycle_id: str = "",
        action_id: str = "",
    ) -> dict:
        """Post simulated recovery PM/config through canonical APIs.

        This is deliberately optional: an unset AgenticNOC base URL returns
        an explicit unavailable result, while configured calls use the same
        vendor ingestion endpoints as normal data. The action receipt is
        carried in headers and raw-record metadata for correlation; receipt
        acceptance is never treated as restoration proof.
        """
        base = str(getattr(settings, "SIMULATOR_AGENTICNOC_BASE_URL", "") or "").strip().rstrip("/")
        if not base:
            return {"status": "unavailable", "reason": "SIMULATOR_AGENTICNOC_BASE_URL is not configured", "performance": [], "config": []}
        token = str(getattr(settings, "SIMULATOR_AGENTICNOC_INTERNAL_TOKEN", "") or "").strip()
        now = django_timezone.now().strftime("%Y-%m-%d %H:%M:%S")
        headers = {
            "Content-Type": "application/json",
            "X-Action-Receipt-ID": action_id,
            "X-Incident-ID": str(incident_id),
            "X-Replay-Cycle-ID": str(cycle_id),
            "X-Scenario": str(scenario),
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        performance = []
        config = []
        for item in (target_resources or [])[:64]:
            if not isinstance(item, dict) or str(item.get("resource_type") or item.get("type") or "node").lower() != "node":
                continue
            node_id = str(item.get("resource_id") or item.get("id") or "").strip()
            if not node_id:
                continue
            common = {
                "Action Receipt ID": action_id,
                "Incident ID": str(incident_id),
                "Replay Cycle ID": str(cycle_id),
                "Scenario": str(scenario),
            }
            performance_record = {
                **common,
                "Time Stamp": now,
                "Device Type": "WTM 4800",
                "Interface": node_id,
                "RSL Mean (dBm)": -48.0,
                "SNR Mean (dB)": 25.0,
            }
            config_record = {
                **common,
                "IP": "0.0.0.0",
                "Name": node_id,
                "Link Name": f"SIMULATED-{node_id}",
                "Node ID": node_id,
                "Peer Node ID": "SIMULATED_PEER",
            }
            for kind, record, target, collection in (
                ("performance", performance_record, f"{base}/api/ingestion/performance/aviat/", performance),
                ("config", config_record, f"{base}/api/ingestion/config/aviat/", config),
            ):
                try:
                    response = requests.post(target, json={"records": [record]}, headers=headers, timeout=10)
                    body = response.json() if response.content else {}
                    collection.append({"node_id": node_id, "status": "accepted" if response.ok else "rejected", "http_status": response.status_code, "response": body})
                except Exception as exc:  # telemetry gaps remain visible to verification
                    collection.append({"node_id": node_id, "status": "failed", "error": str(exc)[:500]})
        return {"status": "ok", "performance": performance, "config": config}

    def _record_post(self, nifi_url, payload, source_file, row_num, vendor):
        """Post one row and update counters consistently for every profile."""
        with self._lock:
            self.stats["alarms_sent"] += 1
            self.stats["rows_sampled"] += 1
        try:
            status_code, latency_ms = self._post_csv_event(
                nifi_url,
                payload,
                source_file,
                row_num,
                self.config.get("cycle_id", ""),
                vendor,
            )
            with self._lock:
                self.stats["successful"] += 1
                self._latencies_ms.append(latency_ms)
                if len(self._latencies_ms) > 500:
                    self._latencies_ms = self._latencies_ms[-500:]
            self.last_response = f"HTTP {status_code}"
            self._record_result(success=True)
            return True
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self.stats["failed"] += 1
            self.last_response = f"Error: {exc}"
            self._log(f"Failed alarm {row_num} from {source_file}: {exc}")
            self._record_result(success=False)
            return False

    def _send_file_rows(
        self,
        file_name,
        raw_text,
        nifi_url,
        row_delay,
        vendor,
    ):
        raw_lines = raw_text.splitlines()

        if vendor == "aviat":
            if len(raw_lines) < 3:
                self._log(
                    f"Skipping {file_name}: "
                    "not enough lines for Aviat format"
                )
                return

            lines_to_process = raw_lines[2:]

        else:
            # cambium
            if len(raw_lines) < 2:
                self._log(
                    f"Skipping {file_name}: "
                    "not enough lines for Cambium format"
                )
                return

            lines_to_process = raw_lines

        reader = list(
            csv.reader(lines_to_process)
        )

        if len(reader) < 2:
            self._log(
                f"Skipping {file_name}: "
                "missing header or data rows"
            )
            return

        header, data_rows = reader[0], reader[1:]

        self.current_file = file_name

        for idx, row in enumerate(
            data_rows,
            start=1,
        ):
            if self._stop_event.is_set():
                break
            limit = self.config.get("event_limit")
            if limit and self.stats.get("alarms_sent", 0) >= int(limit):
                self._stop_event.set()
                break

            output = io.StringIO()

            writer = csv.writer(output)

            writer.writerow(header)
            writer.writerow(row)

            payload = output.getvalue()

            self.current_row = idx

            success = self._record_post(nifi_url, payload, file_name, idx, vendor)
            self._log(f"Sent alarm {idx} from {file_name} -> {self.last_response}")

            self.last_activity = (
                datetime.now().strftime("%H:%M:%S")
            )

            self._stop_event.wait(row_delay)

        with self._lock:
            self.stats["files_processed"] += 1

    def _acceptance_payloads(self, vendor):
        site = str(getattr(settings, "SIMULATOR_ACCEPTANCE_SITE_ID", "UEMWBSNA01"))
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        if vendor == "cambium":
            header = ["Source", "Message", "Source Type", "Name", "Severity", "Alarm Status", "Raised Time", "Clear Time", "Duration (Sec.)"]
            rows = [
                [site, "Device is Offline", "Site", "STATUS", "Critical", "Active", now, "", "0"],
                [site, "Remote Fade Margin Low", "Radio", "RADIO", "Major", "Active", now, "", "0"],
            ]
        else:
            header = ["Event", "Object", "Site", "Raised", "Event ID", "Device Raised", "Severity", "State", "Cleared"]
            rows = [
                ["Device is Offline", "Site", site, now, f"accept-{self.run_id}-1", now, "Critical", "Active", ""],
                ["Remote Fade Margin Low", "Radio", site, now, f"accept-{self.run_id}-2", now, "Major", "Active", ""],
            ]
        for row in rows:
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(header)
            writer.writerow(row)
            yield output.getvalue()

    def _run_acceptance(self, config, nifi_url):
        source_file = f"acceptance-{self.config.get('cycle_id', self.run_id)}.csv"
        for index, payload in enumerate(self._acceptance_payloads(config["vendor"]), start=1):
            if self._stop_event.is_set():
                return
            self.current_file = source_file
            self.current_row = index
            self._record_post(nifi_url, payload, source_file, index, config["vendor"])
            self.last_activity = datetime.now().strftime("%H:%M:%S")
            self._log(f"Acceptance event {index}/2 delivered ({self.last_response})")
            if self._stop_event.wait(1.0 / float(config["rate"])):
                return
        self.completion_reason = "bounded acceptance profile delivered"

    def _run_loop(self, config):
        try:
            with self._lock:
                if self.status == "starting":
                    self.status = "running"
            self._persist_run()
            if config.get("profile") == ACCEPTANCE_PROFILE:
                nifi_url = self._build_url(config["host"], config["port"], config["path"])
                self._run_acceptance(config, nifi_url)
                with self._lock:
                    if not self._stop_event.is_set() and self.status != "error":
                        self.status = "completed"
                        self.completion_reason = self.completion_reason or "acceptance profile complete"
                    self.stopped_at = django_timezone.now()
                self._persist_run()
                return

            ftp_by_vendor = getattr(settings, "SIMULATOR_FTP_BY_VENDOR", {})
            ftp_config = ftp_by_vendor.get(config["vendor"]) or getattr(settings, "SIMULATOR_FTP", {})
            remote_dir = ftp_config["REMOTE_DIR"]
            archive_dir = ftp_config["ARCHIVE_DIR"]

            nifi_url = self._build_url(
                config["host"],
                config["port"],
                config["path"],
            )

            row_delay = (
                1.0 / float(config["rate"])
            )

            vendor = config["vendor"]

            self._log(f"Reading alarm files from FTP: {remote_dir}")

            while not self._stop_event.is_set():
                with self._connect_ftp() as ftp:
                    matched = self._list_ftp_alarm_files(ftp, remote_dir)
                    with self._lock:
                        self.stats["files_matched"] = len(matched)

                    for file_name in matched:
                        if self._stop_event.is_set():
                            break

                        try:
                            raw_text = self._download_ftp_text(
                                ftp,
                                "/" + self._ftp_join(remote_dir, file_name),
                            )

                            before_success = self.stats.get("successful", 0)
                            self._send_file_rows(
                                Path(file_name).name,
                                raw_text,
                                nifi_url,
                                row_delay,
                                vendor,
                            )

                            file_complete = (
                                not self._stop_event.is_set()
                                and self.stats.get("successful", 0) > before_success
                                and self.stats.get("failed", 0) == 0
                            )
                            if file_complete and config.get("run_mode") != "bounded":
                                self._archive_ftp_file(
                                    ftp,
                                    remote_dir,
                                    archive_dir,
                                    Path(file_name).name,
                                )

                        except Exception as exc:  # noqa: BLE001
                            self._log(
                                f"Failed for {Path(file_name).name}: {exc}"
                            )

                        self._stop_event.wait(
                            FILE_DELAY_SECONDS
                        )

                if config.get("run_mode") == "bounded" and self.stats.get("alarms_sent", 0) >= int(config.get("event_limit") or 0):
                    self.completion_reason = "bounded FTP event limit reached"
                    break
                self._stop_event.wait(IDLE_POLL_SECONDS)

        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self.status = "error"
                self.error_message = str(exc)
                self.stopped_at = django_timezone.now()

            self._log(
                f"Simulator error: {exc}"
            )
            self._persist_run()

            return

        with self._lock:
            if self.status != "error":
                self.status = "completed" if config.get("run_mode") == "bounded" else "stopped"
            self.stopped_at = django_timezone.now()
            self.completion_reason = self.completion_reason or ("bounded FTP run complete" if config.get("run_mode") == "bounded" else "operator stopped")
            self._persist_run()


# Shared singleton - imported by views.py so every request/thread in this
# process talks to the same running job.
engine = SimulatorEngine()
