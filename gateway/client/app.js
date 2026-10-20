/**
 * Browser demo for the decider gateway. Plain JavaScript, no build step, loaded by
 * index.html as a classic script.
 *
 * It ships in the Lambda asset and is served from `/`, so it is also the fastest way to
 * confirm a deployment works: paste a key, press Decide, read the probabilities and the band.
 *
 * Three scenarios are hard-coded rather than free-form, because the model is a *system one*
 * decider — it scores options you name, it does not write prose. The scenarios show the three
 * question types (choice, score, noul) and the three ways to use them:
 *
 *   - "Deploy?"        choice  + gate      -> act / review / escalate on a deploy decision
 *   - "Loan risk"      score   + gate      -> an ordinal level, probability-weighted
 *   - "A/B preference" noul    (no gate)   -> pairwise preference, as a probability
 */
const $ = (id) => document.getElementById(id);

const SCENARIOS = {
  deploy: {
    label: "Deploy now? (choice)",
    hint: "A release gate: the model scores each option, the gateway says whether to act on the top one.",
    state: {
      service: "checkout-api",
      change: "bump the retry budget from 3 to 5 on the payment client",
      signals: {
        tests: "all green, 4 min",
        canary_error_rate: "0.42% vs 0.38% baseline",
        canary_p95_ms: 812,
        baseline_p95_ms: 640,
        pager_volume_7d: 2,
      },
      reversibility: "single flag, instant rollback",
    },
    questions: {
      deploy: {
        type: "choice",
        instructions: "Choose what to do with this change, given the state.",
        criteria: {
          ship: "release to 100% now",
          hold: "keep the canary running and re-check in an hour",
          revert: "roll the canary back now",
        },
      },
    },
    gate: true,
  },
  loan: {
    label: "Loan risk (score)",
    hint: "An ordered scale from least to most risky. The levels are listed lowest first.",
    state: {
      amount: 42_000,
      term_months: 60,
      purpose: "consolidate revolving credit",
      applicant: { income_stability: "6 years salaried", dti: 0.31, delinquencies_24m: 0, score: 712 },
      collateral: "none",
    },
    questions: {
      risk: {
        type: "score",
        instructions: "Place this application on the risk scale.",
        criteria: [
          "very low risk — approve at standard terms",
          "low risk — approve, small rate loading",
          "moderate risk — approve with conditions",
          "elevated risk — manual review required",
          "high risk — decline",
        ],
      },
    },
    gate: true,
  },
  pref: {
    label: "Which answer is better? (noul)",
    hint: "A pairwise preference: the probability that the first choice is better. The verdict flips at 0.5.",
    state: "The user asked how to undo the last commit. Answer A correctly uses `git reset --soft HEAD~1` and explains that the changes are kept staged. Answer B suggests `git reset --hard HEAD~1`, which discards the user's work, and does not warn about it.",
    questions: {
      a_is_better: {
        type: "noul",
        instructions: "Is Answer A better than Answer B?",
      },
    },
    gate: false,
  },
};

function render(which) {
  const scenario = SCENARIOS[which];
  $("scenarioHint").textContent = scenario.hint;
  $("gate").checked = scenario.gate;
  const inputs = $("inputs");
  inputs.replaceChildren();
  for (const [name, value] of Object.entries(scenario.state && typeof scenario.state === "object" ? scenario.state : { text: scenario.state })) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = name;
    const area = document.createElement("textarea");
    area.rows = 5;
    area.dataset.field = name;
    area.spellcheck = false;
    area.value = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    label.append(span, area);
    inputs.append(label);
  }
}

/** Rebuild the `state` object from the textareas, parsing anything that looks like JSON. */
function readState(which) {
  const scenario = SCENARIOS[which];
  if (scenario.state === null || typeof scenario.state !== "object") {
    const only = $("inputs").querySelector("textarea");
    return only ? only.value : "";
  }
  const state = {};
  for (const area of $("inputs").querySelectorAll("textarea")) {
    const raw = area.value;
    try {
      state[area.dataset.field] = JSON.parse(raw);
    } catch {
      state[area.dataset.field] = raw;
    }
  }
  return state;
}

function stat(name, value, cls = "") {
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (cls) dd.className = cls;
  $("stats").append(dt, dd);
}

const pct = (p) => `${(p * 100).toFixed(1)}%`;

/** Render whatever result shape came back; the question type decides it. */
function show(answers, bands) {
  const answer = $("answer");
  answer.replaceChildren();
  answer.className = "answer";

  for (const [name, result] of Object.entries(answers)) {
    if (Object.keys(answers).length > 1) {
      const h = document.createElement("h3");
      h.textContent = name;
      answer.append(h);
    }

    if (result.type === "choice") {
      const top = document.createElement("p");
      top.className = "headline";
      top.textContent = result.choice;
      answer.append(top);

      for (const [option, p] of Object.entries(result.probabilities).sort((a, b) => b[1] - a[1])) {
        const row = document.createElement("div");
        row.className = "bar" + (option === result.choice ? " won" : "");
        const label = document.createElement("span");
        label.textContent = option;
        const track = document.createElement("div");
        track.className = "track";
        const fill = document.createElement("i");
        fill.style.width = pct(p);
        track.append(fill);
        const num = document.createElement("b");
        num.textContent = pct(p);
        row.append(label, track, num);
        answer.append(row);
      }
    } else if (result.type === "score") {
      const top = document.createElement("p");
      top.className = "headline";
      top.textContent = `${result.score.toFixed(2)} — ${result.legend[result.level]}`;
      answer.append(top);

      for (const [level, p] of Object.entries(result.probabilities)) {
        const row = document.createElement("div");
        row.className = "bar" + (Number(level) === result.level ? " won" : "");
        const label = document.createElement("span");
        label.textContent = `${level} · ${result.legend[level]}`;
        const track = document.createElement("div");
        track.className = "track";
        const fill = document.createElement("i");
        fill.style.width = pct(p);
        track.append(fill);
        const num = document.createElement("b");
        num.textContent = pct(p);
        row.append(label, track, num);
        answer.append(row);
      }
    } else {
      const top = document.createElement("p");
      top.className = "headline";
      top.textContent = `${result.verdict ? "Yes" : "No"} — P(yes) = ${pct(result.probability)}`;
      answer.append(top);
      if (Math.abs(result.probability - 0.5) < 0.05) {
        const warn = document.createElement("p");
        warn.className = "warn";
        warn.textContent = "This is a coin flip. Treat it as “don’t know”, not as a decision.";
        answer.append(warn);
      }
    }

    if (bands && bands[name]) {
      const band = document.createElement("p");
      band.className = `band ${bands[name]}`;
      band.textContent = bands[name];
      answer.append(band);
    }
  }
}

async function decide() {
  const which = $("scenario").value;
  const scenario = SCENARIOS[which];
  const key = $("apiKey").value.trim();
  if (!key) {
    $("status").textContent = "An API key is required.";
    return;
  }

  $("run").disabled = true;
  $("status").textContent = "Running…";
  $("stats").hidden = true;
  $("stats").replaceChildren();
  $("rawWrap").hidden = true;
  $("answer").className = "answer idle";
  $("answer").innerHTML = '<p class="placeholder">Running…</p>';

  const body = { state: readState(which), questions: scenario.questions, cache: $("cache").checked };
  if ($("gate").checked) body.bands = { act: 0.6, review: 0.45, metric: "top" };

  const started = performance.now();
  try {
    const res = await fetch("/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
    });
    const wall = Math.round(performance.now() - started);
    const json = await res.json();

    if (!res.ok) {
      $("answer").className = "answer bad";
      $("answer").innerHTML = "";
      const p = document.createElement("p");
      p.className = "headline";
      p.textContent = `${json.error?.code ?? res.status}`;
      const m = document.createElement("p");
      m.textContent = json.error?.message ?? "request failed";
      $("answer").append(p, m);
      $("rid").textContent = json.request_id ? `request_id: ${json.request_id}` : "";
      $("status").textContent = "Failed.";
      return;
    }

    show(json.answers, json.bands);
    $("stats").hidden = false;
    stat("wall", `${wall} ms`);
    stat("model", `${json.latency_ms} ms`, json.latency_ms > 8000 ? "warn" : "");
    if (json.model_latency_ms !== undefined) stat("inference", `${json.model_latency_ms} ms`);
    stat("cache", json.cached ? "hit" : res.headers.get("x-cache") ?? "miss");
    stat("tokens", `${json.usage?.input_tokens ?? 0} in / ${json.usage?.output_tokens ?? 0} out`);
    stat("model id", json.model_id ?? json.model);
    $("raw").textContent = JSON.stringify(json, null, 2);
    $("rawWrap").hidden = false;
    $("rid").textContent = `request_id: ${json.request_id}`;
    $("status").textContent = "";
  } catch (error) {
    $("answer").className = "answer bad";
    $("answer").innerHTML = "";
    const p = document.createElement("p");
    p.textContent = error.message;
    $("answer").append(p);
    $("status").textContent = "Network error.";
  } finally {
    $("run").disabled = false;
  }
}

const select = $("scenario");
for (const [value, scenario] of Object.entries(SCENARIOS)) {
  select.add(new Option(scenario.label, value));
}
select.onchange = () => render(select.value);
$("run").onclick = decide;
$("apiKey").value = localStorage.getItem("decider.apiKey") ?? "";
$("apiKey").onchange = () => localStorage.setItem("decider.apiKey", $("apiKey").value);
render(select.value);
