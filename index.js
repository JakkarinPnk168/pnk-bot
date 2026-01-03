const express = require("express");
const cron = require("node-cron");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// ==== ENV ที่ต้องตั้งบน Render ====
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

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

// สำคัญ: ใช้ middleware ของ LINE เพื่อ verify signature
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const ev of events) {
      // เก็บ groupId/roomId เมื่อบอทอยู่ในแชทกลุ่ม/ห้อง
      const src = ev.source || {};
      if (src.type === "group" && src.groupId) {
        addTarget({ type: "group", id: src.groupId });
      } else if (src.type === "room" && src.roomId) {
        addTarget({ type: "room", id: src.roomId });
      }

      // (ไม่จำเป็นต้องตอบกลับ) แต่ขอ log ไว้ดู debug
      // console.log(JSON.stringify(ev, null, 2));
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ===== storage targets (group/room) =====
const DATA_DIR = path.join(__dirname, "data");
const TARGET_FILE = path.join(DATA_DIR, "targets.json");

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(TARGET_FILE)) fs.writeFileSync(TARGET_FILE, JSON.stringify({ targets: [] }, null, 2));
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

function addTarget(t) {
  const targets = readTargets();
  const exists = targets.some((x) => x.type === t.type && x.id === t.id);
  if (!exists) {
    targets.push(t);
    writeTargets(targets);
    console.log("Saved target:", t);
  }
}

// ===== push helper =====
async function pushToAllTargets(text) {
  const targets = readTargets();
  if (targets.length === 0) {
    console.log("No targets yet. Invite bot to a group and send a message to capture groupId.");
    return;
  }

  const messages = [{ type: "text", text }];

  for (const t of targets) {
    try {
      // Push API: to เป็น groupId/roomId ได้
      await client.pushMessage({
        to: t.id,
        messages,
      });
      console.log("Pushed to", t.type, t.id);
    } catch (e) {
      console.error("Push failed to", t, e?.message || e);
    }
  }
}

// ===== cron schedules (Asia/Bangkok) =====
cron.schedule(
  "0 8 * * *",
  async () => {
    await pushToAllTargets("✅ ร้านเปิดแล้ว (08:00)");
  },
  { timezone: "Asia/Bangkok" }
);

cron.schedule(
  "0 22 * * *",
  async () => {
    await pushToAllTargets("🌙 ร้านปิดแล้ว (22:00) test");
  },
  { timezone: "Asia/Bangkok" }
);

///ยิงเทสข้อความ
app.get("/test-push", async (req, res) => {
  await pushToAllTargets("🧪 TEST: บอทส่งข้อความเข้ากลุ่มสำเร็จแล้ว");
  res.send("OK");
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
