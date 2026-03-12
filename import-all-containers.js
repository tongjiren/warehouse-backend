const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const targetDir = process.argv[2];

if (!targetDir) {
  console.log("Usage: node import-all-containers.js <folder>");
  process.exit(1);
}

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of list) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else {
      const lower = item.name.toLowerCase();
      if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

const files = walk(targetDir);

if (files.length === 0) {
  console.log("No Excel files found.");
  process.exit(0);
}

console.log(`Found ${files.length} Excel file(s).\n`);

for (const file of files) {
  try {
    console.log(`\n=== Importing: ${file}`);
    execFileSync("node", ["import-container-excel.js", file], {
      stdio: "inherit",
      cwd: __dirname,
    });
  } catch (e) {
    console.log(`\n❌ Failed: ${file}`);
  }
}

console.log("\n✅ Batch import finished.");