// Turns .agents/plugins/marketplace.json + .github/plugins-build.json into the
// build matrix, resolving each plugin's branch ref to an immutable commit so
// every platform in one run builds the same source.
//
// Writes GitHub Actions step outputs (matrix, resolved, tag) to stdout.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const marketplace = JSON.parse(
  readFileSync(".agents/plugins/marketplace.json", "utf8"),
);
const recipes = JSON.parse(readFileSync(".github/plugins-build.json", "utf8"));

const platforms = recipes.platforms;
const entries = [];
const resolved = {};

for (const plugin of marketplace.plugins) {
  const recipe = recipes.plugins[plugin.name];
  if (!recipe) {
    throw new Error(
      `no build recipe for marketplace plugin "${plugin.name}" ` +
        `— add one to .github/plugins-build.json`,
    );
  }
  if (plugin.source.source !== "url") {
    throw new Error(
      `plugin "${plugin.name}" has source "${plugin.source.source}"; ` +
        `only "url" sources can be built from upstream`,
    );
  }

  const url = plugin.source.url;
  const ref = plugin.source.ref;

  let commit;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    commit = ref;
  } else {
    // Resolve the branch or tag once, here, so every platform in this run
    // builds the same source even if upstream moves mid-run.
    const out = execFileSync("git", ["ls-remote", url, ref], {
      encoding: "utf8",
    }).trim();
    commit = out.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
      throw new Error(`could not resolve ${url}#${ref} to a commit (got "${out}")`);
    }
  }

  // actions/checkout wants owner/repo, not a clone URL.
  const repo = url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

  resolved[plugin.name] = { repo, url, ref, commit, assets: {} };

  for (const platform of platforms) {
    const asset = `${recipe.binary}-${platform.id}${platform.ext}`;
    resolved[plugin.name].assets[platform.id] = { name: asset };
    entries.push({
      plugin: plugin.name,
      repo,
      commit,
      kind: recipe.kind,
      platform: platform.id,
      asset,
      goos: platform.goos,
      goarch: platform.goarch,
      bun: platform.bun,
      package: recipe.package ?? "",
      entry: recipe.entry ?? "",
    });
  }
}

const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const tag =
  (process.env.INPUT_TAG ?? "").trim() ||
  `binaries-${date}-${process.env.RUN_NUMBER ?? "0"}`;

process.stdout.write(`matrix=${JSON.stringify(entries)}\n`);
process.stdout.write(`resolved=${JSON.stringify(resolved)}\n`);
process.stdout.write(`tag=${tag}\n`);
