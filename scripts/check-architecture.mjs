import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const scanRoots = ["app", "apps", "lib", "packages", "scripts"];
const errors = [];

function normalized(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function walk(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next") return [];
    return walk(resolve(path, entry.name));
  });
}

function layerFor(path) {
  const file = normalized(path);
  if (file.startsWith("packages/contracts/")) return "contracts";
  if (file.startsWith("packages/application/")) return "application";
  if (file.startsWith("packages/infrastructure/")) return "infrastructure";
  if (file.startsWith("apps/web/")) return "web";
  if (file.startsWith("app/api/")) return "api";
  if (file.startsWith("app/")) return "route-ui";
  if (file.startsWith("lib/")) return "legacy-core";
  if (file.startsWith("scripts/")) return "script";
  return "unknown";
}

function importTarget(file, specifier) {
  if (specifier.startsWith("@repo/contracts")) return resolve(repositoryRoot, "packages/contracts");
  if (specifier.startsWith("@repo/application")) return resolve(repositoryRoot, "packages/application");
  if (specifier.startsWith("@repo/infrastructure")) return resolve(repositoryRoot, "packages/infrastructure");
  if (specifier.startsWith("@web/")) return resolve(repositoryRoot, "apps/web", specifier.slice(5));
  if (specifier.startsWith("@/")) return resolve(repositoryRoot, specifier.slice(2));
  if (specifier.startsWith(".")) return resolve(dirname(file), specifier);
  return null;
}

function extractImports(content) {
  const imports = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) imports.push(match[1]);
  }
  return [...new Set(imports)];
}

function report(file, message) {
  errors.push(`${normalized(file)}: ${message}`);
}

function checkImportBoundary(file, specifier) {
  const sourceLayer = layerFor(file);
  const target = importTarget(file, specifier);
  const targetLayer = target ? layerFor(target) : "external";

  const forbiddenTargets = {
    contracts: new Set(["application", "infrastructure", "web", "api", "route-ui", "legacy-core", "script"]),
    application: new Set(["infrastructure", "web", "api", "route-ui"]),
    infrastructure: new Set(["web", "api", "route-ui"]),
    web: new Set(["application", "infrastructure", "api"]),
    api: new Set(["web"]),
    "legacy-core": new Set(["web", "api", "route-ui"]),
    script: new Set(["web", "api", "route-ui"]),
  };

  if (forbiddenTargets[sourceLayer]?.has(targetLayer)) {
    report(file, `${sourceLayer} cannot import ${targetLayer}: ${specifier}`);
  }

  const bannedExternal = {
    contracts: ["react", "next", "@supabase/", "node:"],
    application: ["react", "next"],
    infrastructure: ["react", "next"],
  };
  if (bannedExternal[sourceLayer]?.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
    report(file, `${sourceLayer} cannot import framework/infrastructure package: ${specifier}`);
  }

  const applicationImplementationImports = [
    "@/lib/platform/supabase",
    "@/lib/agent/memory/session-store",
    "@/lib/llm/config-service",
    "@/lib/memory-config/service",
    "@/lib/user-profile/service",
    "@/lib/agent/runtime/trace-store",
    "@/lib/langfuse/client",
    "@/lib/agent/context/snapshot-store",
  ];
  if (sourceLayer === "application" && applicationImplementationImports.includes(specifier)) {
    report(file, `application must use a port instead of implementation: ${specifier}`);
  }
}

for (const root of scanRoots) {
  const absoluteRoot = resolve(repositoryRoot, root);
  for (const file of walk(absoluteRoot)) {
    if (!sourceExtensions.has(extname(file))) continue;
    const content = readFileSync(file, "utf8");
    for (const specifier of extractImports(content)) checkImportBoundary(file, specifier);
    if (layerFor(file) === "contracts" && /\bprocess\.env\b/.test(content)) {
      report(file, "contracts cannot read process.env");
    }
  }
}

const removedFrontendDirectories = [
  "app/_components",
  "app/_hooks",
];
for (const directory of removedFrontendDirectories) {
  const path = resolve(repositoryRoot, directory);
  try {
    const sourceFiles = walk(path).filter((file) => sourceExtensions.has(extname(file)));
    if (sourceFiles.length > 0) report(path, "frontend source must live under apps/web");
  } catch {
    // A missing legacy directory is the expected state.
  }
}

const chatRoute = resolve(repositoryRoot, "app/api/chat/route.ts");
const chatRouteLines = readFileSync(chatRoute, "utf8").split(/\r?\n/).length;
if (chatRouteLines > 100) report(chatRoute, `route adapter is too large (${chatRouteLines} lines, max 100)`);

if (errors.length > 0) {
  console.error("Architecture check failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Architecture check passed.");
