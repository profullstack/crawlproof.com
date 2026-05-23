import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import https from "node:https";

const licenseKey = process.env.MAXMIND_LICENSE_KEY;
const outputPath =
  process.env.MAXMIND_GEOLITE2_CITY_DB_PATH ??
  process.env.GEOLITE2_CITY_DB_PATH ??
  "data/GeoLite2-City.mmdb";

if (!licenseKey) {
  throw new Error("MAXMIND_LICENSE_KEY is required");
}

const url = new URL("https://download.maxmind.com/app/geoip_download");
url.searchParams.set("edition_id", "GeoLite2-City");
url.searchParams.set("license_key", licenseKey);
url.searchParams.set("suffix", "tar.gz");

const tempDir = await mkdtemp(path.join(tmpdir(), "geolite2-"));
const archivePath = path.join(tempDir, "GeoLite2-City.tar.gz");

try {
  await download(url, archivePath);
  await run("tar", ["-xzf", archivePath, "-C", tempDir]);
  const dbPath = await findDb(tempDir);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rename(dbPath, outputPath);
  console.log(`Downloaded GeoLite2 City database to ${outputPath}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        download(new URL(response.headers.location), destination)
          .then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`MaxMind download failed: HTTP ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function findDb(dir) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "GeoLite2-City.mmdb") {
      return fullPath;
    }
    if (entry.isDirectory()) {
      try {
        return await findDb(fullPath);
      } catch {
        // Keep searching siblings.
      }
    }
  }
  throw new Error("GeoLite2-City.mmdb not found in archive");
}
