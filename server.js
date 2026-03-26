require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const DB_NAME = "trackingdb";
const PORT = process.env.PORT || 3000;

let db;
let users;

// ---------- HELPERS ----------

function normalizeTdPhone(phone) {
  const p = String(phone || "").trim().replace(/\s+/g, "");
  if (p.startsWith("+235")) return p;
  if (p.startsWith("235")) return `+${p}`;
  return `+235${p}`;
}

function buildReceiptMatch(wh, receiptStr) {
  const receiptNum = Number.isFinite(Number(receiptStr)) ? Number(receiptStr) : null;
  return {
    wh,
    $or: [
      { "clients.receipt": receiptStr },
      ...(receiptNum !== null ? [{ "clients.receipt": receiptNum }] : []),
    ],
  };
}

async function sendOtpWithBeem(phone, code) {
  const cleanPhone = normalizeTdPhone(phone);

  await axios.post(
    "https://apisms.beem.africa/v1/send",
    {
      source_addr: "SOBIEXPRESS",
      schedule_time: "",
      encoding: 0,
      message: `Votre code OTP est ${code}`,
      recipients: [
        {
          recipient_id: 1,
          dest_addr: cleanPhone.replace("+", ""),
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`
          ).toString("base64"),
      },
    }
  );

  return cleanPhone;
}

// ---------- ROUTES ----------

// TEST
app.get("/health", (_, res) => res.send("OK"));

// REGISTER (CLIENT)
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, phone, password } = req.body;
    if (!fullName || !phone || !password) {
      return res.status(400).send("Missing fields");
    }

    const cleanPhone = normalizeTdPhone(phone);
    const hash = await bcrypt.hash(password, 10);

    await users.insertOne({
      fullName,
      phone: cleanPhone,
      passwordHash: hash,
      role: "CLIENT",
      createdAt: new Date(),
    });

    res.status(201).json({ message: "User created" });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).send("Phone already registered");
    console.log(e);
    res.status(500).send("Server error");
  }
});

// SET PASSWORD (TEMP)
app.post("/api/admin/set-password", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");

    const hash = await bcrypt.hash(password, 10);

    await users.updateOne({ username }, { $set: { passwordHash: hash } });

    res.json({ message: "Password set" });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// LOGIN (phone OR username)
app.post("/api/auth/login", async (req, res) => {
  try {
    const { phone, username, password } = req.body;
    if ((!phone && !username) || !password) {
      return res.status(400).send("Missing fields");
    }

    const cleanPhone = phone ? normalizeTdPhone(phone) : null;
    const user = await users.findOne(username ? { username } : { phone: cleanPhone });

    if (!user) return res.status(404).send("Phone not registered");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).send("Bad credentials");

    const token = jwt.sign(
      { uid: user._id.toString(), role: user.role },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, role: user.role });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// SEND OTP
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).send("Phone required");

    const cleanPhone = normalizeTdPhone(phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await db.collection("otp_codes").insertOne({
      phone: cleanPhone,
      code,
      createdAt: new Date(),
    });

    await sendOtpWithBeem(cleanPhone, code);

    res.json({ ok: true });
  } catch (e) {
    console.log(e?.response?.data || e);
    res.status(500).send("SMS error");
  }
});

// VERIFY OTP
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const phone = normalizeTdPhone(req.body.phone || "");
    const code = String(req.body.code || "").trim();

    if (!phone || !code) {
      return res.status(400).send("Phone and code required");
    }

    const rows = await db
      .collection("otp_codes")
      .find({ phone, code })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();

    if (!rows || rows.length === 0) {
      return res.status(400).send("Invalid code");
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).send("OTP verify error");
  }
});

// GET CONTAINER
app.get("/api/containers/:wh", async (req, res) => {
  try {
    const wh = String(req.params.wh || "").toUpperCase();
    const container = await db.collection("containers").findOne({ wh });
    if (!container) return res.status(404).send("Container not found");
    res.json(container);
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// SUMMARY
app.get("/api/containers/:wh/summary", async (req, res) => {
  try {
    const wh = String(req.params.wh || "").toUpperCase();
    const doc = await db.collection("containers").findOne({ wh });
    if (!doc) return res.status(404).send("Container not found");

    const totalClients = doc.clients?.length || 0;
    const paidCount = (doc.clients || []).filter((c) => c.paid).length;
    const pickedCount = (doc.clients || []).filter((c) => c.picked).length;
    const notPickedCount = totalClients - pickedCount;
    const paidNotPicked = (doc.clients || []).filter((c) => c.paid && !c.picked).length;
    const pickedNotPaid = (doc.clients || []).filter((c) => c.picked && !c.paid).length;

    res.json({
      wh: doc.wh,
      container: doc.container,
      plDate: doc.plDate,
      totalClients,
      totalPackages: doc.totalPackages,
      totalCBM: doc.totalCBM,
      paidCount,
      pickedCount,
      notPickedCount,
      paidNotPicked,
      pickedNotPaid,
    });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// PAY
app.patch("/api/containers/:wh/clients/:receipt/pay", async (req, res) => {
  try {
    const wh = String(req.params.wh || "").toUpperCase();
    const receiptStr = String(req.params.receipt || "").trim();
    const { paidBy } = req.body;

    const match = buildReceiptMatch(wh, receiptStr);

    const result = await db.collection("containers").updateOne(match, {
      $set: {
        "clients.$.paid": true,
        "clients.$.paidAt": new Date(),
        "clients.$.paidBy": paidBy || null,
      },
    });

    if (result.matchedCount === 0) return res.status(404).send("Client not found");
    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// PICK
app.patch("/api/containers/:wh/clients/:receipt/pick", async (req, res) => {
  try {
    const wh = String(req.params.wh || "").toUpperCase();
    const receiptStr = String(req.params.receipt || "").trim();
    const { pickedBy, reason } = req.body;

    const match = buildReceiptMatch(wh, receiptStr);

    const doc = await db.collection("containers").findOne(match, {
      projection: { "clients.$": 1 },
    });

    if (!doc || !doc.clients || !doc.clients[0]) {
      return res.status(404).send("Client not found");
    }

    const paid = !!doc.clients[0].paid;

    if (!paid && (!reason || String(reason).trim() === "")) {
      return res.status(400).send("Reason required");
    }

    const update = {
      "clients.$.picked": true,
      "clients.$.pickedAt": new Date(),
      "clients.$.pickedBy": pickedBy || null,
    };

    if (!paid) update["clients.$.reasonNoPayment"] = String(reason).trim();

    const result = await db.collection("containers").updateOne(match, { $set: update });

    if (result.matchedCount === 0) return res.status(404).send("Client not found");

    res.json({ ok: true, paid });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// PHOTOS
app.patch("/api/containers/:wh/clients/:receipt/photos", async (req, res) => {
  try {
    const wh = String(req.params.wh || "").toUpperCase();
    const receiptStr = String(req.params.receipt || "").trim();
    const { receptionUrl, receiptUrl, pickupUrl } = req.body;

    const receiptNum = Number.isFinite(Number(receiptStr)) ? Number(receiptStr) : null;

    const match = {
      wh,
      $or: [
        { "clients.receipt": receiptStr },
        ...(receiptNum !== null ? [{ "clients.receipt": receiptNum }] : []),
      ],
    };

    const update = {};

    if (receptionUrl !== undefined) update["clients.$.receptionUrl"] = receptionUrl;
    if (receiptUrl !== undefined) update["clients.$.receiptUrl"] = receiptUrl;
    if (pickupUrl !== undefined) update["clients.$.pickupUrl"] = pickupUrl;

    const result = await db.collection("containers").updateOne(match, { $set: update });

    if (result.matchedCount === 0) {
      return res.status(404).send("Client not found");
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});

// ---------- START ----------
async function main() {
  if (!MONGODB_URI) {
    console.log("❌ Missing MONGODB_URI in .env");
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  db = client.db(DB_NAME);
  users = db.collection("users");

  console.log("✅ Connected to MongoDB");

  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

main().catch((e) => {
  console.log("❌ Mongo connect error:", e);
  process.exit(1);
});
