// Decides whether the release job publishes this version (see docs/releasing.md).
//
// Writes `published=true` or `published=false` to $GITHUB_OUTPUT, or exits non-zero.
// - Version not on the registry: publish.
// - Published from this commit (`gitHead` matches): skip, the release already happened.
// - Published from another commit: fail.
// - Published without a `gitHead`: npm records none when it cannot read `.git/HEAD`, for example from a git
//   worktree, where `.git` is a file. Then the published tarball is compared file by file with a fresh pack of
//   this commit: identical contents skip, any difference fails.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";
const sha = process.env.GITHUB_SHA;
if (!sha) throw new Error("GITHUB_SHA is required");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`);
let published;
if (response.status === 404) {
	published = false;
} else {
	if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
	const meta = await response.json();
	if (meta.gitHead) {
		if (meta.gitHead !== sha) {
			throw new Error(`${pkg.name}@${pkg.version} was published from ${meta.gitHead}, not ${sha}`);
		}
		console.log("This exact commit is already published; skipping duplicate upload");
	} else {
		await compareWithPublished(meta.dist);
		console.log("Published without a gitHead, but its contents equal this commit's pack; skipping upload");
	}
	published = true;
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
else console.log(`published=${published}`);

async function compareWithPublished(dist) {
	const work = mkdtempSync(join(tmpdir(), "pi-durable-release-"));
	try {
		const tarball = await fetch(dist.tarball);
		if (!tarball.ok) throw new Error(`tarball download returned ${tarball.status}`);
		const bytes = Buffer.from(await tarball.arrayBuffer());
		const [algorithm, expected] = dist.integrity.split(/-(.*)/s);
		if (createHash(algorithm).update(bytes).digest("base64") !== expected) {
			throw new Error("The downloaded tarball does not match the registry's integrity");
		}
		writeFileSync(join(work, "published.tgz"), bytes);

		// `npm pack` runs prepack, so this builds dist from this commit's source.
		const packOut = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
			timeout: 180_000,
		});
		const packed = JSON.parse(packOut.slice(packOut.indexOf("[")))[0].filename;

		const trees = {};
		for (const [name, file] of [["published", "published.tgz"], ["packed", packed]]) {
			const dir = join(work, name);
			mkdirSync(dir);
			execFileSync("tar", ["-xzf", join(work, file), "-C", dir]);
			trees[name] = files(dir);
		}
		const paths = new Set([...trees.published.keys(), ...trees.packed.keys()]);
		const differ = [...paths]
			.filter((path) => {
				const a = trees.published.get(path);
				const b = trees.packed.get(path);
				return !a || !b || !a.equals(b);
			})
			.sort();
		if (differ.length > 0) {
			throw new Error(`${pkg.name}@${pkg.version} exists without a gitHead and differs from this commit in: ${differ.join(", ")}`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function files(dir) {
	const out = new Map();
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out.set(relative(dir, path), readFileSync(path));
	}
	return out;
}
