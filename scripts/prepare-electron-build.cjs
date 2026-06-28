const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const standaloneDir = path.join(root, ".next", "standalone");

if (!fs.existsSync(standaloneDir)) {
  throw new Error("Missing .next/standalone. Run `npm run build` first.");
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

copyIfExists(
  path.join(root, ".next", "static"),
  path.join(standaloneDir, ".next", "static"),
);
copyIfExists(path.join(root, "public"), path.join(standaloneDir, "public"));

console.log("Prepared Next standalone output for Electron packaging.");
