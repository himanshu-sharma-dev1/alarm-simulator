from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("simulator_app", "0002_run_identity")]

    operations = [
        migrations.CreateModel(
            name="SimulatorActionReceipt",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("receipt_id", models.CharField(max_length=128, unique=True)),
                ("approval_id", models.CharField(max_length=128)),
                ("incident_id", models.CharField(max_length=128)),
                ("scenario", models.CharField(max_length=64)),
                ("action_type", models.CharField(max_length=96)),
                ("target_resources", models.JSONField(default=list)),
                ("idempotency_key", models.CharField(max_length=160, unique=True)),
                ("expected_verification_window", models.JSONField(blank=True, default=dict)),
                ("execution_state", models.CharField(default="accepted", max_length=16)),
                ("generated_evidence_identifiers", models.JSONField(blank=True, default=list)),
                ("rejection_reason", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["-created_at"]},
        ),
    ]
