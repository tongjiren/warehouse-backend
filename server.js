require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const DB_NAME = "trackingdb";
const PORT = process.env.PORT || 3000;
const twilio = require("twilio");

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);



let db;
let users;

// ---------- ROUTES ----------

// TEST
app.get("/health", (_, res) => res.send("OK"));

// REGISTER (CLIENT)
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, phone, password } = req.body;
    if (!fullName || !phone || !password) return res.status(400).send("Missing fields");

    const hash = await bcrypt.hash(password, 10);

    await users.insertOne({
      fullName,
      phone,
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
    if ((!phone && !username) || !password) return res.status(400).send("Missing fields");

    const user = await users.findOne(username ? { username } : { phone });
    if (!user) return res.status(404).send("Phone not registered");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).send("Bad credentials");

    const token = jwt.sign({ uid: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, role: user.role });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
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

// helper: receipt match string OR number
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

// PAY (works even if already picked)
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

// PICK (requires reason if not paid)
app.patch("/api/containers/:wh/clients/:receipt/pick", async (req, res) => {
  try {
    const wh = String(req.params.wh || "").toUpperCase();
    const receiptStr = String(req.params.receipt || "").trim();
    const { pickedBy, reason } = req.body;

    const match = buildReceiptMatch(wh, receiptStr);

    // read targeted client to check paid
    const doc = await db.collection("containers").findOne(match, { projection: { "clients.$": 1 } });
    if (!doc || !doc.clients || !doc.clients[0]) return res.status(404).send("Client not found");

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

// SEND OTP SMS
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).send("Phone required");

    // générer code 6 chiffres
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // enregistrer dans MongoDB
    await db.collection("otp_codes").insertOne({
      phone,
      code,
      createdAt: new Date()
    });

    // envoyer SMS
    await twilioClient.messages.create({
      body: `Votre code de verification SobiExpress: ${code}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+235${phone}`
    });

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).send("SMS error");
  }
});


// ---------- START SERVER AFTER DB CONNECT ----------
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

    const result = await db.collection("containers").updateOne(
      match,
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send("Client not found");
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).send("Server error");
  }
});
