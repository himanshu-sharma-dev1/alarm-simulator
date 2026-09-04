from django.contrib import admin

from .models import SimulationRun


@admin.register(SimulationRun)
class SimulationRunAdmin(admin.ModelAdmin):
    list_display = ("run_id", "vendor", "status", "rate_eps", "alarms_sent", "successful", "failed", "created_at")
    list_filter = ("status", "vendor", "run_mode")
    search_fields = ("run_id", "target")

# Register your models here.
