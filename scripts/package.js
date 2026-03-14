/**
 * Package script for Study Assist Chrome Extension
 * Creates a distribution-ready folder and optionally a .zip file
 *
 * Usage:
 *   node scripts/package.js          # Creates dist/ folder
 *   node scripts/package.js --zip    # Creates dist/ folder and dist.zip
 */

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

const pkgRaw = await fs.readFile(join(ROOT, "package.json"), "utf8");
const pkg = JSON.parse(pkgRaw);
const version = pkg.version || "0.0.0";
const zipFileName = `study-assist-v${version}.zip`;

const createZip = process.argv.includes("--zip");

// Files/folders to include in distribution
const INCLUDE_ITEMS = [
  "manifest.json",
  "background",
  "content",
  "popup",
  "icons",
  "data",
  "_locales",
];

// Files to exclude within included folders
const EXCLUDE_PATTERNS = [
  /\.ts$/, // TypeScript files
  /\.map$/, // Source maps
  /\.DS_Store$/, // macOS metadata
  /Thumbs\.db$/, // Windows metadata
  /desktop\.ini$/, // Windows metadata
];

/**
 * Copy a file or directory recursively
 */
async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);

  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);

    for (const entry of entries) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);

      // Skip excluded patterns
      if (EXCLUDE_PATTERNS.some((pattern) => pattern.test(entry))) {
        continue;
      }

      await copyRecursive(srcPath, destPath);
    }
  } else {
    // Skip excluded patterns
    const filename = src.split(/[/\\]/).pop();
    if (EXCLUDE_PATTERNS.some((pattern) => pattern.test(filename))) {
      return;
    }

    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

/**
 * Create a .zip file from dist folder
 * Tries multiple methods: tar (Win10+), zip (unix), PowerShell fallback
 */
async function createZipFile() {
  console.log("\nCreating ZIP file...");

  const zipPath = join(ROOT, zipFileName);
  const isWindows = process.platform === "win32";

  const escapeForPowerShell = (value) => value.replace(/'/g, "''");
  const escapedDist = escapeForPowerShell(DIST);
  const escapedZip = escapeForPowerShell(zipPath);

  // Remove old zip if exists
  try {
    await fs.unlink(zipPath);
  } catch {
    /* no-op */
  }

  const methods = [
    {
      name: "PowerShell",
      cmd: `powershell -NoProfile -Command "Import-Module Microsoft.PowerShell.Archive -ErrorAction Stop; Compress-Archive -LiteralPath '${escapedDist}' -DestinationPath '${escapedZip}' -Force"`,
      options: { stdio: "pipe" },
      enabled: isWindows,
    },
    {
      name: "tar",
      cmd: `tar -a -cf "${zipPath}" -C "${ROOT}" dist`,
      options: { stdio: "pipe" },
      enabled: true,
    },
    {
      name: "zip",
      cmd: `zip -r "${zipPath}" dist`,
      options: { cwd: ROOT, stdio: "pipe" },
      enabled: true,
    },
  ];

  for (const method of methods) {
    if (!method.enabled) {
      continue;
    }

    try {
      execSync(method.cmd, method.options);
      console.log(`Created: ${zipFileName} (using ${method.name})`);
      return;
    } catch {
      // Try next method
    }
  }

  console.error("Failed to create ZIP file (no compression tool available).");
  console.log("\nYou can manually compress the 'dist' folder:");
  console.log(
    "   - Right-click the 'dist' folder → 'Send to' → 'Compressed (zipped) folder'",
  );
}

/**
 * Main packaging function
 */
async function packageExtension() {
  console.log("Packaging Study Assist Extension\n");

  // Step 1: Clean dist folder
  console.log("Cleaning dist folder...");
  try {
    await fs.rm(DIST, { recursive: true, force: true });
  } catch (error) {
    // Folder might not exist
  }
  await fs.mkdir(DIST, { recursive: true });

  // Step 2: Build the extension
  console.log("Building extension...");
  try {
    execSync("node scripts/build.js", { cwd: ROOT, stdio: "inherit" });
  } catch (error) {
    console.error("Build failed!");
    process.exit(1);
  }

  // Step 3: Copy distribution files
  console.log("\nCopying files to dist/...");
  for (const item of INCLUDE_ITEMS) {
    const srcPath = join(ROOT, item);
    const destPath = join(DIST, item);

    try {
      await fs.access(srcPath);
      await copyRecursive(srcPath, destPath);
      console.log(`   OK ${item}`);
    } catch (error) {
      console.log(`   WARN ${item} (not found, skipping)`);
    }
  }

  // Step 4: Create installation instructions
  const instructions = `# Study Assist — Installation Instructions

## Prerequisites
- A Chromium-based browser (Chrome, Edge, Brave, Vivaldi, etc.)
- An API key from Claude (Anthropic) and/or DeepSeek

## Installation Steps

### 1. Extract the Extension
If you received a ZIP file, extract it to a permanent location on your computer.
**Important:** Do not delete this folder after installation — the browser needs it.

### 2. Open Extension Settings
- **Chrome:** Navigate to \`chrome://extensions/\`
- **Edge:** Navigate to \`edge://extensions/\`
- **Brave:** Navigate to \`brave://extensions/\`

### 3. Enable Developer Mode
Toggle the "Developer mode" switch in the top-right corner.

### 4. Load the Extension
1. Click **"Load unpacked"**
2. Navigate to and select the **extracted folder** (the one containing manifest.json)
3. The extension should now appear in your extensions list

### 5. Pin the Extension (Optional)
- Click the puzzle piece icon in your browser toolbar
- Find "Study Assist" and click the pin icon

## Configuration

### First-Time Setup
1. Click the Study Assist icon in your toolbar
2. Enter your **Claude API Key** (get one from https://console.anthropic.com/)
3. Enter your **DeepSeek API Key** (optional, from https://platform.deepseek.com/)
4. Click "Save" — keys will be validated automatically
5. Add domains where you want the extension to work (Allowed Domains section)
6. Toggle the extension **ON**

### Settings
- **Response Mode:** Guided Learning, Direct Explanation, or Hints Only
- **Auto-detect:** Automatically detect questions on page load
- **Quick Mode:** Streamlined single-keypress analysis
- **DeepSeek:** Enable hybrid AI mode (cost-effective reasoning model)
- **Allowed Domains:** Add the websites where you want Study Assist to work

## Usage

### Getting Started
1. Add the domain of your study website to the Allowed Domains list
2. Navigate to a page with questions on that domain
3. The extension will detect questions when activated
4. Click the **SA** button or press **SHIFT** to analyze
5. View the AI explanation in the overlay

### Keyboard Shortcuts
- **SHIFT:** Analyze current question
- **CTRL + SHIFT:** Force Claude-only analysis (skip DeepSeek)
- **ALT + W:** Reload question detection
- **ALT + Q:** Toggle SA button visibility
- **ALT + X:** Cancel current request
- **CTRL (hold):** Toggle answer overlay visibility

## Troubleshooting

### Extension not detecting questions?
- Make sure the current domain is in your Allowed Domains list
- Check that the extension is **enabled** (toggle in popup)
- Try refreshing the page

### API Key errors?
- Verify your API key is correct
- Check that you have credits in your account
- Claude: https://console.anthropic.com/
- DeepSeek: https://platform.deepseek.com/

### Extension disappeared after restart?
- Make sure the extension folder is not deleted or moved
- Re-load the extension if needed (chrome://extensions/)

## Privacy & Security
- API keys stored locally (never shared externally)
- No data collection or telemetry
- Questions are sent to AI APIs only when you activate analysis
- Full privacy policy: see PRIVACY.md

## Dashboard
Click the extension icon then "Dashboard" to view:
- Usage statistics and API costs
- Request history
- System health status
`;

  await fs.writeFile(join(DIST, "INSTALLATION.md"), instructions);
  console.log("   OK INSTALLATION.md");

  // Step 5: Create ZIP if requested
  if (createZip) {
    await createZipFile();
  }

  // Step 6: Summary
  console.log("\nPackage complete!");
  console.log(`\nDistribution folder: dist/`);

  const folderSize = await getFolderSize(DIST);
  console.log(`Size: ${folderSize}`);

  if (createZip) {
    console.log(`ZIP file: ${zipFileName}`);
  }

  console.log("\nTo share with others:");
  console.log("   1. Compress the 'dist' folder into a ZIP file (if not done)");
  console.log("   2. Share the ZIP file");
  console.log("   3. Recipients should extract and follow INSTALLATION.md");
}

/**
 * Calculate folder size recursively (returns raw bytes)
 */
async function calculateFolderSize(dir) {
  let size = 0;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        size += await calculateFolderSize(path);
      } else {
        const stat = await fs.stat(path);
        size += stat.size;
      }
    }
  } catch (error) {
    // Skip inaccessible directories
  }

  return size;
}

/**
 * Format size in bytes to human-readable string
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Get folder size formatted
 */
async function getFolderSize(dir) {
  const bytes = await calculateFolderSize(dir);
  return formatSize(bytes);
}

// Run packaging
packageExtension().catch((error) => {
  console.error("Packaging failed:", error);
  process.exit(1);
});
