require("dotenv").config();
const path = require("path");
const xlsx = require("xlsx");
const { MongoClient } = require("mongodb");

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isNumber(v) {
  return typeof v === "number" && !Number.isNaN(v);
}

function extractPhone(shippingMarks) {
  const s = toStr(shippingMarks);
  // cherche 8 ou 9 chiffres (ex: 66943434)
  const m = s.match(/\b\d{8,9}\b/g);
  return m ? m[m.length - 1] : null;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log("Usage: node import-container-excel.js <file.xlsx>");
    process.exit(1);
  }

  const baseName = path.basename(filePath);
  const whMatch = baseName.match(/WH-\d+/i);
  const contMatch = baseName.match(/[A-Z]{4}\d{7}/); // ex: MRSU7645456
  const dateMatch = baseName.match(/\d{4}\.\d{2}\.\d{2}/); // ex: 2025.12.13

  const wh = whMatch ? whMatch[0].toUpperCase() : "WH-UNKNOWN";
  const container = contMatch ? contMatch[0] : null;
  const plDate = dateMatch ? dateMatch[0] : null;

  const wb = xlsx.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // tableau brut (rows/cols)
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });

  // On prend les lignes où la colonne A (NO.) est un numéro
  const clients = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const no = row?.[0];

    if (!isNumber(no)) continue;

    const pkgs = row?.[3];
    const cbm = row?.[4];
    const shippingMarks = row?.[6];
    const receipt = row?.[7];

    clients.push({
      receipt: toStr(receipt),                 // ex "0454", "3043", "2922(KY...)"
      clientName: toStr(shippingMarks),        // texte libre
      phone: extractPhone(shippingMarks),      // si détecté
      packages: isNumber(pkgs) ? pkgs : Number(pkgs) || 0,
      cbm: isNumber(cbm) ? cbm : Number(cbm) || 0,

      paid: false,
      paidAt: null,
      paidBy: null,
      receiptUrl: null,

      picked: false,
      pickedAt: null,
      pickedBy: null,
      pickupUrl: null
    });
  }

  const totalPackages = clients.reduce((s, c) => s + (c.packages || 0), 0);
  const totalCBM = Math.round(clients.reduce((s, c) => s + (c.cbm || 0), 0) * 100) / 100;

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "trackingdb");
  const containers = db.collection("containers");

  await containers.updateOne(
    { wh },
    {
      $set: {
        wh,
        container,
        plDate,
        totalPackages,
        totalCBM,
        clients,
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  console.log("✅ Imported:", { wh, container, plDate, totalClients: clients.length, totalPackages, totalCBM });
  await client.close();
}

main().catch((e) => {
  console.error("❌ Import error:", e);
  process.exit(1);
});