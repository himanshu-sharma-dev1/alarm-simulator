let statusPollTimer = null;
let pipelinePollTimer = null;
let historyPollTimer = null;
let lastLogCount = 0;
let controlsAllowed = false;
let scenarioCatalog = [];
let scenarioPreflight = null;
let scenarioPreflightRequest = 0;

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

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
/* Top-Level Navigation Tabs for Video Demo & Operational Modes*/
/* ---------------------------------------------------------- */

let currentSimTab = "scenarios";

function switchSimTab(tabName) {
    currentSimTab = tabName;
    const tabMap = {
        scenarios: { btn: "tabBtnScenarios", pane: "paneScenarios" },
        continuous: { btn: "tabBtnContinuous", pane: "paneContinuous" },
        pipeline: { btn: "tabBtnPipeline", pane: "panePipeline" },
    };

    Object.entries(tabMap).forEach(([name, ids]) => {
        const btn = document.getElementById(ids.btn);
        const pane = document.getElementById(ids.pane);
        const isActive = name === tabName;
        if (btn) btn.classList.toggle("active", isActive);
        if (pane) {
            pane.classList.toggle("active", isActive);
            pane.style.display = isActive ? "block" : "none";
        }
    });

    try {
        localStorage.setItem("sim_active_tab", tabName);
    } catch (_) {}
}

const SCENARIO_DETAILS = {
    rain_fade: {
        title: "Rain Fade (Atmospheric RF Attenuation)",
        icon: "🌧️",
        severity: "MAJOR",
        severityColor: "var(--warning)",
        category: "ENVIRONMENTAL",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "18 GHz Point-to-Point Microwave",
        mechanism: "Controlled precipitation input is compared with event-time directional RF telemetry and approved link geometry.",
        telemetry: "Symmetric RSL/SNR degradation on both link ends; exact values come from the sealed case manifest.",
        alarms: "RF_DEGRADED (directional near/far symptoms)",
        expected_rca: "Rain Fade is selected only when weather, physics and competing-hypothesis evidence support it."
    },
    antenna_drift: {
        title: "Antenna Drift (Mechanical Misalignment)",
        icon: "📡",
        severity: "MAJOR",
        severityColor: "var(--warning)",
        category: "PHYSICAL_PLANT",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "23 GHz Point-to-Point Microwave",
        mechanism: "A gradual asymmetric directional RF trend is compared with clear-weather and stable-configuration evidence.",
        telemetry: "Root-side RSL/SNR declines across multiple buckets while the peer comparison remains stable; exact values come from the sealed manifest.",
        alarms: "RF_DEGRADED (symptom only)",
        expected_rca: "Antenna Drift is selected only when persistent trend and physical evidence outweigh Rain Fade and hardware alternatives."
    },
    hardware_failure: {
        title: "Hardware / Transceiver Failure",
        icon: "🔌",
        severity: "CRITICAL",
        severityColor: "var(--destructive)",
        category: "HARDWARE",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "18 GHz ODU Transceiver",
        mechanism: "ODU power amplifier (PA) bias current loss or local oscillator (LO) PLL unlock, abruptly ceasing RF transmission.",
        telemetry: "Near-end reports severe Tx PA current fault / LO unlock; far-end records sudden total RSL loss down to noise floor (-90 dBm).",
        alarms: "EQUIPMENT_FAIL, ODU_TX_FAIL, RADIO_LINK_DOWN",
        expected_rca: "ODU transceiver hardware failure at AVT_SITE_01; dispatch field technician with replacement transceiver unit."
    },
    site_power_failure: {
        title: "Site Power Failure (DC Plant Outage)",
        icon: "⚡",
        severity: "CRITICAL",
        severityColor: "var(--destructive)",
        category: "INFRASTRUCTURE",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "Site DC Power Plant",
        mechanism: "Commercial utility grid AC loss; emergency diesel generator failed to start, causing DC battery bank discharge below 42V.",
        telemetry: "Supply voltage dropping steadily from nominal -54.0V DC down to -41.2V DC over a 45-minute discharge curve.",
        alarms: "MAINS_FAILURE, BATTERY_DISCHARGING, DC_LOW_VOLTAGE_ALARM",
        expected_rca: "Site utility power loss and battery exhaustion; dispatch emergency mobile generator to AVT_SITE_01."
    },
    protection_switch: {
        title: "1+1 HSB Protection Switch Failover",
        icon: "🛡️",
        severity: "WARNING",
        severityColor: "var(--warning)",
        category: "CONFIGURATION",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "18 GHz 1+1 Hot-Standby Protected Pair",
        mechanism: "Working channel degradation triggering autonomous hitless protection switchover to standby protection channel.",
        telemetry: "Protection state transitions from 'Working Normal' to 'Protect Active'; brief 12ms switching glitch with zero user traffic loss.",
        alarms: "PROTECTION_SWITCH_OCCURRED, CHANNEL_DEGRADED",
        expected_rca: "Autonomous 1+1 protection switchover succeeded; inspect degradation on working channel radio."
    },
    capacity_congestion: {
        title: "Capacity Congestion & ACM Fallback",
        icon: "📊",
        severity: "MAJOR",
        severityColor: "var(--warning)",
        category: "PERFORMANCE",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "Microwave Packet Ring Link",
        mechanism: "Sustained traffic egress peak exceeding committed information rate (CIR), triggering queue buffer overflow and tail drops.",
        telemetry: "Interface queue buffer utilization exceeding 98%; packet loss of 4.2%; latency jitter spiking from 1.2ms to 48ms.",
        alarms: "INTERFACE_CONGESTION, PACKET_DISCARD_RATE_HIGH",
        expected_rca: "Capacity exhaustion; recommend traffic reroute via secondary ring or bandwidth carrier upgrade."
    },
    flapping_link: {
        title: "Intermittent Flapping Link",
        icon: "🔄",
        severity: "MAJOR",
        severityColor: "var(--warning)",
        category: "TRANSMISSION",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "18 GHz Microwave Link",
        mechanism: "Damaged IF coaxial cable or loose waveguide flange connector causing intermittent RF signal loss under wind vibration.",
        telemetry: "14 link state transitions (Up/Down) within 15 minutes; rapid RSL oscillation between -44 dBm and -85 dBm.",
        alarms: "RADIO_LINK_FLAPPING, SYNC_LOSS, EXCESSIVE_BIT_ERRORS",
        expected_rca: "Physical cable or connector degradation; inspect IF jumper cable and waveguide flange at tower base."
    },
    node_isolation: {
        title: "Hub / Node Reachability Isolation",
        icon: "🌐",
        severity: "CRITICAL",
        severityColor: "var(--destructive)",
        category: "TOPOLOGY",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ 3 Downstream Terminals",
        band: "Microwave Star / Hub Cluster",
        mechanism: "Aggregator switch port shutdown or upstream ring fiber cut isolating entire microwave cluster from IP core.",
        telemetry: "Simultaneous loss of SNMP and telemetry heartbeats from 4 nodes across 2 adjacent sites.",
        alarms: "NODE_UNREACHABLE, BGP_NEIGHBOR_DOWN, MPLS_LSP_DOWN",
        expected_rca: "Upstream aggregation isolation; verify backhaul fiber link to regional point of presence."
    },
    config_drift: {
        title: "Parameter & Frequency Config Drift",
        icon: "⚙️",
        severity: "MAJOR",
        severityColor: "var(--warning)",
        category: "CONFIGURATION",
        link: "AVT_UEMWSWB01 (Hop 0) ➔ AVT_UEMWBSNA01 (Hop 1)",
        band: "18 GHz Carrier Frequency",
        mechanism: "Unauthorized operator parameter modification causing TX/RX carrier frequency shift (+50 MHz) and channel mismatch.",
        telemetry: "Demodulator lock failure with nominal TX power (+22 dBm) but zero valid frame reception.",
        alarms: "CONFIG_MISMATCH, CARRIER_ACQUISITION_FAIL",
        expected_rca: "Configuration drift detected against golden template; trigger automated rollback to Aviat baseline profile."
    },
    environmental_alarm: {
        title: "Shelter / Cabinet Thermal Overheat",
        icon: "🌡️",
        severity: "MAJOR",
        severityColor: "var(--warning)",
        category: "ENVIRONMENTAL",
        link: "AVT_UEMWSWB01 (Hop 0) · Site AVT_SITE_01",
        band: "Indoor Unit (IDU) Telemetry",
        mechanism: "Telecom equipment shelter HVAC compressor failure, causing ambient indoor temperature to climb to +58°C.",
        telemetry: "Chassis thermal sensor reports +62.4°C (threshold: +55°C); fan speed forced to 100% maximum RPM.",
        alarms: "CABINET_HIGH_TEMP, HVAC_UNIT_FAILURE",
        expected_rca: "Shelter cooling system failure; dispatch HVAC emergency repair team to AVT_SITE_01."
    }
};

function updateScenarioDeepDive(scenarioKey) {
    const info = SCENARIO_DETAILS[scenarioKey] || SCENARIO_DETAILS.rain_fade;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setVal("scenIcon", info.icon);
    setVal("scenTitle", info.title);
    setVal("scenCategory", info.category);
    setVal("scenSeverity", info.severity);
    const sevEl = document.getElementById("scenSeverity");
    if (sevEl) {
        sevEl.style.color = info.severityColor || "var(--warning)";
        sevEl.style.background = `color-mix(in oklab, ${info.severityColor || "var(--warning)"} 18%, transparent)`;
    }
    setVal("scenLink", info.link);
    setVal("scenBand", info.band);
    setVal("scenMechanism", info.mechanism);
    setVal("scenTelemetry", info.telemetry);
    setVal("scenAlarms", info.alarms);
    setVal("scenExpectedRCA", info.expected_rca);
}

function onScenarioSelectChange() {
    const sel = document.getElementById("scenarioSelect");
    if (sel) {
        updateScenarioDeepDive(sel.value);
        loadScenarioPreflight();
    }
}

function onCaseVariantChange() {
    loadScenarioPreflight();
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

    const contBadge = document.getElementById("tabContinuousBadge");
    if (contBadge) {
        if (data.status === "running") {
            contBadge.innerHTML = `<span class="status-dot running" style="width:7px;height:7px;display:inline-block;margin-right:4px"></span> RUNNING`;
        } else {
            contBadge.textContent = "NiFi / RabbitMQ";
        }
    }

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
    // Scenario selection is an independent authenticated service boundary;
    // a status/config probe must not prevent the catalog from loading.
    await loadScenarioCatalog();
}

const SHOWCASE_SCENARIOS = [
    { key: "site_power_failure", label: "⚡ 1. Cascading Alarms: Site Power Outage (Correlation ➔ Field Dispatch)" },
    { key: "config_drift", label: "⚙️ 2. Configuration Mismatch (Sandbox Simulation vs Human Escalation)" },
    { key: "rain_fade", label: "🌧️ 3A. Rain Fade (Debate & Physics Engine ➔ Monitor Until Clear)" },
    { key: "antenna_drift", label: "📡 3B. Antenna Drift (Debate & Physics Engine ➔ Field Dispatch)" },
];

const ADDITIONAL_SCENARIOS = [
    { key: "hardware_failure", label: "🔌 Hardware / Transceiver Failure" },
    { key: "protection_switch", label: "🛡️ 1+1 HSB Protection Switch Failover" },
    { key: "capacity_congestion", label: "📊 Capacity Congestion & ACM Fallback" },
    { key: "flapping_link", label: "🔄 Intermittent Flapping Link" },
    { key: "node_isolation", label: "🌐 Hub / Node Reachability Isolation" },
    { key: "environmental_alarm", label: "🌡️ Shelter / Cabinet Thermal Overheat" },
];

const CASE_DESCRIPTIONS = {
    config_drift: {
        "1": "Case 1: Low-Risk Configuration Drift (ATPC Power Offset ➔ Sandbox Simulation)",
        "2": "Case 2: High-Risk Critical Frequency Mismatch (80 GHz Backbone ➔ CAB Human Escalation)",
    },
    rain_fade: {
        "1": "Case 1: Directional RF Fade (Weather + ITU-R Model ➔ ACM Hold, Await Clear Evidence)",
        "2": "Case 2: Contradictory Rain Telemetry (Atmospheric Attenuation Evaluation)",
    },
    antenna_drift: {
        "1": "Case 1: Persistent Asymmetric RF Trend (Clear Weather ➔ Evidence Debate ➔ Draft Tower Handoff)",
        "2": "Case 2: Contradictory Drift Telemetry (Mechanical vs Path Loss Analysis)",
    },
    site_power_failure: {
        "1": "Case 1: Rectifier / Battery Discharge (Cascading DC Alarms ➔ Power Tech Dispatch)",
        "2": "Case 2: Transient DC Fluctuation (Power Stability Verification)",
    },
};

async function loadScenarioCatalog() {
    const scenarioSelect = document.getElementById("scenarioSelect");
    const caseSelect = document.getElementById("caseVariantSelect");
    if (!scenarioSelect || !caseSelect) return;
    try {
        const response = await fetch("/api/scenarios/catalog/");
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.scenarios)) throw new Error(data.error || data.detail || "catalog unavailable");
        scenarioCatalog = data.scenarios;
        
        // Remember previous selection or default to site_power_failure
        const prevScenario = scenarioSelect.value || "site_power_failure";
        scenarioSelect.replaceChildren();

        // Group 1: Showcase Scenarios (Presenter Certified)
        const groupShowcase = document.createElement("optgroup");
        groupShowcase.label = "Showcase Scenarios (Presenter Certified)";
        SHOWCASE_SCENARIOS.forEach(scen => {
            const found = scenarioCatalog.find(s => s.scenario === scen.key);
            if (found) {
                const opt = document.createElement("option");
                opt.value = scen.key;
                opt.textContent = scen.label;
                groupShowcase.appendChild(opt);
            }
        });
        scenarioSelect.appendChild(groupShowcase);

        // Group 2: Additional Microwave Transmission Scenarios
        const groupAdditional = document.createElement("optgroup");
        groupAdditional.label = "Additional Microwave Transmission Scenarios (Full 10-Scenario Suite)";
        ADDITIONAL_SCENARIOS.forEach(scen => {
            const found = scenarioCatalog.find(s => s.scenario === scen.key);
            if (found) {
                const opt = document.createElement("option");
                opt.value = scen.key;
                opt.textContent = scen.label;
                groupAdditional.appendChild(opt);
            }
        });
        scenarioSelect.appendChild(groupAdditional);

        // Restore selection or default to site_power_failure
        if (scenarioSelect.querySelector(`option[value="${prevScenario}"]`)) {
            scenarioSelect.value = prevScenario;
        } else {
            scenarioSelect.value = "site_power_failure";
        }

        const refreshCases = () => {
            const currentScen = scenarioSelect.value;
            const selected = scenarioCatalog.find((item) => item.scenario === currentScen);
            const prevCase = caseSelect.value || "1";
            caseSelect.replaceChildren();
            const descMap = CASE_DESCRIPTIONS[currentScen] || {};
            (selected && selected.cases || []).forEach((item) => {
                const option = document.createElement("option");
                option.value = String(item.case_number);
                option.textContent = descMap[String(item.case_number)] || `Case ${item.case_number}: ${item.title || "Validated scenario"}`;
                option.disabled = item.runnable === false;
                caseSelect.appendChild(option);
            });
            if (!caseSelect.options.length) {
                const option = document.createElement("option");
                option.value = "1";
                option.textContent = "No validated cases available";
                option.disabled = true;
                caseSelect.appendChild(option);
            }
            if (caseSelect.querySelector(`option[value="${prevCase}"]`)) {
                caseSelect.value = prevCase;
            }
            updateScenarioDeepDive(scenarioSelect.value);
            loadScenarioPreflight();
        };

        scenarioSelect.addEventListener("change", refreshCases);
        refreshCases();
    } catch (err) {
        const status = document.getElementById("scenarioInjectStatus");
        if (status) status.textContent = "Scenario catalog unavailable; sign in or check AgenticNOC service configuration.";
        const injectButton = document.getElementById("injectScenarioBtn");
        if (injectButton) injectButton.disabled = true;
        const badge = document.getElementById("scenarioPreflightBadge");
        if (badge) {
            badge.textContent = "UNAVAILABLE";
            badge.style.background = "#64748b";
        }
        const summary = document.getElementById("scenarioPreflightSummary");
        if (summary) summary.textContent = "Scenario catalog unavailable; scenario injection is paused.";
    }
}

async function loadScenarioPreflight() {
    const scenarioSelect = document.getElementById("scenarioSelect");
    const caseSelect = document.getElementById("caseVariantSelect");
    const summary = document.getElementById("scenarioPreflightSummary");
    const checksEl = document.getElementById("scenarioPreflightChecks");
    const badge = document.getElementById("scenarioPreflightBadge");
    const card = document.getElementById("scenarioPreflightCard");
    const injectButton = document.getElementById("injectScenarioBtn");
    if (!scenarioSelect || !caseSelect || !summary) return;
    const requestId = ++scenarioPreflightRequest;
    const requestedScenario = scenarioSelect.value;
    const requestedCase = caseSelect.value || "1";
    scenarioPreflight = null;
    summary.textContent = "Checking selected case and live dependencies…";
    if (checksEl) checksEl.textContent = "Preflight in progress…";
    try {
        const query = new URLSearchParams({ scenario: requestedScenario, case_number: requestedCase });
        const response = await fetch(`/api/scenarios/preflight/?${query.toString()}`);
        const data = await response.json();
        if (requestId !== scenarioPreflightRequest || requestedScenario !== scenarioSelect.value || requestedCase !== (caseSelect.value || "1")) return;
        scenarioPreflight = data;
        const ready = response.ok && data.ready === true;
        summary.textContent = ready
            ? "Selected case and required stream dependencies are ready."
            : (data.error || "Selected case is not ready for a live ingress run.");
        summary.style.color = ready ? "#4ade80" : "#fb923c";
        if (badge) {
            badge.textContent = ready ? "READY" : "BLOCKED";
            badge.style.background = ready ? "#16a34a" : "#ea580c";
        }
        if (card) {
            card.style.background = ready ? "rgba(34, 197, 94, 0.08)" : "rgba(234, 88, 12, 0.08)";
            card.style.borderColor = ready ? "rgba(34, 197, 94, 0.25)" : "rgba(234, 88, 12, 0.25)";
        }
        if (checksEl) {
            const checks = Array.isArray(data.checks) ? data.checks : [];
            checksEl.textContent = checks.length
                ? checks.map((item) => `${item.status === "ok" ? "✓" : item.status === "warning" ? "!" : "✕"} ${item.name}: ${item.detail || item.observed_status || item.status}`).join(" · ")
                : "No preflight checks returned.";
        }
        // Keep the server as the authority, but prevent an operator from
        // starting a known-blocked case and receiving a confusing transport
        // error several hops later.
        if (injectButton) injectButton.disabled = !ready;
    } catch (err) {
        if (requestId !== scenarioPreflightRequest || requestedScenario !== scenarioSelect.value || requestedCase !== (caseSelect.value || "1")) return;
        scenarioPreflight = { ready: false, error: "Preflight service unavailable" };
        summary.textContent = "Preflight service unavailable; scenario injection is paused.";
        summary.style.color = "#fb923c";
        if (badge) {
            badge.textContent = "UNAVAILABLE";
            badge.style.background = "#64748b";
        }
        if (card) {
            card.style.background = "rgba(100, 116, 139, 0.08)";
            card.style.borderColor = "rgba(100, 116, 139, 0.25)";
        }
        if (checksEl) checksEl.textContent = String(err && err.message || "preflight request failed");
        if (injectButton) injectButton.disabled = true;
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
    let savedTab = "scenarios";
    try {
        savedTab = localStorage.getItem("sim_active_tab") || "scenarios";
    } catch (_) {}
    switchSimTab(savedTab);

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


/* ---------------------------------------------------------- */
/* Scenario Ingress & Pipeline Hop Tracker                    */
/* ---------------------------------------------------------- */

let scenarioPollTimer = null;

function setPipeNode(id, state, metaText) {
    const node = document.getElementById(id);
    if (!node) return;
    node.classList.remove("active", "done", "error");
    if (state) node.classList.add(state);
    if (metaText) {
        const meta = document.getElementById("meta" + id.replace("node", ""));
        if (meta) meta.textContent = metaText;
    }
}

function setPipePulse(id, isFlowing) {
    const pulse = document.getElementById(id);
    if (pulse) pulse.classList.toggle("flowing", isFlowing);
}

async function injectScenarioStream() {
    const scenario = document.getElementById("scenarioSelect").value;
    const caseNumber = parseInt(document.getElementById("caseVariantSelect").value, 10) || 1;
    const btn = document.getElementById("injectScenarioBtn");
    const statusText = document.getElementById("scenarioInjectStatus");
    const tracker = document.getElementById("pipelineJourneyTracker");
    const detail = document.getElementById("journeyDetail");

    btn.disabled = true;
    statusText.textContent = "Starting validated scenario stream...";
    tracker.style.display = "block";

    // Reset 5-node dynamic track
    setPipeNode("nodeSim", "done", ":9019 · Dispatched ✓");
    setPipeNode("nodeNifi", "active", ":9080 · Ingress stream");
    setPipeNode("nodeRabbit", "", ":15674 · Stream queue");
    setPipeNode("nodeCh", "", ":9017 · PM store");
    setPipeNode("nodeNoc", "", ":9015 · Multi-Agent idle");
    setPipePulse("pulseSimNifi", true);
    setPipePulse("pulseNifiRabbit", false);
    setPipePulse("pulseRabbitCh", false);
    setPipePulse("pulseChNoc", false);

    const hopTimer = document.getElementById("hopTimerBadge");
    if (hopTimer) hopTimer.textContent = "T+ 0.0s";

    const progStaged = document.getElementById("phaseStepStaged");
    if (progStaged) { progStaged.style.borderTopColor = "#22c55e"; progStaged.style.color = "#22c55e"; }
    const progStreaming = document.getElementById("phaseStepStreaming");
    if (progStreaming) { progStreaming.style.borderTopColor = "#38bdf8"; progStreaming.style.color = "#38bdf8"; progStreaming.textContent = "● Stream Ingress Flowing"; }

    detail.innerHTML = `<em>Initializing ${escapeHtml(scenario)} (Case ${escapeHtml(caseNumber)})...</em>`;

    try {
        const response = await fetch("/api/scenarios/inject/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": getCsrfToken(),
            },
            body: JSON.stringify({ scenario: scenario, case_number: caseNumber }),
        });

        const data = await response.json();
        if (!data.ok) {
            statusText.textContent = `❌ ${data.message || "Failed to inject scenario"}`;
            btn.disabled = false;
            setPipeNode("nodeSim", "error", ":9019 · Rejected");
            return;
        }

        statusText.textContent = `✅ Ingress stream active · Run #${data.demo_id || "—"}`;
        setPipeNode("nodeNifi", "active", ":9080 · Receiving packets");
        setPipePulse("pulseNifiRabbit", true);

        detail.innerHTML = `<strong>Ingress Cycle:</strong> <code>${escapeHtml(data.replay_cycle_id)}</code> | <strong>Stream Session:</strong> <code>${escapeHtml(data.simulator_run_id)}</code>`;

        const scenInfo = SCENARIO_DETAILS[scenario] || {};
        const payloadPreview = {
            transport: "HTTP/1.1 POST iktaratech.com:9001/aviat",
            timestamp: new Date().toISOString(),
            vendor: "Aviat Networks",
            scenario: scenario,
            case_variant: caseNumber,
            cycle_id: data.replay_cycle_id,
            target_link: scenInfo.link || "AVT_UEMWSWB01 ➔ AVT_UEMWBSNA01",
            frequency_band: scenInfo.band || "18 GHz",
            injected_telemetry: scenInfo.telemetry || "Symmetric RSL fade & SNR threshold tracking",
            injected_alarms: (scenInfo.alarms && scenInfo.alarms.split(", ")) || ["ALARM_ASSERTED"],
            status: "Delivered to Apache NiFi Ingress (iktaratech.com:9001) -> RabbitMQ Exchange (:15674)"
        };
        const payloadEl = document.getElementById("scenarioPayloadContent");
        if (payloadEl) payloadEl.textContent = JSON.stringify(payloadPreview, null, 2);

        pollScenarioPipeline(data.demo_id, data.agentic_url);
    } catch (err) {
        statusText.textContent = `❌ Error: ${err}`;
        btn.disabled = false;
        setPipeNode("nodeSim", "error", ":9019 · Error");
    }
}

function setStepActive(elemId, isActive, text) {
    const el = document.getElementById(elemId);
    if (!el) return;
    if (isActive) {
        el.style.background = "#dcfce7";
        el.style.color = "#15803d";
        el.style.fontWeight = "600";
    } else {
        el.style.background = "#f1f5f9";
        el.style.color = "#64748b";
        el.style.fontWeight = "400";
    }
    if (text) el.textContent = text;
}

function pollScenarioPipeline(demoId, agenticUrl) {
    if (scenarioPollTimer) clearInterval(scenarioPollTimer);
    const btn = document.getElementById("injectScenarioBtn");
    const detail = document.getElementById("journeyDetail");
    const statusText = document.getElementById("scenarioInjectStatus");
    const hopTimer = document.getElementById("hopTimerBadge");

    let attempts = 0;
    let requestInFlight = false;
    scenarioPollTimer = setInterval(async () => {
        if (requestInFlight) return;
        requestInFlight = true;
        attempts++;
        if (hopTimer) hopTimer.textContent = `T+ ${(attempts * 1.5).toFixed(1)}s`;

        // LangGraph is provider-paced and may legitimately take several
        // minutes.  Do not stop at the first materialized Incident (or at a
        // 28-second UI timeout) and imply that the scenario is complete.
        if (attempts > 240) {
            clearInterval(scenarioPollTimer);
            btn.disabled = false;
            statusText.textContent = "⏳ Ingress accepted · AgenticNOC is still processing in the background";
            setPipeNode("nodeNoc", "active", ":9015 · Background queue");
            requestInFlight = false;
            return;
        }

        try {
            const resp = await fetch(`/api/scenarios/poll/${demoId}/`);
            if (!resp.ok) return;
            const data = await resp.json();

            const phase = data.phase || "";
            const status = data.status || "";
            const inc = data.incident || {};

            const proofs = Array.isArray(data.hop_proofs) ? data.hop_proofs : [];
            const proofStatus = (name) => {
                const entries = proofs.filter((item) => item && item.hop === name);
                return entries.length ? entries[entries.length - 1] : null;
            };
            const simulatorProof = proofStatus("simulator");
            const nifiProof = proofStatus("nifi");
            const rabbitProof = proofStatus("rabbitmq");
            const materializerProof = proofStatus("incident_materializer");
            if (simulatorProof) setPipeNode("nodeSim", "done", ":9019 · Dispatched ✓");
            if (nifiProof && nifiProof.status === "delivered") {
                setPipeNode("nodeNifi", "done", ":9080 · Delivered ✓");
                setPipeNode("nodeRabbit", "active", ":15674 · Ingesting");
                setPipePulse("pulseNifiRabbit", true);
                const pStreaming = document.getElementById("phaseStepStreaming");
                if (pStreaming) { pStreaming.style.borderTopColor = "#22c55e"; pStreaming.style.color = "#22c55e"; pStreaming.textContent = "✓ NiFi → RabbitMQ"; }
            }
            if (rabbitProof && rabbitProof.status === "consumed") {
                setPipeNode("nodeRabbit", "done", ":15674 · Stream queue ✓");
                setPipeNode("nodeCh", "active", ":9017 · PM Telemetry");
                setPipePulse("pulseRabbitCh", true);
            }

            if (inc && inc.id) {
                const incidentNode = typeof inc.primary_node === "object" && inc.primary_node
                    ? (inc.primary_node.node_id || inc.primary_node.id || "not recorded")
                    : (inc.primary_node || inc.node_id || "not recorded");
                const incidentSeverity = inc.root_severity || inc.severity || "not recorded";
                setPipeNode("nodeCh", "done", ":9017 · PM Series Sealed ✓");
                setPipeNode("nodeNoc", "done", ":9015 · Multi-Agent Active ✓");
                setPipePulse("pulseChNoc", true);
                const workflowStatus = String(data.status || data.phase || "investigating").replace(/_/g, " ");
                statusText.textContent = `✅ Incident ${inc.reference_code || `#${inc.id}`} · ${workflowStatus}`;

                const matEl = document.getElementById("phaseStepMaterialized");
                if (matEl) {
                    matEl.style.borderTopColor = "#22c55e";
                    matEl.style.color = "#22c55e";
                    matEl.textContent = "✓ Incident materialized";
                }
                const invEl = document.getElementById("phaseStepInvestigating");
                if (invEl) {
                    invEl.style.borderTopColor = "#38bdf8";
                    invEl.style.color = "#38bdf8";
                    invEl.textContent = "● LangGraph Investigation";
                }
                const streamEl = document.getElementById("phaseStepStreaming");
                if (streamEl) {
                    streamEl.style.borderTopColor = "#22c55e";
                    streamEl.style.color = "#15803d";
                    streamEl.textContent = "✓ Simulator → NiFi → RabbitMQ";
                }
                const completeEl = document.getElementById("phaseStepCompleted");
                if (completeEl) {
                    completeEl.style.borderTopColor = "#cbd5e1";
                    completeEl.style.color = "#64748b";
                    completeEl.textContent = "↗ Open incident for RCA";
                }

                let resolvedUrl = data.agentic_url || agenticUrl || "http://iktaratech.com:9015/#incidents";
                if (resolvedUrl.startsWith("/")) {
                    resolvedUrl = window.location.protocol + "//" + window.location.hostname + ":9015" + resolvedUrl;
                } else {
                    try {
                        const parsed = new URL(resolvedUrl);
                        if (window.location.hostname && !window.location.hostname.includes("iktaratech.com")) {
                            parsed.hostname = window.location.hostname;
                            resolvedUrl = parsed.toString();
                        }
                    } catch (_) {}
                }

                detail.innerHTML = `
                    <div class="incident-ready-banner">
                        <div>
                            <div style="font-weight:700;font-size:14px;color:#15803d;display:flex;align-items:center;gap:6px">
                                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a"></span> Telemetry Correlated in AgenticNOC
                            </div>
                            <div style="font-family:var(--font-mono);font-size:12px;color:#166534;margin-top:4px">
                                Incident: <strong>${escapeHtml(inc.reference_code || `#${inc.id}`)}</strong> &bull; Severity: <strong>${escapeHtml(incidentSeverity)}</strong> &bull; Node: <strong>${escapeHtml(incidentNode)}</strong>
                            </div>
                            <div style="font-size:11px;color:#15803d;margin-top:2px">
                                Multi-agent LangGraph: <strong>${escapeHtml(workflowStatus)}</strong> · ClickHouse PM evidence sealed
                            </div>
                        </div>
                        <div>
                            <a href="${escapeHtml(resolvedUrl)}" target="_blank" rel="noopener" class="btn-open-agentic">
                                Open Incident in AgenticNOC &rarr;
                            </a>
                        </div>
                    </div>
                `;
                const terminal = ["completed", "escalated", "failed", "cancelled"].includes(String(data.status || "").toLowerCase());
                if (terminal) {
                    clearInterval(scenarioPollTimer);
                    btn.disabled = false;
                }
            }
            if (["failed", "cancelled"].includes(status)) {
                statusText.textContent = `⚠ ${data.failure_reason || "Scenario run stopped"}`;
                clearInterval(scenarioPollTimer);
                btn.disabled = false;
            }
        } catch (_) {}
        finally { requestInFlight = false; }
    }, 1500);
}
