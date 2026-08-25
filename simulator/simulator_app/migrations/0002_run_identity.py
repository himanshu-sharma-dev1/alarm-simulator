from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("simulator_app", "0001_simulationrun")]

    operations = [
        migrations.AddField(
            model_name="simulationrun",
            name="cycle_id",
            field=models.CharField(blank=True, default="", max_length=96),
        ),
        migrations.AddField(
            model_name="simulationrun",
            name="profile",
            field=models.CharField(default="ftp", max_length=40),
        ),
    ]
