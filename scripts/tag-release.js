import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

async function main() {
  const pkgRaw = await fs.readFile(join(ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  const version = pkg.version || "0.0.0";
  const tag = `v${version}`;

  const customMessage = process.argv.slice(2).join(" ").trim();
  const message = customMessage || `release ${tag}`;

  execSync(`git tag -a ${tag} -m "${message.replace(/"/g, '\\"')}"`, {
    cwd: ROOT,
    stdio: "inherit",
  });

  console.log(`Created tag ${tag}`);
  console.log(`To publish it: git push origin ${tag}`);
}

main().catch((error) => {
  console.error("Tag creation failed:", error.message);
  process.exit(1);
});
