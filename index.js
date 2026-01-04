const express = require("express");
const cron = require("node-cron");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// ==== ENV ที่ต้องตั้งบน Render ====
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// ==== ENV สำหรับหวย ====
const LOTTO_API_BASE = process.env.LOTTO_API_BASE; // เช่น https://thai-lotto-api-test.onrender.com

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error("Missing env: LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET");
  process.exit(1);
}

const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

const app = express();

// health check
app.get("/", (req, res) => res.send("PNK LINE Bot is running ✅"));

// ===== storage targets (group/room) =====
const DATA_DIR = path.join(__dirname, "data");
const TARGET_FILE = path.join(DATA_DIR, "targets.json");
const LAST_SENT_FILE = path.join(DATA_DIR, "lastSent.json");

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(TARGET_FILE))
    fs.writeFileSync(TARGET_FILE, JSON.stringify({ targets: [] }, null, 2));
  if (!fs.existsSync(LAST_SENT_FILE))
    fs.writeFileSync(LAST_SENT_FILE, JSON.stringify({}, null, 2));
}

function readTargets() {
  ensureStorage();
  const raw = fs.readFileSync(TARGET_FILE, "utf8");
  const json = JSON.parse(raw);
  return Array.isArray(json.targets) ? json.targets : [];
}

function writeTargets(targets) {
  ensureStorage();
  fs.writeFileSync(TARGET_FILE, JSON.stringify({ targets }, null, 2));
}

function readLastSent() {
  ensureStorage();
  try {
    return JSON.parse(fs.readFileSync(LAST_SENT_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeLastSent(obj) {
  ensureStorage();
  fs.writeFileSync(LAST_SENT_FILE, JSON.stringify(obj, null, 2));
}

function addTarget(t) {
  const targets = readTargets();
  const exists = targets.some((x) => x.type === t.type && x.id === t.id);
  if (!exists) {
    targets.push(t);
    writeTargets(targets);
    console.log("Saved target:", t);
  }
}

// สำคัญ: ใช้ middleware ของ LINE เพื่อ verify signature
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    for (const ev of events) {
      const src = ev.source || {};
      if (src.type === "group" && src.groupId) addTarget({ type: "group", id: src.groupId });
      else if (src.type === "room" && src.roomId) addTarget({ type: "room", id: src.roomId });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ===== push helper (รองรับ text และ object message เช่น flex) =====
async function pushToAllTargets(messageOrText) {
  const targets = readTargets();
  if (targets.length === 0) {
    console.log("No targets yet. Invite bot to a group and send a message to capture groupId.");
    return { ok: false, reason: "no-targets", targets: [] };
  }

  const message =
    typeof messageOrText === "string"
      ? { type: "text", text: messageOrText }
      : messageOrText;

  const results = [];
  for (const t of targets) {
    try {
      await client.pushMessage({ to: t.id, messages: [message] });
      results.push({ target: t, ok: true });
      console.log("Pushed to", t.type, t.id);
    } catch (e) {
      results.push({ target: t, ok: false, error: e?.message || String(e) });
      console.error("Push failed to", t, e?.message || e);
    }
  }
  return { ok: true, targets, results };
}

// ===== helper สำหรับหวย =====
function pickById(arr, id) {
  return (arr || []).find((x) => x.id === id);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchLatestLotto() {
  if (!LOTTO_API_BASE) throw new Error("Missing env: LOTTO_API_BASE");
  const url = `${LOTTO_API_BASE.replace(/\/$/, "")}/latest`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (data?.status !== "success") throw new Error(`Lotto API status=${data?.status || "unknown"}`);
  return data;
}

function buildThaiLottoFlex(apiJson) {
  const r = apiJson?.response || {};
  const prizes = r.prizes || [];
  const runs = r.runningNumbers || [];

  const p1 = pickById(prizes, "prizeFirst");
  const p1near = pickById(prizes, "prizeFirstNear");
  const p2 = pickById(prizes, "prizeSecond");
  const p3 = pickById(prizes, "prizeThird");
  const p4 = pickById(prizes, "prizeForth");
  const p5 = pickById(prizes, "prizeFifth");

  const front3 = pickById(runs, "runningNumberFrontThree");
  const back3 = pickById(runs, "runningNumberBackThree");
  const back2 = pickById(runs, "runningNumberBackTwo");

  const firstNum = p1?.number?.[0] || "-";

  const contents = [
    { type: "text", text: "ผลสลากกินแบ่งรัฐบาล", weight: "bold", size: "lg" },
    { type: "text", text: r.date || "-", size: "sm", color: "#888888" },
    { type: "separator", margin: "md" },
    { type: "text", text: `รางวัลที่ 1: ${firstNum}`, weight: "bold", size: "xl", margin: "md" },
  ];

  if (p1near?.number?.length) {
    contents.push({
      type: "text",
      text: `ข้างเคียง: ${p1near.number.join("  ")}`,
      size: "sm",
      margin: "sm",
      wrap: true,
    });
  }

  contents.push({ type: "separator", margin: "md" });
  contents.push({
    type: "text",
    text: `หน้า 3 ตัว: ${(front3?.number || []).join("  ") || "-"}`,
    margin: "md",
    wrap: true,
  });
  contents.push({
    type: "text",
    text: `ท้าย 3 ตัว: ${(back3?.number || []).join("  ") || "-"}`,
    margin: "sm",
    wrap: true,
  });
  contents.push({
    type: "text",
    text: `ท้าย 2 ตัว: ${(back2?.number || []).join("  ") || "-"}`,
    margin: "sm",
    wrap: true,
  });

  function prizeBlock(title, nums) {
    if (!nums?.length) return;
    contents.push({ type: "text", text: title, weight: "bold", margin: "md" });
    for (const part of chunk(nums, 5)) {
      contents.push({
        type: "text",
        text: part.join("  "),
        size: "sm",
        margin: "sm",
        wrap: true,
      });
    }
  }

  contents.push({ type: "separator", margin: "md" });
  prizeBlock("รางวัลที่ 2", p2?.number);
  prizeBlock("รางวัลที่ 3", p3?.number);
  prizeBlock("รางวัลที่ 4", p4?.number);
  prizeBlock("รางวัลที่ 5", p5?.number);

  return {
    type: "flex",
    altText: `ผลสลาก ${r.date || ""} รางวัลที่ 1 ${firstNum}`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "link",
            action: {
              type: "uri",
              label: "ดูรายละเอียด",
              uri: r.endpoint || "https://news.sanook.com/lotto/",
            },
          },
        ],
      },
    },
  };
}

// ===== routes สำหรับเทส/ตรวจสอบ =====

// ดู target ที่บันทึกไว้
app.get("/targets", (req, res) => {
  const targets = readTargets();
  res.json({ count: targets.length, targets });
});

// ยิงเทสข้อความธรรมดาทันที
app.get("/test-push", async (req, res) => {
  const result = await pushToAllTargets("🧪 TEST: บอทส่งข้อความเข้ากลุ่มสำเร็จแล้ว");
  res.json(result);
});

// ยิงเทส “ผลหวยล่าสุด” (Flex) ทันที
app.get("/send-lotto-now", async (req, res) => {
  try {
    const data = await fetchLatestLotto();
    const flex = buildThaiLottoFlex(data);
    const result = await pushToAllTargets(flex);
    res.json({ ok: true, draw: data?.response?.date, endpoint: data?.response?.endpoint, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ===== cron schedules (Asia/Bangkok) =====

// เปิด/ปิดร้าน (ของเดิมคุณ)
cron.schedule("0 8 * * *", async () => {
  await pushToAllTargets("✅ ร้านเปิดแล้ว (08:00)");
}, { timezone: "Asia/Bangkok" });

cron.schedule("0 22 * * *", async () => {
  await pushToAllTargets("🌙 ร้านปิดแล้ว (22:00) test");
}, { timezone: "Asia/Bangkok" });

// ✅ ส่งผลหวยอัตโนมัติ (กันส่งซ้ำ)
// แนะนำตั้งหลังหวยออก เช่น 16:05 (ปรับได้)
cron.schedule("5 16 * * *", async () => {
  try {
    const last = readLastSent();
    const data = await fetchLatestLotto();

    const drawKey = data?.response?.date || data?.response?.endpoint;
    if (!drawKey) return;

    // กันส่งซ้ำ
    if (last.thaiLotto === drawKey) {
      console.log("Lotto already sent for:", drawKey);
      return;
    }

    const flex = buildThaiLottoFlex(data);
    await pushToAllTargets(flex);

    last.thaiLotto = drawKey;
    writeLastSent(last);

    console.log("Lotto sent for:", drawKey);
  } catch (e) {
    console.error("Lotto cron error:", e?.message || e);
  }
}, { timezone: "Asia/Bangkok" });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
