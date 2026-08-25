let statusPollTimer = null;
let pipelinePollTimer = null;
let historyPollTimer = null;
let lastLogCount = 0;
let controlsAllowed = false;

function getCsrfToken() {
    const input = document.querySelector("[name=csrfmiddlewaretoken]");
    return input ? input.value : "";
}

function getCurrentTime() {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function addLog(message, time) {
    const log = document.getElementById("eventLog");

    const entry = document.createElement("div");
    entry.className = "log-entry";

    const timeSpan = document.createElement("span");
    timeSpan.className = "log-time";
    timeSpan.textContent = time || getCurrentTime();

    const messageSpan = document.createElement("span");
    messageSpan.className = "log-message";
    messageSpan.textContent = message;

    entry.appendChild(timeSpan);
    entry.appendChild(messageSpan);

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

function setConfigError(message) {
    document.getElementById("configError").textContent = message || "";
}


/* ---------------------------------------------------------- */
/* Screen switching — one page, no reload                     */
/* ---------------------------------------------------------- */

function showScreen(name) {
    document.getElementById("configScreen").classList.toggle("active", name === "config");
    document.getElementById("runningScreen").classList.toggle("active", name === "running");
}

function backToConfig() {
    showScreen("config");
    setConfigError("");
}


/* ---------------------------------------------------------- */
/* Status dots / text (header + Status card)                  */
/* ---------------------------------------------------------- */

function setStatusDots(state) {
    // state: "running" | "stopped" | "error"
    const statusDot = document.getElementById("statusDot");
    const headerDot = document.querySelector(".header-status .status-dot");

    [statusDot, headerDot].forEach((dot) => {
        dot.classList.remove("stopped", "running", "error");
        dot.classList.add(state);
    });
}

function setRunningUI() {
    document.getElementById("statusText").textContent = "RUNNING";
    document.getElementById("headerStatus").textContent = "RUNNING";
    setStatusDots("running");
}

function setStoppedUI() {
    document.getElementById("statusText").textContent = "STOPPED";
    document.getElementById("headerStatus").textContent = "STOPPED";
    setStatusDots("stopped");
}

function setTerminalUI(state, reason) {
    const label = state === "completed" ? "COMPLETED" : state === "stopping" ? "STOPPING" : state.toUpperCase();
    document.getElementById("statusText").textContent = label;
    document.getElementById("headerStatus").textContent = label;
    setStatusDots(state === "error" ? "error" : state === "stopping" ? "running" : "stopped");
    if (reason) document.getElementById("flowPipeLabel").textContent = reason;
}

function setErrorUI(message) {
    document.getElementById("statusText").textContent = "ERROR";
    document.getElementById("headerStatus").textContent = "ERROR";
    setStatusDots("error");
    if (message) addLog(`Simulator error: ${message}`);
}


/* ---------------------------------------------------------- */
/* Flow diagram (Simulator -> NiFi)                            */
/* ---------------------------------------------------------- */

function setFlowState(state) {
    // state: "idle" | "active" | "error"
    const el = document.getElementById("flowDiagram");
    el.classList.remove("active", "error");
    if (state === "active") el.classList.add("active");
    if (state === "error") el.classList.add("error");
}

function showRunControls(isRunning) {
    document.getElementById("stopButton").style.display = isRunning ? "inline-flex" : "none";
    document.getElementById("backButton").style.display = isRunning ? "none" : "inline-flex";
}


/* ---------------------------------------------------------- */
/* Status polling                                              */
/* ---------------------------------------------------------- */

function applyStatus(data) {
    if (data.status === "running" || data.status === "starting" || data.status === "stopping") {
        setRunningUI();
        if (data.status === "starting") setTerminalUI("starting", "Starting…");
        if (data.status === "stopping") setTerminalUI("stopping", "Stopping…");
        setFlowState("active");
        showRunControls(data.status !== "starting" && data.status !== "stopping");

        const alarmText = data.current_alarm ? `Alarm ${data.current_alarm}` : "Waiting for alarms\u2026";
        const respText = data.last_response ? ` \u00b7 ${data.last_response}` : "";
        document.getElementById("flowPipeLabel").textContent = alarmText + respText;
    } else if (data.status === "error") {
        setErrorUI(data.error_message);
        setFlowState("error");
        showRunControls(false);
        document.getElementById("flowPipeLabel").textContent = data.error_message
            ? `Error: ${data.error_message}`
            : "Connection error";
    } else {
        setTerminalUI(data.status || "stopped", data.completion_reason || (data.status === "completed" ? "Completed" : "Stopped"));
        setFlowState("idle");
        showRunControls(false);
        document.getElementById("flowPipeLabel").textContent = data.completion_reason || (data.status === "completed" ? "Completed" : "Stopped");
    }

    document.getElementById("flowSourceLabel").textContent = data.vendor ? data.vendor.toUpperCase() : "\u2014";

    const stats = data.stats || {};
    document.getElementById("alarmsSent").textContent = stats.alarms_sent || 0;
    document.getElementById("successful").textContent = stats.successful || 0;
    document.getElementById("failed").textContent = stats.failed || 0;
    document.getElementById("sendRate").textContent = data.rates && data.rates.send_eps != null ? `${Number(data.rates.send_eps).toFixed(2)}/s` : "—";
    document.getElementById("p95Latency").textContent = data.latency && data.latency.p95_ms != null ? `${Number(data.latency.p95_ms).toFixed(1)} ms` : "—";
    document.getElementById("runId").textContent = data.run_id || "—";
    document.getElementById("flowEndpoint").textContent = data.target || "server-managed";
    document.getElementById("flowSourceLabel").textContent = data.vendor ? data.vendor.toUpperCase() : "—";

    // Only append log lines new since the last poll; if the log shrank, a
    // fresh run started server-side, so resync from scratch.
    if (data.logs.length < lastLogCount) {
        document.getElementById("eventLog").innerHTML = "";
        data.logs.forEach((entry) => addLog(entry.message, entry.time));
    } else if (data.logs.length > lastLogCount) {
        data.logs.slice(lastLogCount).forEach((entry) => addLog(entry.message, entry.time));
    }
    lastLogCount = data.logs.length;
}

async function pollStatus() {
    try {
        const response = await fetch("/api/status/");
        const data = await response.json();
        applyStatus(data);
        return data;
    } catch (err) {
        console.error("Status poll failed:", err);
        return null;
    }
}

function startPolling() {
    if (statusPollTimer) return;
    statusPollTimer = setInterval(pollStatus, 1000);
    if (!pipelinePollTimer) pipelinePollTimer = setInterval(pollPipeline, 5000);
    if (!historyPollTimer) historyPollTimer = setInterval(pollHistory, 20000);
}

function stopPolling() {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
    if (pipelinePollTimer) clearInterval(pipelinePollTimer);
    pipelinePollTimer = null;
    if (historyPollTimer) clearInterval(historyPollTimer);
    historyPollTimer = null;
}

async function loadConfig() {
    try {
        const response = await fetch("/api/config/");
        const data = await response.json();
        controlsAllowed = Boolean(data.can_control);
        document.getElementById("startButton").disabled = !controlsAllowed;
        document.getElementById("managedTarget").textContent = data.target || "Unavailable";
        const max = data.rate && data.rate.maximum_eps ? Number(data.rate.maximum_eps) : 100;
        document.getElementById("rate").max = max;
        document.getElementById("rateHelp").textContent = `Server limit: ${max} alarms/sec · target is not editable`;
        const profile = document.getElementById("profile");
        const vendor = document.getElementById("vendor");
        const runMode = document.getElementById("runMode");
        const eventLimit = document.getElementById("eventLimit");
        const syncProfile = () => {
            const acceptance = profile.value === "end_to_end_acceptance";
            vendor.value = acceptance ? "aviat" : vendor.value;
            vendor.disabled = acceptance;
            runMode.value = acceptance ? "bounded" : runMode.value;
            runMode.disabled = acceptance;
            eventLimit.value = acceptance ? "2" : eventLimit.value;
            eventLimit.disabled = acceptance;
            document.getElementById("eventLimitGroup").style.display = acceptance || runMode.value === "bounded" ? "flex" : "none";
        };
        profile.addEventListener("change", syncProfile);
        syncProfile();
    } catch (err) {
        document.getElementById("managedTarget").textContent = "Target configuration unavailable";
    }
}

function renderPipeline(data) {
    const grid = document.getElementById("downstreamGrid");
    const badge = document.getElementById("downstreamStatus");
    if (!grid || !data) return;
    const rows = [
        ["NiFi", data.nifi, data.nifi && (data.nifi.state || data.nifi.flow_name || "—")],
        ["RabbitMQ", data.rabbitmq, data.rabbitmq && `${data.rabbitmq.backlog != null ? data.rabbitmq.backlog : "—"} ready · ${data.rabbitmq.consumers != null ? data.rabbitmq.consumers : "—"} consumer(s)`],
        ["AgenticNOC", data.agenticnoc, data.agenticnoc && (data.agenticnoc.heartbeat ? `${data.agenticnoc.heartbeat.age_seconds != null ? data.agenticnoc.heartbeat.age_seconds : "—"}s heartbeat` : "—")],
        ["ClickHouse", data.clickhouse, data.clickhouse && `${data.clickhouse.raw_rows != null ? data.clickhouse.raw_rows : "—"} raw · ${data.clickhouse.canonical_rows != null ? data.clickhouse.canonical_rows : "—"} canonical`],
        ["Incidents", data.database, data.database && `${data.database.counts && data.database.counts.incidents != null ? data.database.counts.incidents : "—"} durable`],
    ];
    grid.innerHTML = rows.map(([name, value, detail]) => `<div class="downstream-item"><div style="display:flex;justify-content:space-between;gap:6px"><strong>${name}</strong><span class="status-dot ${value && value.status === "ok" ? "running" : value && value.status === "degraded" ? "error" : "stopped"}"></span></div><div style="margin-top:7px;color:var(--muted-foreground)">${detail || "unavailable"}</div></div>`).join("");
    badge.textContent = data.status ? data.status.toUpperCase() : "UNAVAILABLE";
}

async function pollPipeline() {
    try {
        const response = await fetch("/api/pipeline/");
        renderPipeline(await response.json());
    } catch (err) {
        renderPipeline({ status: "unavailable" });
    }
}


/* ---------------------------------------------------------- */
/* Alarm history chart (last 30 min, successful vs failed)     */
/* ---------------------------------------------------------- */

async function pollHistory() {
    try {
        const response = await fetch("/api/history/?minutes=30");
        const data = await response.json();
        renderHistoryChart(data.buckets);
    } catch (err) {
        console.error("History poll failed:", err);
    }
}

function renderHistoryChart(buckets) {
    const svg = document.getElementById("historyChart");
    if (!svg || !buckets || !buckets.length) return;

    const width = 600;
    const height = 240;
    const padTop = 16;
    const padBottom = 28;
    const padSide = 12;
    const plotHeight = height - padTop - padBottom;

    const maxVal = Math.max(4, ...buckets.map((b) => Math.max(b.successful, b.failed)));
    const stepX = buckets.length > 1 ? (width - padSide * 2) / (buckets.length - 1) : 0;

    const xFor = (i) => padSide + i * stepX;
    const yFor = (val) => padTop + plotHeight - (val / maxVal) * plotHeight;

    const linePoints = (key) => buckets
        .map((bucket, i) => `${xFor(i).toFixed(1)},${yFor(bucket[key]).toFixed(1)}`)
        .join(" ");

    const areaPoints = (key) => {
        const base = `${xFor(0).toFixed(1)},${yFor(0).toFixed(1)}`;
        const top = buckets.map((bucket, i) => `${xFor(i).toFixed(1)},${yFor(bucket[key]).toFixed(1)}`).join(" ");
        const end = `${xFor(buckets.length - 1).toFixed(1)},${yFor(0).toFixed(1)}`;
        return `${base} ${top} ${end}`;
    };

    const dots = (key, color) => buckets
        .map((bucket, i) => {
            if (bucket[key] === 0) return "";
            return `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(bucket[key]).toFixed(1)}" r="2.6" fill="${color}" />`;
        })
        .join("");

    // Horizontal reference grid — 0, mid, max
    const gridSteps = [0, 0.5, 1];
    const gridLines = gridSteps
        .map((frac) => {
            const y = padTop + plotHeight * (1 - frac);
            const val = Math.round(maxVal * frac);
            return `
                <line x1="${padSide}" y1="${y.toFixed(1)}" x2="${width - padSide}" y2="${y.toFixed(1)}"
                      stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" opacity="0.6" />
                <text x="${padSide}" y="${(y - 4).toFixed(1)}" font-family="var(--font-mono)" font-size="9"
                      fill="var(--muted-foreground)">${val}</text>
            `;
        })
        .join("");

    svg.innerHTML = `
        ${gridLines}
        <polygon points="${areaPoints("successful")}" fill="var(--primary)" opacity="0.12" />
        <polyline points="${linePoints("failed")}" fill="none" stroke="var(--destructive)"
                  stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />
        <polyline points="${linePoints("successful")}" fill="none" stroke="var(--primary)"
                  stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${dots("failed", "var(--destructive)")}
        ${dots("successful", "var(--primary)")}
    `;

    document.getElementById("chartLabelStart").textContent = buckets[0].time;
    document.getElementById("chartLabelEnd").textContent = buckets[buckets.length - 1].time;
}


/* ---------------------------------------------------------- */
/* Start / Stop                                                */
/* ---------------------------------------------------------- */

async function startSimulator() {
    setConfigError("");
    if (!controlsAllowed) return setConfigError("Sign in as a simulator operator before starting a run.");

    const vendor = document.getElementById("vendor").value;
    const profile = document.getElementById("profile").value;
    const rate = document.getElementById("rate").value;
    const runMode = document.getElementById("runMode").value;
    const eventLimit = document.getElementById("eventLimit").value;

    if (!rate || Number(rate) <= 0) return setConfigError("Rate must be greater than 0.");
    if (runMode === "bounded" && (!eventLimit || Number(eventLimit) < 1)) return setConfigError("Bounded runs need a positive event limit.");

    document.getElementById("startButton").disabled = true;

    try {
        const response = await fetch("/api/start/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": getCsrfToken()
            },
            body: JSON.stringify({ profile, vendor, rate_eps: rate, run_mode: runMode, event_limit: runMode === "bounded" ? eventLimit : null })
        });

        const raw = await response.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            data = { ok: false, message: response.status === 401 || response.status === 403 ? "Sign in as a simulator operator to control the stream." : `Server returned HTTP ${response.status}.` };
        }

        if (!data.ok) {
            setConfigError(data.message);
            document.getElementById("startButton").disabled = !controlsAllowed;
            return;
        }

        lastLogCount = 0;
        document.getElementById("eventLog").innerHTML = "";

        document.getElementById("flowSourceLabel").textContent = vendor.toUpperCase();
        document.getElementById("flowPipeLabel").textContent = "Starting\u2026";

        showScreen("running");
        setRunningUI();
        setFlowState("active");
        showRunControls(true);

        startPolling();
        pollStatus();
        pollHistory();
        pollPipeline();
    } catch (err) {
        setConfigError(`Failed to start simulator: ${err}`);
    } finally {
        document.getElementById("startButton").disabled = !controlsAllowed;
    }
}

async function stopSimulator() {
    if (!controlsAllowed) return addLog("Sign in as a simulator operator to stop the stream.");
    document.getElementById("stopButton").disabled = true;

    try {
        const response = await fetch("/api/stop/", {
            method: "POST",
            headers: { "X-CSRFToken": getCsrfToken() }
        });
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch (_) { data = { message: `Stop request returned HTTP ${response.status}.` }; }
        addLog(data.message);
    } catch (err) {
        addLog(`Failed to stop simulator: ${err}`);
    }

    document.getElementById("stopButton").disabled = false;
    pollStatus();
}

function clearLog() {
    document.getElementById("eventLog").innerHTML = "";
    lastLogCount = 0;
    addLog("Event log cleared.");
}


/* ---------------------------------------------------------- */
/* Initial load — sync with whatever the backend is already   */
/* doing, in case a run is already in progress.                */
/* ---------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
    loadConfig();
    const runMode = document.getElementById("runMode");
    if (runMode) runMode.addEventListener("change", () => {
        document.getElementById("eventLimitGroup").style.display = runMode.value === "bounded" ? "flex" : "none";
    });
    pollStatus().then((data) => {
        if (data && ["running", "starting", "stopping", "error"].includes(data.status)) {
            showScreen("running");
            if (["running", "starting", "stopping"].includes(data.status)) startPolling();
        } else {
            showScreen("config");
        }
    });
    pollHistory();
    pollPipeline();
});
