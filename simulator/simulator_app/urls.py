from django.urls import path

from . import views

urlpatterns = [
    path("", views.index, name="index"),
    path("login/", views.SimulatorLoginView.as_view(), name="login"),
    path("api/start/", views.start_simulator, name="start_simulator"),
    path("api/stop/", views.stop_simulator, name="stop_simulator"),
    path("api/status/", views.simulator_status, name="simulator_status"),
    path("api/internal/status/", views.simulator_internal_status, name="simulator_internal_status"),
    path("api/internal/actions/", views.simulator_action, name="simulator_action"),
    path("api/internal/scenario-runs/", views.simulator_scenario_run, name="simulator_scenario_run"),
    path("api/config/", views.simulator_config, name="simulator_config"),
    path("api/history/", views.simulator_history, name="simulator_history"),
    path("api/runs/", views.simulator_runs, name="simulator_runs"),
    path("api/pipeline/", views.simulator_pipeline, name="simulator_pipeline"),
    path("metrics", views.simulator_metrics, name="simulator_metrics"),
    path("metrics/", views.simulator_metrics, name="simulator_metrics_slash"),
]
