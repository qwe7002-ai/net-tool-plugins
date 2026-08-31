#!/usr/bin/env node
// Downloads and runs this plugin's prebuilt MCP server binary.
//
// Vendor this file into a plugin repository as `scripts/bootstrap.mjs` and point
// the plugin's .mcp.json at it; see bootstrap/README.md in
// https://github.com/qwe7002-ai/net-tool-plugins for the exact snippet. The file
// is identical in every plugin: it identifies itself by reading the sibling
// .codex-plugin/plugin.json, so there is nothing to edit when vendoring.
//
// Binaries come from the marketplace repository's releases, which are built by
// .github/workflows/build-binaries.yml. Everything on stdout belongs to the MCP
// stdio transport, so all diagnostics go to stderr.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES_REPO = process.env.NET_TOOL_PLUGINS_REPO ?? "qwe7002-ai/net-tool-plugins";
const MANIFEST_TTL_SECONDS = Number(process.env.NET_TOOL_PLUGINS_MANIFEST_TTL_SECONDS ?? 6 * 60 * 60);
const USER_AGENT = "net-tool-plugins-bootstrap";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");

function log(message) {
  process.stderr.write(`[bootstrap] ${message}\n`);
}

// Never process.exit() from async code: on Windows that aborts the process with
// a libuv assertion instead of returning the exit status. Unwind and let the
// event loop drain instead.
class BootstrapError extends Error {}

function fail(message) {
  throw new BootstrapError(message);
}

function pluginName() {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  let name;
  try {
    name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
  } catch (cause) {
    fail(`could not read the plugin name from ${manifestPath}: ${cause.message}`);
  }
  if (typeof name !== "string" || name.length === 0) {
    fail(`${manifestPath} has no "name"`);
  }
  return name;
}

function envVarFor(name) {
  return `${name.replaceAll("-", "_").toUpperCase()}_BINARY`;
}

function cacheDir() {
  // .mcp.json passes Codex's ${PLUGIN_DATA} through as MCP_PLUGIN_DATA; fall
  // back to a shared per-user cache when the plugin host provides no data dir.
  const base = process.env.MCP_PLUGIN_DATA ?? join(homedir(), ".cache", "net-tool-plugins");
  return join(base, "bin");
}

function authHeaders() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function fetchOrThrow(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, ...authHeaders(), ...headers },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
  }
  return response;
}

function readCachedManifest(path) {
  try {
    const age = (Date.now() - statSync(path).mtimeMs) / 1000;
    if (age > MANIFEST_TTL_SECONDS) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function loadManifest(root) {
  const pinned = (process.env.NET_TOOL_PLUGINS_RELEASE ?? "").trim();
  const cachePath = join(root, `manifest-${pinned || "latest"}.json`);

  // A pinned tag is immutable, so its manifest never expires; "latest" is
  // re-checked once per TTL so a normal server start does no network I/O.
  const cached = readCachedManifest(cachePath);
  if (cached && (pinned ? cached.tag === pinned : true)) return cached;

  const apiUrl = pinned
    ? `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/${encodeURIComponent(pinned)}`
    : `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

  let manifest;
  try {
    const release = await (
      await fetchOrThrow(apiUrl, { accept: "application/vnd.github+json" })
    ).json();
    const asset = (release.assets ?? []).find((a) => a.name === "manifest.json");
    if (!asset) {
      throw new Error(`release ${release.tag_name} has no manifest.json asset`);
    }
    manifest = await (await fetchOrThrow(asset.browser_download_url)).json();
  } catch (cause) {
    // Serve a stale manifest rather than failing to start when offline.
    const stale = (() => {
      try {
        return JSON.parse(readFileSync(cachePath, "utf8"));
      } catch {
        return null;
      }
    })();
    if (stale) {
      log(`could not refresh the release manifest (${cause.message}); using the cached one`);
      return stale;
    }
    fail(
      `could not resolve the ${pinned ? `release "${pinned}"` : "latest release"} ` +
        `of ${RELEASES_REPO}: ${cause.message}`,
    );
  }

  mkdirSync(root, { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(manifest)}\n`);
  return manifest;
}

// Streamed so a large binary is not read into memory just to be hashed.
function sha256File(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, "r");
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// The digest in the cache path is a label, not a proof: it says what the file
// was meant to be, never what it is. Anything about to be executed is hashed.
function isVerifiedCopy(path, expectedSha256) {
  try {
    if (statSync(path).size === 0) return false;
    return sha256File(path) === expectedSha256;
  } catch {
    return false;
  }
}

async function download(url, destination, expectedSha256) {
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    const response = await fetchOrThrow(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256) {
      throw new Error(`checksum mismatch: expected ${expectedSha256}, got ${actual}`);
    }
    writeFileSync(temporary, bytes);
    // Only this user needs to run it; the cache may sit in a shared location.
    chmodSync(temporary, 0o700);
    try {
      renameSync(temporary, destination);
    } catch (cause) {
      // Another process may have published the same digest first - on Windows
      // the replace fails outright while that copy is being executed. Accept
      // theirs if it is byte-for-byte what we were about to write.
      if (!isVerifiedCopy(destination, expectedSha256)) throw cause;
      rmSync(temporary, { force: true });
    }
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

function run(binary, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (cause) =>
      reject(new BootstrapError(`could not start ${binary}: ${cause.message}`)),
    );
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      process.exitCode = signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0);
      resolve();
    });
  });
}

async function main() {
  const name = pluginName();
  const argv = process.argv.slice(2);

  const override = process.env[envVarFor(name)];
  if (override) {
    log(`using ${envVarFor(name)}=${override}`);
    await run(override, argv);
    return;
  }

  const platform = `${process.platform}-${process.arch}`;
  const root = cacheDir();
  const manifest = await loadManifest(root);

  const plugin = manifest.plugins?.[name];
  if (!plugin) {
    fail(`release ${manifest.tag} publishes no binaries for plugin "${name}"`);
  }
  const asset = plugin.assets?.[platform];
  if (!asset) {
    fail(
      `no ${name} binary for ${platform} in release ${manifest.tag} ` +
        `(available: ${Object.keys(plugin.assets ?? {}).join(", ") || "none"}). ` +
        `Build one yourself and point ${envVarFor(name)} at it.`,
    );
  }

  // Keying the cache on the digest keeps different builds in different
  // directories; it does not make a hit trustworthy, so the file itself is
  // hashed below before anything is executed.
  const directory = join(root, asset.sha256.slice(0, 12));
  const binary = join(directory, asset.name);

  if (!isVerifiedCopy(binary, asset.sha256)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A cache entry that fails verification is junk - truncated, corrupted, or
    // planted. Drop it rather than let the download fail to replace it.
    try {
      rmSync(binary, { force: true });
    } catch {
      // Left in place (a running copy on Windows); the rename below decides.
    }
    // The base is overridable so a mirror or an air-gapped cache can serve the
    // same assets without repointing the manifest.
    const base =
      (process.env.NET_TOOL_PLUGINS_DOWNLOAD_BASE ?? "").trim().replace(/\/$/, "") ||
      `https://github.com/${RELEASES_REPO}/releases/download/${manifest.tag}`;
    const url = `${base}/${asset.name}`;
    log(`downloading ${name} ${platform} from ${manifest.tag}`);
    try {
      await download(url, binary, asset.sha256);
    } catch (cause) {
      fail(`could not download ${asset.name}: ${cause.message}`);
    }
  }

  await run(binary, argv);
}

try {
  await main();
} catch (cause) {
  process.stderr.write(`[bootstrap] error: ${cause.message}
`);
  process.exitCode = 1;
}
