// tempo-runner — engine gọi dịch vụ MPP, não Claude Haiku (trả qua Tempo).
// 1 lần chạy = 1 "lượt". Trên GitHub Actions, cron gọi file này nhiều lần trong ngày.
//
// MODE=mock  -> không gọi mạng, giả lập mọi thứ (miễn phí, test logic).
// MODE=live  -> gọi thật qua binary tempo-request (tốn USDC).
//
// State (log, strikes, spend) nằm trong ./state và được commit ngược về repo trên Actions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- Cấu hình ----------
const MODE = (process.env.MODE || "mock").toLowerCase();
const BOT_NAME = process.env.BOT_NAME || "tempo-runner";
const TEMPO_BIN = process.env.TEMPO_BIN || "tempo-request";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY || "";        // rỗng = dùng ví đã login sẵn (VPS)
const ANTHROPIC_URL = "https://anthropic.mpp.tempo.xyz/v1/messages";
const HAIKU_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";
const HAIKU_MAX_SPEND = process.env.HAIKU_MAX_SPEND || "0.05"; // trần cứng mỗi lượt gọi não
const HAIKU_EST = Number(process.env.HAIKU_EST || "0.004");    // ước lượng chi phí 1 lượt gọi não
const DAILY_CAP = Number(process.env.DAILY_CAP || "0.16");     // ~$5/tháng ÷ 30
const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT || "2");  // fail mấy lần thì gạch
const MOCK_ITERS = Number(process.env.MOCK_ITERS || "1");      // mock chạy mấy lượt liên tiếp
const MOCK_FAIL = (process.env.MOCK_FAIL || "").split(",").filter(Boolean); // ép fail service id

const STATE_DIR = path.join(__dir, "state");
const LOG_FILE = path.join(STATE_DIR, "log.txt");
const STRIKES_FILE = path.join(STATE_DIR, "strikes.json");
const SPEND_FILE = path.join(STATE_DIR, "spend.json");
const PLAN_FILE = path.join(STATE_DIR, "plan.json");

const ACTIVE_START_MIN = 7 * 60;   // 07:00 VN
const ACTIVE_END_MIN = 22 * 60;    // 22:00 VN (khớp withinActiveHours)
const MIN_GAP_MIN = 45;            // 2 lượt cách nhau tối thiểu 45 phút
const MIN_DAILY_RUNS = Number(process.env.MIN_DAILY_RUNS || "5");
const MAX_DAILY_RUNS = Number(process.env.MAX_DAILY_RUNS || "10");

const services = JSON.parse(fs.readFileSync(path.join(__dir, "services.json"), "utf8"));

// ---------- Tiện ích ----------
function ensureState() { fs.mkdirSync(STATE_DIR, { recursive: true }); }

function readJSON(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; }
}
function writeJSON(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }

// Giờ + ngày theo múi Việt Nam (UTC+7)
function vnNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
function vnDateStr() { return vnNow().toISOString().slice(0, 10); }
function vnStamp() {
  const d = vnNow();
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function vnHour() { return vnNow().getUTCHours(); }
function vnMinuteOfDay() { const d = vnNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function withinActiveHours() {
  if (process.env.FORCE_ACTIVE === "1") return true; // bypass để test
  const h = vnHour(); return h >= 7 && h < 22;
}

function logLine(service, request, ok) {
  const line = `${vnStamp()} – ${service} – ${request} – ${ok ? "Thành công" : "Thất bại"}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log("LOG> " + line);
}

// Gửi 1 dòng tóm tắt vào Telegram (nếu có TELEGRAM_TOKEN + CHAT_ID). Best-effort, dùng curl (đồng bộ).
function sendTelegram(text) {
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  try {
    execFileSync("curl", ["-s", "-m", "15", "-X", "POST",
      `https://api.telegram.org/bot${tok}/sendMessage`,
      "--data-urlencode", `chat_id=${chat}`,
      "--data-urlencode", `text=${text}`], { stdio: "ignore" });
  } catch {}
}

// ---------- State: strikes & spend ----------
function loadStrikes() { return readJSON(STRIKES_FILE, {}); }
function saveStrikes(s) { writeJSON(STRIKES_FILE, s); }

function loadSpend() {
  const s = readJSON(SPEND_FILE, { date: vnDateStr(), spent: 0 });
  if (s.date !== vnDateStr()) return { date: vnDateStr(), spent: 0 }; // sang ngày mới -> reset
  return s;
}
function saveSpend(s) { writeJSON(SPEND_FILE, s); }

// ---------- State: kế hoạch giờ chạy ngẫu nhiên trong ngày ----------
// Mỗi ngày tự chọn N lượt (MIN_DAILY_RUNS..MAX_DAILY_RUNS) + N mốc giờ ngẫu nhiên
// (cách nhau tối thiểu MIN_GAP_MIN) trong khung ACTIVE_START_MIN..ACTIVE_END_MIN.
// Cron có gọi engine bao nhiêu lần cũng chỉ thực sự "bắn" đúng lúc chạm 1 mốc trong plan.
function genTargets() {
  const n = MIN_DAILY_RUNS + Math.floor(Math.random() * (MAX_DAILY_RUNS - MIN_DAILY_RUNS + 1));
  const span = ACTIVE_END_MIN - ACTIVE_START_MIN;
  for (let attempt = 0; attempt < 30; attempt++) {
    const pts = Array.from({ length: n }, () => ACTIVE_START_MIN + Math.floor(Math.random() * span)).sort((a, b) => a - b);
    let okGap = true;
    for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] < MIN_GAP_MIN) { okGap = false; break; }
    if (okGap) return pts;
  }
  return Array.from({ length: n }, (_, i) => ACTIVE_START_MIN + Math.floor((i + 0.5) * span / n)); // fallback: rải đều
}

function loadPlan() {
  const today = vnDateStr();
  const p = readJSON(PLAN_FILE, null);
  if (p && p.date === today) return p;
  const fresh = { date: today, targets: genTargets(), done: [] };
  fresh.done = fresh.targets.map(() => false);
  writeJSON(PLAN_FILE, fresh);
  console.log(`[plan] Ngày mới -> chọn ${fresh.targets.length} lượt ngẫu nhiên: ${fresh.targets.map(fmtMin).join(", ")} (giờ VN)`);
  return fresh;
}
function savePlan(p) { writeJSON(PLAN_FILE, p); }
function fmtMin(m) { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

// Có mốc nào trong plan đã tới giờ mà chưa chạy không? Nếu có, đánh dấu đã dùng và trả về true.
function claimDueSlot(plan) {
  const now = vnMinuteOfDay();
  for (let i = 0; i < plan.targets.length; i++) {
    if (!plan.done[i] && plan.targets[i] <= now) {
      plan.done[i] = true;
      savePlan(plan);
      return true;
    }
  }
  return false;
}

// Danh sách dịch vụ còn sống (chưa bị gạch)
function activeServices(strikes) {
  return services.filter((sv) => (strikes[sv.id]?.fails || 0) < STRIKE_LIMIT);
}

// ---------- Gọi tempo-request (live) ----------
function tempoRequest({ url, method = "POST", body, headers = {}, maxSpend }) {
  // Retry để chống lỗi 403/5xx chập chờn của payment-channel
  const args = ["-X", method, "--json", JSON.stringify(body),
    "-m", "120", "--retries", "3", "--retry-http", "403,408,429,500,502,503",
    "--retry-backoff", "1200", "--retry-jitter", "40", "--retry-after"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (maxSpend) args.push("--max-spend", String(maxSpend));
  if (PRIVATE_KEY) args.push("--private-key", PRIVATE_KEY);
  args.push(url);

  let stdout = "", ok = true, err = "";
  // TEMPO_BIN có thể là "tempo-request" hoặc dạng launcher "tempo request"
  const [bin, ...preArgs] = TEMPO_BIN.trim().split(/\s+/);
  try {
    stdout = execFileSync(bin, [...preArgs, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    ok = false;
    err = (e.stderr || e.message || "").toString();
    stdout = (e.stdout || "").toString();
  }

  // Coi 4xx/5xx problem trong body là thất bại
  if (ok && /"status"\s*:\s*(4|5)\d\d/.test(stdout) && /payment-required|error|problem/i.test(stdout)) ok = false;

  return { ok, stdout, err };
}

// ---------- Não Haiku ----------
function askBrain(active) {
  const menu = active.map((s) => `- id="${s.id}" | ${s.name} | ${s.bodyHint}`).join("\n");
  const sys = `You are an autonomous agent that keeps a set of paid web APIs warm by exercising them.
Choose exactly ONE service from the list and craft a valid, varied, realistic request body for it.
Return ONLY a compact JSON object, no prose, of the form:
{"serviceId":"<id>","body":{...},"note":"<short human summary of what you asked, <=8 words>"}`;
  const user = `Available services:\n${menu}\n\nPick one and produce the JSON now.`;

  if (MODE === "mock") {
    const s = active[Math.floor(Math.random() * active.length)];
    return { serviceId: s.id, body: s.mockBody, note: `mock: ${s.name}` };
  }

  const res = tempoRequest({
    url: ANTHROPIC_URL,
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    maxSpend: HAIKU_MAX_SPEND,
    body: {
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{ role: "user", content: user }],
    },
  });
  if (!res.ok) throw new Error("Gọi não Haiku thất bại: " + (res.err || res.stdout).slice(0, 300));
  brainCost = HAIKU_EST; // gọi não thành công = có trả tiền

  // Bóc text từ response Anthropic rồi parse JSON bên trong
  let text = "";
  try {
    const j = JSON.parse(res.stdout);
    text = (j.content || []).map((c) => c.text || "").join("");
  } catch { text = res.stdout; }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Não không trả JSON hợp lệ: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

let brainCost = 0;

// ---------- Gọi 1 dịch vụ ----------
function callService(svc, body) {
  if (MODE === "mock") {
    const forcedFail = MOCK_FAIL.includes(svc.id);
    const ok = forcedFail ? false : Math.random() > 0.2; // 80% thành công
    return { ok, cost: ok ? svc.priceHint : 0 };
  }
  const res = tempoRequest({
    url: svc.url, method: svc.method, body,
    headers: { "content-type": "application/json" },
    maxSpend: svc.maxSpend,
  });
  return { ok: res.ok, cost: res.ok ? svc.priceHint : 0, detail: res.ok ? "" : (res.err || res.stdout).slice(0, 200) };
}

// ---------- Một lượt ----------
function runOnce() {
  if (!withinActiveHours()) {
    console.log(`[skip] Ngoài giờ hoạt động 7–22h VN (đang ${vnHour()}h VN).`);
    return false;
  }
  const spend = loadSpend();
  if (spend.spent >= DAILY_CAP) {
    console.log(`[skip] Đã chạm trần ngày $${spend.spent.toFixed(4)}/$${DAILY_CAP}. Nghỉ tới mai.`);
    return false;
  }
  const plan = loadPlan();
  if (process.env.FORCE_ACTIVE !== "1" && !claimDueSlot(plan)) {
    const left = plan.targets.filter((_, i) => !plan.done[i]);
    console.log(`[skip] Chưa tới mốc ngẫu nhiên nào trong plan hôm nay. Còn chờ: ${left.map(fmtMin).join(", ") || "(hết mốc)"}`);
    return false;
  }
  const strikes = loadStrikes();
  const active = activeServices(strikes);
  if (active.length === 0) { console.log("[stop] Mọi dịch vụ đều đã bị gạch."); return false; }

  let decision;
  try { decision = askBrain(active); }
  catch (e) { console.log("[error] " + e.message); return false; }

  const svc = services.find((s) => s.id === decision.serviceId) || active[0];
  const note = (decision.note || "").toString().slice(0, 80);

  const r = callService(svc, decision.body);
  logLine(svc.name, note || JSON.stringify(decision.body).slice(0, 60), r.ok);

  // Cập nhật strikes
  if (r.ok) {
    if (strikes[svc.id]) strikes[svc.id].fails = 0; // thành công -> xoá strike
  } else {
    const s = strikes[svc.id] || { fails: 0 };
    s.fails += 1; s.lastError = r.detail || "";
    strikes[svc.id] = s;
    if (s.fails >= STRIKE_LIMIT) console.log(`[strike] "${svc.name}" fail ${s.fails} lần -> GẠCH khỏi danh sách.`);
  }
  saveStrikes(strikes);

  // Cập nhật chi tiêu
  const cost = (r.cost || 0) + (brainCost || 0);
  spend.spent = Math.round((spend.spent + cost) * 1e6) / 1e6;
  saveSpend(spend);
  console.log(`[spend] Lượt này ~$${cost.toFixed(5)} | Hôm nay $${spend.spent.toFixed(5)}/$${DAILY_CAP}`);
  sendTelegram(`🤖 ${BOT_NAME}\n${svc.name} — ${note}\n${r.ok ? "✅ Thành công" : "❌ Thất bại"} · ~$${cost.toFixed(4)} · hôm nay $${spend.spent.toFixed(3)}/$${DAILY_CAP}`);
  brainCost = 0;
  return true;
}

// ---------- Main ----------
function main() {
  ensureState();
  console.log(`=== tempo-runner | MODE=${MODE} | ${vnStamp()} VN ===`);
  const iters = MODE === "mock" ? MOCK_ITERS : 1;
  for (let i = 0; i < iters; i++) {
    if (iters > 1) console.log(`\n--- lượt ${i + 1}/${iters} ---`);
    const cont = runOnce();
    if (!cont && MODE === "mock") break;
  }
}

main();
