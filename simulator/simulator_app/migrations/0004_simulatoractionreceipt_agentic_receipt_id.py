from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("simulator_app", "0003_simulatoractionreceipt")]

    operations = [
        migrations.AddField(
            model_name="simulatoractionreceipt",
            name="agentic_receipt_id",
            field=models.CharField(blank=True, default="", max_length=128),
        ),
    ]
