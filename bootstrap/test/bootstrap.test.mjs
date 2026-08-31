// Exercises bootstrap.mjs against a local asset server: download, checksum
// verification, caching, the binary override, and the failure messages. Uses no
// test framework so it runs anywhere Node does.
//
//   node bootstrap/test/bootstrap.test.mjs

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const bootstrapSource = resolve(testDir, "..", "bootstrap.mjs");
const workspace = mkdtempSync(join(tmpdir(), "bootstrap-test-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n`);
  if (!ok) {
    process.stdout.write(`      ${detail}\n`);
    failures += 1;
  }
};

// A plugin tree shaped like the ones this bootstrap is vendored into.
const pluginRoot = join(workspace, "plugin");
mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
writeFileSync(
  join(pluginRoot, ".codex-plugin", "plugin.json"),
  JSON.stringify({ name: "ssh-mcp" }),
);
cpSync(bootstrapSource, join(pluginRoot, "scripts", "bootstrap.mjs"));

// The Node binary stands in for a server binary: a real executable of the host
// platform that can be told which exit code to return.
const serverBinary = process.execPath;
const assetName = `ssh-mcp-test${process.platform === "win32" ? ".exe" : ""}`;
const assetPath = join(workspace, "asset.bin");
const payload = readFileSync(serverBinary);
writeFileSync(assetPath, payload);
const digest = createHash("sha256").update(payload).digest("hex");
const platform = `${process.platform}-${process.arch}`;

const portFile = join(workspace, "port");
const hitsFile = join(workspace, "hits");
const server = spawn(
  process.execPath,
  [join(testDir, "asset-server.mjs"), assetName, assetPath, portFile, hitsFile],
  { stdio: "inherit" },
);

let base = "";
for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
  try {
    base = `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}`;
  } catch {
    await sleep(50);
  }
}
if (!base) throw new Error("the asset server never reported a port");
const hits = () => Number(readFileSync(hitsFile, "utf8"));

const manifestFor = (assets) => ({ tag: "binaries-test", plugins: { "ssh-mcp": { assets } } });

// Seeding the manifest cache keeps the test off the GitHub API; the download
// itself still goes over HTTP to the local server.
const newCache = (name, manifest) => {
  const root = join(workspace, name);
  mkdirSync(join(root, "bin"), { recursive: true });
  if (manifest) {
    writeFileSync(join(root, "bin", "manifest-latest.json"), JSON.stringify(manifest));
  }
  return root;
};

const run = (cacheRoot, args, extraEnv = {}) =>
  spawnSync(process.execPath, [join(pluginRoot, "scripts", "bootstrap.mjs"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      MCP_PLUGIN_DATA: cacheRoot,
      NET_TOOL_PLUGINS_DOWNLOAD_BASE: base,
      SSH_MCP_BINARY: "",
      ...extraEnv,
    },
  });

const good = newCache("cache-good", manifestFor({ [platform]: { name: assetName, sha256: digest } }));

const first = run(good, ["-e", "process.exit(3)"]);
check(
  "downloads, verifies and execs, forwarding the exit code",
  first.status === 3,
  `status=${first.status} stderr=${first.stderr}`,
);
check("downloaded exactly once", hits() === 1, `hits=${hits()}`);

const second = run(good, ["-e", "process.exit(4)"]);
check(
  "a second start reuses the cached binary",
  second.status === 4 && hits() === 1,
  `status=${second.status} hits=${hits()} stderr=${second.stderr}`,
);

const tampered = newCache(
  "cache-tampered",
  manifestFor({ [platform]: { name: assetName, sha256: "0".repeat(64) } }),
);
const rejected = run(tampered, ["-e", "process.exit(0)"]);
check(
  "refuses a download whose digest does not match the manifest",
  rejected.status === 1 && /checksum mismatch/.test(rejected.stderr),
  `status=${rejected.status} stderr=${rejected.stderr}`,
);

const unbuilt = newCache(
  "cache-unbuilt",
  manifestFor({ "aix-ppc64": { name: "elsewhere", sha256: digest } }),
);
const missing = run(unbuilt, []);
check(
  "reports an unbuilt platform and names the override variable",
  missing.status === 1 &&
    /no ssh-mcp binary for/.test(missing.stderr) &&
    /SSH_MCP_BINARY/.test(missing.stderr),
  `status=${missing.status} stderr=${missing.stderr}`,
);

const overridden = run(newCache("cache-override"), ["-e", "process.exit(7)"], {
  SSH_MCP_BINARY: serverBinary,
});
check(
  "the per-plugin override runs the given binary without touching the network",
  overridden.status === 7,
  `status=${overridden.status} stderr=${overridden.stderr}`,
);

// A cache entry that is not what the manifest says must never be executed,
// however plausible its path looks: the digest in the path is only a label.
const poisoned = newCache(
  "cache-poisoned",
  manifestFor({ [platform]: { name: assetName, sha256: digest } }),
);
const poisonedDir = join(poisoned, "bin", digest.slice(0, 12));
mkdirSync(poisonedDir, { recursive: true });
writeFileSync(join(poisonedDir, assetName), "not the binary you are looking for");
const hitsBeforePoison = hits();
const repaired = poisoned && run(poisoned, ["-e", "process.exit(9)"]);
check(
  "replaces a cache entry whose contents do not match the manifest digest",
  repaired.status === 9 && hits() === hitsBeforePoison + 1,
  `status=${repaired.status} hits=${hits()} (was ${hitsBeforePoison}) stderr=${repaired.stderr}`,
);

// Two cold starts at once both have to succeed: they race to publish the same
// cache path, and on Windows the loser's rename can fail outright.
const contended = newCache(
  "cache-contended",
  manifestFor({ [platform]: { name: assetName, sha256: digest } }),
);
const racers = await Promise.all(
  [11, 12, 13].map(
    (code) =>
      new Promise((done) => {
        const child = spawn(
          process.execPath,
          [join(pluginRoot, "scripts", "bootstrap.mjs"), "-e", `process.exit(${code})`],
          {
            stdio: ["ignore", "ignore", "pipe"],
            env: {
              ...process.env,
              MCP_PLUGIN_DATA: contended,
              NET_TOOL_PLUGINS_DOWNLOAD_BASE: base,
              SSH_MCP_BINARY: "",
            },
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (status) => done({ code, status, stderr }));
      }),
  ),
);
check(
  "concurrent cold starts all succeed instead of racing on the cache path",
  racers.every((r) => r.status === r.code),
  racers.map((r) => `want ${r.code} got ${r.status} ${r.stderr.trim()}`).join(" | "),
);

const unresolvable = run(newCache("cache-offline"), [], {
  NET_TOOL_PLUGINS_REPO: "example-invalid/does-not-exist",
  NET_TOOL_PLUGINS_RELEASE: "no-such-tag",
});
check(
  "fails with status 1 and a readable message when the release cannot be resolved",
  unresolvable.status === 1 && /could not resolve the release/.test(unresolvable.stderr),
  `status=${unresolvable.status} stderr=${unresolvable.stderr}`,
);

server.kill();
rmSync(workspace, { recursive: true, force: true });
process.stdout.write(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exitCode = failures === 0 ? 0 : 1;
