// Folds the SHA256SUMS produced from the downloaded artifacts back into the
// plan's resolved-refs structure, producing dist/manifest.json — the single
// file bootstrap.mjs reads to learn which asset to fetch and what it should
// hash to. Also renders the human-readable release notes.

import { readFileSync, writeFileSync } from "node:fs";

const resolved = JSON.parse(process.env.RESOLVED ?? "{}");
const tag = process.env.RELEASE_TAG ?? "";

const digests = new Map();
for (const line of readFileSync("dist/SHA256SUMS", "utf8").split("\n")) {
  const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
  if (match) digests.set(match[2], match[1]);
}

for (const [plugin, info] of Object.entries(resolved)) {
  for (const [platform, asset] of Object.entries(info.assets)) {
    const sha256 = digests.get(asset.name);
    if (!sha256) {
      throw new Error(
        `no checksum for ${asset.name} (${plugin}/${platform}) — ` +
          `the build job for that platform did not upload an artifact`,
      );
    }
    asset.sha256 = sha256;
  }
}

const manifest = { tag, generated_at: new Date().toISOString(), plugins: resolved };
writeFileSync("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const notes = [
  "Prebuilt MCP server binaries for the plugins in this marketplace.",
  "",
  "Each plugin's bootstrap downloads the asset matching the host platform from",
  "this release and verifies it against `manifest.json`, so installing a plugin",
  "needs no Go or Bun toolchain.",
  "",
  "| Plugin | Upstream ref | Commit |",
  "| --- | --- | --- |",
  ...Object.entries(resolved).map(
    ([plugin, info]) =>
      `| \`${plugin}\` | \`${info.ref}\` | [\`${info.commit.slice(0, 12)}\`](https://github.com/${info.repo}/commit/${info.commit}) |`,
  ),
  "",
  "Verify a download with `sha256sum -c SHA256SUMS`.",
  "",
];
writeFileSync("RELEASE_NOTES.md", `${notes.join("\n")}\n`);
