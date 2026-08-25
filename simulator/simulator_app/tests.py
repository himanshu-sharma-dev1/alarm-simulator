import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from .models import SimulationRun, SimulatorActionReceipt


class SimulatorApiTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="operator", password="secret", is_staff=True
        )

    def test_config_hides_editable_target_controls(self):
        response = self.client.get("/api/config/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["target"], "http://180.75.0.10:9080/aviat")

    def test_start_requires_staff_session(self):
        response = self.client.post(
            "/api/start/", data=json.dumps({"vendor": "aviat", "rate_eps": 1}), content_type="application/json"
        )
        self.assertEqual(response.status_code, 401)

    @override_settings(SIMULATOR_MAX_RATE_EPS=10)
    @patch("simulator_app.views.engine.start", return_value=(True, "Simulator started."))
    def test_start_accepts_only_server_managed_fields(self, start):
        self.client.force_login(self.user)
        response = self.client.post(
            "/api/start/",
            data=json.dumps({"vendor": "aviat", "rate_eps": 2, "host": "attacker", "port": 1, "path": "bad"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(start.call_args.args[0]["vendor"], "aviat")
        self.assertNotIn("host", start.call_args.args[0])
        self.assertEqual(SimulationRun.objects.count(), 1)

    def test_internal_status_accepts_unconfigured_token(self):
        response = self.client.get("/api/internal/status/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("stats", response.json())

    @override_settings(SIMULATOR_INTERNAL_TOKEN="action-secret")
    @patch("simulator_app.views.engine.send_action_followups", return_value=[])
    def test_action_requires_token_and_is_idempotent(self, followups):
        payload = {
            "approval_id": 7,
            "incident_id": 11,
            "scenario": "rain_fade",
            "action_type": "ACM_MODULATION_HOLD",
            "target_resources": [{"resource_type": "node", "resource_id": "AVT-1"}],
            "idempotency_key": "idem-1",
            "expected_verification_window": {"seconds": 300},
        }
        denied = self.client.post("/api/internal/actions/", data=json.dumps(payload), content_type="application/json")
        self.assertEqual(denied.status_code, 403)
        accepted = self.client.post(
            "/api/internal/actions/",
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer action-secret",
        )
        self.assertEqual(accepted.status_code, 202)
        self.assertEqual(SimulatorActionReceipt.objects.count(), 1)
        replay = self.client.post(
            "/api/internal/actions/",
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer action-secret",
        )
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.json()["idempotent_replay"])
        followups.assert_called_once()
