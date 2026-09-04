from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True

    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.CreateModel(
            name="SimulationRun",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("run_id", models.CharField(max_length=64, unique=True)),
                ("vendor", models.CharField(max_length=32)),
                ("rate_eps", models.FloatField()),
                ("run_mode", models.CharField(default="continuous", max_length=16)),
                ("event_limit", models.PositiveIntegerField(blank=True, null=True)),
                ("target", models.CharField(max_length=255)),
                ("status", models.CharField(default="starting", max_length=16)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("stopped_at", models.DateTimeField(blank=True, null=True)),
                ("files_processed", models.PositiveIntegerField(default=0)),
                ("alarms_sent", models.PositiveIntegerField(default=0)),
                ("successful", models.PositiveIntegerField(default=0)),
                ("failed", models.PositiveIntegerField(default=0)),
                ("last_error", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "operator",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="simulator_runs",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
    ]
