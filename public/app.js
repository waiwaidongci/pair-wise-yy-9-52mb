const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
let state = null;

async function api(path, options) {
  const res = await fetch(path, options && options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const fmtTime = (iso) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const pad = (n) => String(n).padStart(2, "0");
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let msgTimer = null;
function showMsg(text, isError) {
  const el = $("#msg");
  el.textContent = text || "";
  el.className = text ? (isError ? "error" : "ok") : "";
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { el.textContent = ""; el.className = ""; }, 8000);
}

async function load() {
  state = await api("/api/state");
  render();
}

function render() {
  renderStats();
  renderBoard();
  renderRinseTab();
  renderPendingTab();
  renderFilmChips();
}

function renderStats() {
  const s = state.stats;
  $("#stats").innerHTML = [
    ["水缸总数", s.tanks],
    ["可用", s.open],
    ["待复检", s.pending],
    ["有效冲洗记录", s.rinses],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("");
  $("#pendingBadge").textContent = s.pending || "";
  $("#limitLine").textContent =
    `限值：银盐浓度 ≤ ${state.limits.silverMax} mg/L，浊度 ≤ ${state.limits.turbidityMax} NTU，检测 ${state.limits.testValidHours} 小时内有效；复检须另一人连续 ${state.recheckNeeded} 次合格。`;
}

function tankOptions(tanks, { onlyPending = false, disablePending = false } = {}) {
  return tanks
    .filter((t) => !onlyPending || t.evaluation.status === "待复检")
    .map((t) => {
      const pending = t.evaluation.status === "待复检";
      const disabled = disablePending && pending ? "disabled" : "";
      const label = `${t.name}（${t.id}）· ${t.evaluation.status}`;
      return `<option value="${t.id}" ${disabled}>${esc(label)}</option>`;
    })
    .join("");
}

function renderBoard() {
  $("#tankCards").innerHTML = state.tanks.map((t) => {
    const ev = t.evaluation;
    const pill = ev.status === "可用"
      ? '<span class="pill open">可用</span>'
      : '<span class="pill pending">待复检</span>';
    const reasons = ev.reasons.length
      ? `<ul class="reasons">${ev.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
    const streak = t.streak
      ? `<div class="meta">复检已连续合格 ${t.streak}/${state.recheckNeeded} 次（${esc(t.streakBy)}）</div>` : "";
    const rechecks = (t.rechecks || []).slice(-3).reverse()
      .map((r) => `<div>${r.pass ? "✅" : "❌"} ${esc(r.by)} · 银盐 ${r.silver} · 浊度 ${r.turbidity} · ${fmtTime(r.at)}</div>`)
      .join("");
    return `<article class="card">
      <h3>${esc(t.name)} <span class="meta">${t.id}</span></h3>
      ${pill}
      <div><b>来源</b> ${esc(t.source)} · <b>容量</b> ${t.capacity} 升</div>
      <div><b>银盐浓度</b> ${t.silver} mg/L · <b>浊度</b> ${t.turbidity} NTU</div>
      <div><b>检测</b> ${fmtTime(t.testedAt)}（${ev.testAgeHours.toFixed(1)} 小时前）· <b>检测人</b> ${esc(t.testedBy)}</div>
      <div class="meta">有效冲洗 ${t.activeRinses} 次</div>
      ${reasons}${streak}
      ${rechecks ? `<div class="logs meta">${rechecks}</div>` : ""}
      <div><button class="secondary" data-goto-retest="${t.id}">改检测</button></div>
    </article>`;
  }).join("") || '<p class="meta">还没有水缸，请先到「建缸」登记。</p>';
}

function renderRinseTab() {
  $("#rinseTank").innerHTML = tankOptions(state.tanks, { disablePending: true });
  $("#rinseStage").innerHTML = state.stages.map((s) => `<option>${s}</option>`).join("");
  $("#rinseSlot").innerHTML = state.slots.map((s) => `<option>${s}</option>`).join("");
  if (!$("#rinseDate").value) $("#rinseDate").value = today();

  const rows = state.rinses.filter((r) => r.status === "有效");
  $("#rinseTable").innerHTML = rows.length ? `<table>
    <tr><th>记录时间</th><th>水缸</th><th>底片</th><th>用途</th><th>时段</th><th>用水量</th><th>操作人</th></tr>
    ${rows.map((r) => `<tr>
      <td>${fmtTime(r.at)}</td><td>${esc(r.tankName)}</td><td>${esc(r.film)}</td>
      <td>${esc(r.stage)}</td><td>${esc(r.slot)}</td><td>${r.liters} 升</td><td>${esc(r.operator)}</td>
    </tr>`).join("")}
  </table>` : '<p class="meta">暂无有效冲洗记录。</p>';
}

function renderPendingTab() {
  const pending = state.tanks.filter((t) => t.evaluation.status === "待复检");
  $("#pendingList").innerHTML = pending.map((t) => {
    const ev = t.evaluation;
    const streak = t.streak
      ? `<div class="meta">已连续合格 ${t.streak}/${state.recheckNeeded} 次（${esc(t.streakBy)}），换人需重计。</div>`
      : '<div class="meta">尚无合格复检。</div>';
    const rechecks = (t.rechecks || []).slice(-4).reverse()
      .map((r) => `<div>${r.pass ? "✅" : "❌"} ${esc(r.by)} · 银盐 ${r.silver} · 浊度 ${r.turbidity} · ${fmtTime(r.at)}</div>`)
      .join("");
    return `<article class="card">
      <h3>${esc(t.name)} <span class="meta">${t.id}</span></h3>
      <ul class="reasons">${ev.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <div class="meta">检测人 ${esc(t.testedBy)} · ${fmtTime(t.testedAt)}</div>
      ${streak}
      ${rechecks ? `<div class="logs meta">${rechecks}</div>` : ""}
    </article>`;
  }).join("") || '<p class="meta">没有待复检的水缸。</p>';

  $("#recheckTank").innerHTML = tankOptions(state.tanks, { onlyPending: true }) || '<option value="">（无待复检水缸）</option>';
  $("#retestTank").innerHTML = tankOptions(state.tanks);
}

function renderFilmChips() {
  $("#filmChips").innerHTML = state.films.length
    ? "已有记录的底片：" + state.films.map((f) => `<button data-film="${esc(f)}">${esc(f)}</button>`).join("")
    : "";
}

async function searchFilm(code) {
  const film = (code ?? $("#filmQuery").value).trim();
  if (!film) return showMsg("请输入底片编号", true);
  $("#filmQuery").value = film;
  const rows = await api("/api/films/" + encodeURIComponent(film) + "/history");
  $("#historyTable").innerHTML = rows.length ? `<table>
    <tr><th>记录时间</th><th>水缸</th><th>用途</th><th>时段</th><th>用水量</th><th>操作人</th><th>状态</th><th>改用途</th></tr>
    ${rows.map((r) => `<tr>
      <td>${fmtTime(r.at)}</td><td>${esc(r.tankName)}</td><td>${esc(r.stage)}</td>
      <td>${esc(r.slot)}</td><td>${r.liters} 升</td><td>${esc(r.operator)}</td>
      <td class="${r.status === "有效" ? "" : "recalled"}">${esc(r.status)}</td>
      <td>${r.status === "有效" ? `
        <select id="ns-${r.id}">${state.stages.map((s) => `<option ${s === r.stage ? "selected" : ""}>${s}</option>`).join("")}</select>
        <button data-restage="${r.id}">改用途</button>` : ""}</td>
    </tr>`).join("")}
  </table>` : `<p class="meta">底片 ${esc(film)} 暂无用水记录。</p>`;
}

// —— 事件 ——
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  $$(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + btn.dataset.tab));
});

$("#reload").onclick = load;

$("#createForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const tank = await api("/api/tanks", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
    showMsg(`已建缸 ${tank.name}（${tank.id}）`);
    e.target.reset();
    await load();
  } catch (err) { showMsg(err.message, true); }
};

$("#rinseForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/rinses", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
    showMsg(`已登记：底片 ${r.film} 于 ${r.tankName}「${r.slot}」${r.stage}，用水 ${r.liters} 升`);
    e.target.reset();
    $("#rinseDate").value = today();
    await load();
  } catch (err) { showMsg(err.message, true); }
};

$("#recheckForm").onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  if (!data.tankId) return showMsg("没有待复检的水缸", true);
  try {
    const r = await api(`/api/tanks/${data.tankId}/recheck`, { method: "POST", body: JSON.stringify(data) });
    showMsg(r.reopened
      ? `复检合格，${r.tank.name} 已连续两次合格，重新开放`
      : r.pass
        ? `复检合格，${r.tank.name} 已连续合格 ${r.streak}/${r.needed} 次`
        : `复检不合格，${r.tank.name} 连续合格次数清零`);
    e.target.reset();
    await load();
  } catch (err) { showMsg(err.message, true); }
};

$("#retestForm").onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    const r = await api(`/api/tanks/${data.tankId}/test`, { method: "POST", body: JSON.stringify(data) });
    showMsg(`检测已改写：${r.tank.name} 许可退回待复检，${r.recalled} 条后续冲洗记录退回重算`);
    e.target.reset();
    await load();
  } catch (err) { showMsg(err.message, true); }
};

$("#filmSearch").onclick = () => searchFilm().catch((err) => showMsg(err.message, true));
$("#filmQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); searchFilm().catch((err) => showMsg(err.message, true)); }
});

document.addEventListener("click", async (e) => {
  const chip = e.target.closest("[data-film]");
  if (chip) {
    try { await searchFilm(chip.dataset.film); } catch (err) { showMsg(err.message, true); }
    return;
  }
  const goto = e.target.closest("[data-goto-retest]");
  if (goto) {
    $(`#tabs button[data-tab="pending"]`).click();
    $("#retestTank").value = goto.dataset.gotoRetest;
    return;
  }
  const restage = e.target.closest("[data-restage]");
  if (restage) {
    const id = restage.dataset.restage;
    const stage = $("#ns-" + id).value;
    try {
      const r = await api(`/api/rinses/${id}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
      showMsg(`用途已改为「${r.rinse.stage}」：${r.recalled} 条冲洗记录退回重算，${r.tank.name} 许可退回待复检`);
      await load();
      await searchFilm();
    } catch (err) { showMsg(err.message, true); }
  }
});

load().catch((err) => showMsg(err.message, true));
