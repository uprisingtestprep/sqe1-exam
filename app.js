/* SQE1 Exam Simulator, Application Logic */

const ACCESS_CODE  = "SQE19000";
const EXAM_SECONDS = 18360;
const PASSING_PCT  = 60;
const NO_PASS_MARK = true;   // exam publishes no pass mark: show a practice benchmark, never PASS or FAIL
const STORAGE_KEY  = "sqe1_exam_state_v1";
const SIM_Q_COUNT  = 170;  // simulator serves this project's configured pool size (config.json exam.sim_questions)
const CLUSTER_LABEL = "Case";
const DOMAIN_LABELS = {"business_law_and_practice": "Business Law and Practice", "dispute_resolution": "Dispute Resolution", "contract_law": "Contract Law", "tort_law": "Tort Law", "legal_system_of_england_and_wales": "Legal System of England and Wales", "legal_services": "Legal Services", "property_law_and_practice": "Property Law and Practice", "land_law": "Land Law", "wills_and_administration_of_estates": "Wills and Administration of Estates", "trusts_law": "Trusts Law", "criminal_liability": "Criminal Liability", "criminal_law_and_practice": "Criminal Law and Practice"};  // maps domain key -> human-readable label for display
function domainLabel(key) { return DOMAIN_LABELS[key] || key || ""; }

let questions = [];
let state = {
  phase: "gate", answers: {}, flags: {},
  current: 1, timeLeft: EXAM_SECONDS,
  submitted: false, startTime: null,
  mode: null, qids: null,
};
let ALL_Q = [];
let timerInterval = null;

// ── boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  ALL_Q = (window.EXAM_QUESTIONS || []).slice();
  restoreState();
  // Rebuild the SAME sitting after a reload from the saved question ids, so saved answers still line up.
  const byId = new Map(ALL_Q.map(q => [q.id, q]));
  if (state.qids && state.qids.length && !state.submitted) {
    questions = state.qids.map(id => byId.get(id)).filter(Boolean);
    if (questions.length !== state.qids.length) { questions = []; state.qids = null; state.mode = null; state.answers = {}; state.flags = {}; state.startTime = null; }
  }

  document.getElementById("access-gate").style.display = "flex";
  document.getElementById("app").style.display = "none";
  setupAccessGate();
});

// Shuffle by UNIT, never by individual question. A cluster is several
// questions sharing one case or passage: they must stay together and in their
// authored order, because later questions refer back to the same material.
// Shuffling every question individually scatters them across the exam, so a
// candidate meets question 6 about a passage before ever seeing the passage.
// That bug reached CNPLE's LIVE site and only a real browser found it.
// Truncation is done on a unit boundary too, so a cluster is never cut in half.
function clusterId(q) {
  return q.cluster_id || q.case_id || q.passage_id || null;
}

function pickQuestions(all, limit) {
  const units = [], byId = new Map();
  for (const q of all) {
    const c = clusterId(q);
    if (!c) { units.push([q]); continue; }
    if (!byId.has(c)) { const u = []; byId.set(c, u); units.push(u); }
    byId.get(c).push(q);
  }
  shuffleUnits(units);

  const out = [];
  for (const u of units) {
    if (out.length + u.length > limit) continue;   // never split a cluster
    for (const q of u) out.push(q);
  }
  // Repair any run of 3 identical keys with random swaps, keeping a swap only if it does not make things worse.
  const runCount = a => { let n = 0; for (let i = 2; i < a.length; i++) if (a[i].correct === a[i-1].correct && a[i].correct === a[i-2].correct) n++; return n; };
  let runs = runCount(out);
  for (let tries = 0; runs > 0 && tries < 4000; tries++) {
    let i = -1;
    for (let k = 2; k < out.length; k++) if (out[k].correct === out[k-1].correct && out[k].correct === out[k-2].correct) { i = k; break; }
    if (i < 0 || clusterId(out[i])) break;
    const j = Math.floor(Math.random() * out.length);
    if (j === i || clusterId(out[j]) || out[j].correct === out[i].correct) continue;
    [out[i], out[j]] = [out[j], out[i]];
    const n = runCount(out);
    if (n <= runs) runs = n; else [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function shuffleUnits(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Prevent 3+ consecutive same correct answer. Only ever swaps two STANDALONE
// questions: swapping a clustered one would undo the grouping above.
function breakAnswerRuns(arr) {
  const free = i => arr[i] && !clusterId(arr[i]);
  for (let i = 2; i < arr.length; i++) {
    if (arr[i].correct === arr[i-1].correct && arr[i].correct === arr[i-2].correct) {
      if (!free(i)) continue;
      for (let j = i + 1; j < arr.length; j++) {
        if (free(j) && arr[j].correct !== arr[i-1].correct) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
}

// ── access gate ───────────────────────────────────────────────────────────────
function setupAccessGate() {
  const attempt = () => {
    const val = document.getElementById("access-code-input").value.trim().toUpperCase();
    if (val === ACCESS_CODE) {
      document.getElementById("access-gate").style.display = "none";
      afterGate();
    } else {
      const err = document.getElementById("access-error");
      err.textContent = "Incorrect access code. Please try again.";
      document.getElementById("access-code-input").value = "";
      document.getElementById("access-code-input").focus();
    }
  };
  document.getElementById("access-btn").addEventListener("click", attempt);
  document.getElementById("access-code-input").addEventListener("keydown",
    e => { if (e.key === "Enter") attempt(); });
}

// ── mode choice: FLK1, FLK2 or mixed ──────────────────────────────────────────
function afterGate() {
  if (state.submitted || !state.qids || !questions.length) {
    localStorage.removeItem(STORAGE_KEY);
    state = { phase: "gate", answers: {}, flags: {}, current: 1, timeLeft: EXAM_SECONDS, submitted: false, startTime: null, mode: null, qids: null };
    showModeSelect();
  } else {
    updatePoolChip(poolFor(state.mode).length);
    startExam();
  }
}

function poolFor(mode) {
  return ALL_Q.filter(q => mode === "mixed" || q.flk === (mode === "flk1" ? 1 : 2));
}

function showModeSelect() {
  document.getElementById("mode-screen").style.display = "flex";
  document.getElementById("mode-flk1-count").textContent = poolFor("flk1").length.toLocaleString();
  document.getElementById("mode-flk2-count").textContent = poolFor("flk2").length.toLocaleString();
  document.getElementById("mode-mixed-count").textContent = poolFor("mixed").length.toLocaleString();
  document.getElementById("mode-flk1-btn").onclick  = () => chooseMode("flk1");
  document.getElementById("mode-flk2-btn").onclick  = () => chooseMode("flk2");
  document.getElementById("mode-mixed-btn").onclick = () => chooseMode("mixed");
}

function chooseMode(mode) {
  const pool = poolFor(mode);
  questions = pickQuestions(pool.slice(), SIM_Q_COUNT);
  state.mode = mode;
  state.qids = questions.map(q => q.id);
  state.startTime = null;
  saveState();
  document.getElementById("mode-screen").style.display = "none";
  updatePoolChip(pool.length);
  startExam();
}

function updatePoolChip(n) {
  const label = state.mode === "flk1" ? "FLK1" : state.mode === "flk2" ? "FLK2" : "mixed";
  const chip = document.getElementById("pool-chip");
  if (chip) {
    chip.textContent = n.toLocaleString() + " Questions Available";
    chip.title = "This " + label + " sitting is " + SIM_Q_COUNT + " questions, the real FLK paper length, drawn at random from a pool of " + n.toLocaleString() + ". Restart for a fresh mix.";
  }
  const note = document.getElementById("pool-note-results");
  if (note) note.textContent = "This " + label + " sitting drew " + SIM_Q_COUNT + " questions from a pool of " + n.toLocaleString() + ". Restart for a fresh mix.";
}

// ── exam start ────────────────────────────────────────────────────────────────
function startExam() {
  if (state.submitted) {
    localStorage.removeItem(STORAGE_KEY);
    state = { phase: "gate", answers: {}, flags: {}, current: 1, timeLeft: EXAM_SECONDS, submitted: false, startTime: null, mode: null, qids: null };
  }
  document.getElementById("app").style.display = "flex";
  if (!state.startTime) state.startTime = Date.now();
  renderQuestion();
  startTimer();
  buildGrid();
  document.getElementById("submit-btn").addEventListener("click", confirmSubmit);
  document.getElementById("flag-btn").addEventListener("click",   toggleFlag);
  document.getElementById("prev-btn").addEventListener("click",   () => navigate(-1));
  document.getElementById("next-btn").addEventListener("click",   () => navigate(1));
  document.getElementById("map-btn").addEventListener("click",    openMapModal);
  document.getElementById("map-close").addEventListener("click",  closeMapModal);
  document.getElementById("map-backdrop").addEventListener("click", closeMapModal);
  document.addEventListener("keydown", keyHandler);
}

// ── timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (state.submitted) return;
    state.timeLeft = Math.max(0, EXAM_SECONDS - Math.floor((Date.now() - state.startTime) / 1000));
    updateTimerDisplay();
    if (state.timeLeft === 0) submitExam();
    saveState();
  }, 1000);
}

function updateTimerDisplay() {
  const h = Math.floor(state.timeLeft / 3600);
  const m = Math.floor((state.timeLeft % 3600) / 60);
  const s = state.timeLeft % 60;
  document.getElementById("timer-display").textContent =
    h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
           : `${m}:${String(s).padStart(2,"0")}`;
}

// ── render ─────────────────────────────────────────────────────────────────────
// Any renderer that injects content as HTML must escape it first. This helper
// was missing from the scaffold entirely, so every cluster/passage renderer
// copied in from a finished project threw ReferenceError on its first item.
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A cluster's shared text is shown above EVERY question in that cluster, so a
// candidate never has to page backwards to reread it. It scrolls inside its own
// box: unbounded, a 450 word passage pushes the stem and options below the fold.
function renderCluster(q) {
  const wrap = document.getElementById("q-cluster-wrap");
  if (!wrap) return;
  const text = q.cluster_text || q.case_text || q.passage_text || "";
  if (!text) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
  const body = String(text).split("\n").filter(l => l.trim())
    .map(l => `<p>${escapeHTML(l.trim())}</p>`).join("");
  wrap.innerHTML = `<div class="cluster-label">${CLUSTER_LABEL} `
                 + `${escapeHTML(clusterId(q) || "")}</div>`
                 + `<div class="cluster-body">${body}</div>`;
  wrap.style.display = "block";
}

function renderQuestion() {
  const q = questions[state.current - 1];
  if (!q) return;
  renderCluster(q);
  document.getElementById("q-counter").textContent = `Question ${state.current} of ${questions.length}`;
  document.getElementById("q-domain").textContent  = domainLabel(q.domain);
  document.getElementById("question-text").textContent = q.question;
  const imgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    imgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    imgWrap.style.display = "block";
  } else {
    imgWrap.innerHTML = "";
    imgWrap.style.display = "none";
  }
  const fi = document.getElementById("q-flag-indicator");
  fi.style.display = state.flags[state.current] ? "inline-block" : "none";

  document.getElementById("explanation-box").style.display = "none";

  const ol = document.getElementById("options-list");
  ol.innerHTML = "";
  const chosen = state.answers[state.current];
  ["A", "B", "C", "D", "E"].forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    div.className = "option" + (chosen === letter ? " selected" : "");
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${text}</span>`;
    div.addEventListener("click", () => selectAnswer(state.current, letter));
    ol.appendChild(div);
  });

  // Scroll question panel to top on navigation
  const panel = document.querySelector(".question-panel");
  if (panel) panel.scrollTop = 0;

  updateProgress();
  updateGrid();
}

function selectAnswer(qNum, letter) {
  if (state.submitted) return;
  state.answers[qNum] = letter;
  renderQuestion();
  saveState();
}

function navigate(dir) {
  const next = state.current + dir;
  if (next >= 1 && next <= questions.length) {
    state.current = next;
    renderQuestion();
  }
}

function toggleFlag() {
  state.flags[state.current] = !state.flags[state.current];
  renderQuestion();
  saveState();
}

function updateProgress() {
  const pct = Object.keys(state.answers).length / questions.length * 100;
  document.getElementById("progress-bar").style.width = pct + "%";
}

// ── question map modal ────────────────────────────────────────────────────────
function openMapModal() {
  updateGrid();
  document.getElementById("map-modal").style.display = "flex";
}

function closeMapModal() {
  document.getElementById("map-modal").style.display = "none";
}

// ── grid ──────────────────────────────────────────────────────────────────────
function buildGrid() {
  const grid = document.getElementById("q-grid");
  grid.innerHTML = "";
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.createElement("button");
    btn.className = "grid-btn";
    btn.id = `gb-${i}`;
    btn.textContent = i;
    btn.addEventListener("click", () => {
      state.current = i;
      closeMapModal();
      renderQuestion();
    });
    grid.appendChild(btn);
  }
}

function updateGrid() {
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.getElementById(`gb-${i}`);
    if (!btn) continue;
    btn.className = "grid-btn" +
      (state.answers[i]  ? " answered" : "") +
      (state.flags[i]    ? " flagged"  : "") +
      (state.current===i ? " active"   : "");
  }
}

// ── submit ────────────────────────────────────────────────────────────────────
function confirmSubmit() {
  const unanswered = questions.length - Object.keys(state.answers).length;
  if (unanswered > 0) {
    alert(`You must answer all ${questions.length} questions before submitting.\n\n${unanswered} question${unanswered > 1 ? "s" : ""} still unanswered.\n\nTap "Question Map" to find unanswered questions.`);
    return;
  }
  if (confirm("Submit your exam now?")) submitExam();
}

function submitExam() {
  clearInterval(timerInterval);
  state.submitted = true;
  saveState();
  showResults();
}

// ── results ───────────────────────────────────────────────────────────────────
function showResults() {
  document.getElementById("app").style.display = "none";
  document.getElementById("results-screen").style.display = "flex";

  let correct = 0;
  const domainStats = {};
  questions.forEach((q, idx) => {
    const num = idx + 1;
    const userAns = state.answers[num];
    const isRight = userAns === q.correct;
    if (isRight) correct++;
    const dom = q.domain || "Other";
    if (!domainStats[dom]) domainStats[dom] = { correct: 0, total: 0 };
    domainStats[dom].total++;
    if (isRight) domainStats[dom].correct++;
  });

  const pct  = Math.round(correct / questions.length * 100);
  const passed = pct >= PASSING_PCT;
  document.getElementById("res-status").textContent = NO_PASS_MARK ? (passed ? "ABOVE PRACTICE BENCHMARK" : "BELOW PRACTICE BENCHMARK") : (passed ? "PASS" : "FAIL");
  document.getElementById("res-status").style.color = passed ? "#059669" : "#DC2626";
  document.getElementById("res-score").textContent  = `${correct} / ${questions.length} (${pct}%)`;

  const domDiv = document.getElementById("res-domains");
  domDiv.innerHTML = "";
  Object.entries(domainStats).forEach(([dom, s]) => {
    const dp = Math.round(s.correct / s.total * 100);
    domDiv.innerHTML += `<div class="res-domain-row">
      <span class="res-domain-name">${domainLabel(dom)}</span>
      <div class="res-domain-bar-wrap"><div class="res-domain-bar" style="width:${dp}%;background:#1B3A6B"></div></div>
      <span class="res-domain-pct">${dp}%</span>
    </div>`;
  });

  document.getElementById("res-review-btn").addEventListener("click", () => {
    state.submitted = true;
    document.getElementById("results-screen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    renderReview();
  });
  document.getElementById("res-restart-btn").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function renderReview() {
  const ol = document.getElementById("options-list");
  const q  = questions[state.current - 1];
  if (!q) return;
  document.getElementById("q-counter").textContent = `Review, Question ${state.current} of ${questions.length}`;
  document.getElementById("question-text").textContent = q.question;
  const revImgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    revImgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    revImgWrap.style.display = "block";
  } else {
    revImgWrap.innerHTML = "";
    revImgWrap.style.display = "none";
  }
  ol.innerHTML = "";
  const userAns = state.answers[state.current];
  ["A", "B", "C", "D", "E"].forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    let cls = "option";
    if (letter === q.correct)      cls += " correct";
    else if (letter === userAns)   cls += " incorrect";
    div.className = cls;
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${text}</span>`;
    ol.appendChild(div);
  });

  const box  = document.getElementById("explanation-box");
  const expl = document.getElementById("explanation-text");
  if (q.explanation) {
    expl.textContent = q.explanation;
    box.style.display = "block";
  } else {
    box.style.display = "none";
  }

  document.getElementById("prev-btn").onclick = () => { navigate(-1); renderReview(); };
  document.getElementById("next-btn").onclick = () => { navigate(1);  renderReview(); };
}

// ── persistence ───────────────────────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}
function restoreState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { const s = JSON.parse(saved); Object.assign(state, s); }
  } catch(e) {}
}

// ── keyboard ──────────────────────────────────────────────────────────────────
function keyHandler(e) {
  const letter = e.key.toUpperCase();
  const q = questions[state.current - 1];
  if (["A", "B", "C", "D", "E"].includes(letter) && !e.ctrlKey && !e.metaKey && q?.options?.[letter]) {
    selectAnswer(state.current, letter);
  }
  if (e.key === "ArrowRight" && state.current < questions.length) navigate(1);
  if (e.key === "ArrowLeft"  && state.current > 1)                navigate(-1);
  if (e.key === "Escape") closeMapModal();
}
