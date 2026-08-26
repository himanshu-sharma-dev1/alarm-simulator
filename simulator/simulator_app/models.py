from django.conf import settings
from django.db import models


class SimulationRun(models.Model):
    """Durable operator-visible record for one simulator execution."""

    run_id = models.CharField(max_length=64, unique=True)
    vendor = models.CharField(max_length=32)
    rate_eps = models.FloatField()
    run_mode = models.CharField(max_length=16, default="continuous")
    event_limit = models.PositiveIntegerField(null=True, blank=True)
    target = models.CharField(max_length=255)
    status = models.CharField(max_length=16, default="starting")
    cycle_id = models.CharField(max_length=96, blank=True, default="")
    profile = models.CharField(max_length=40, default="ftp")
    started_at = models.DateTimeField(null=True, blank=True)
    stopped_at = models.DateTimeField(null=True, blank=True)
    files_processed = models.PositiveIntegerField(default=0)
    alarms_sent = models.PositiveIntegerField(default=0)
    successful = models.PositiveIntegerField(default=0)
    failed = models.PositiveIntegerField(default=0)
    last_error = models.TextField(blank=True, default="")
    operator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="simulator_runs",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.run_id} ({self.vendor}, {self.status})"


class SimulatorActionReceipt(models.Model):
    """Immutable idempotency ledger for simulator-only actions."""

    receipt_id = models.CharField(max_length=128, unique=True)
    # AgenticNOC creates its own immutable receipt before crossing the
    # simulator boundary.  Persist that identifier on the simulator ledger so
    # the two audit records can be joined without trusting a UI-supplied id.
    agentic_receipt_id = models.CharField(max_length=128, blank=True, default="")
    approval_id = models.CharField(max_length=128)
    incident_id = models.CharField(max_length=128)
    scenario = models.CharField(max_length=64)
    action_type = models.CharField(max_length=96)
    target_resources = models.JSONField(default=list)
    idempotency_key = models.CharField(max_length=160, unique=True)
    expected_verification_window = models.JSONField(default=dict, blank=True)
    execution_state = models.CharField(max_length=16, default="accepted")
    generated_evidence_identifiers = models.JSONField(default=list, blank=True)
    rejection_reason = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if self.pk and not getattr(self, "_allow_receipt_update", False):
            raise RuntimeError("SimulatorActionReceipt is immutable")
        return super().save(*args, **kwargs)
