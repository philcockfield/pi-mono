import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

if (process.argv[2] === "--launcher-fixture") {
	const scenario = process.argv[3];
	// Exercise the exact template written by the builder without requiring a workspace build.
	const source = readFileSync(new URL("./build-coding-agent-bundle.mjs", import.meta.url), "utf8");
	const match = source.match(/const cliLauncher = `([^`]*)`;/);
	assert.ok(match, "Could not find the CLI launcher template");
	const launcherUrl = "file:///pi/dist/bundle/cli.js";
	const calls = [];
	const failure = new Error("fixture failure");
	const exports = {
		createRequire(url) {
			assert.equal(url, launcherUrl);
			return (specifier) => {
				assert.equal(specifier, "./cli-runtime.js");
				calls.push("runtime");
				if (scenario === "runtime-error") throw failure;
			};
		},
	};
	if (scenario !== "absent") {
		exports.enableCompileCache = () => {
			calls.push("cache");
			if (scenario === "cache-error") throw failure;
		};
	}
	const nodeModule = new vm.SyntheticModule(Object.keys(exports), function () {
		for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
	});
	const launcher = new vm.SourceTextModule(match[1], {
		identifier: launcherUrl,
		initializeImportMeta: (meta) => void (meta.url = launcherUrl),
	});
	await launcher.link((specifier) => {
		assert.equal(specifier, "node:module");
		return nodeModule;
	});
	if (scenario === "cache-error" || scenario === "runtime-error") {
		await assert.rejects(launcher.evaluate(), (error) => error === failure);
	} else {
		await launcher.evaluate();
	}
	assert.deepEqual(
		calls,
		scenario === "absent" ? ["runtime"] : scenario === "cache-error" ? ["cache"] : ["cache", "runtime"],
	);
	console.log("launcher assertions completed");
} else {
	for (const [scenario, description] of [
		["absent", "starts when node:module does not export enableCompileCache"],
		["present", "enables the compile cache once before loading the CLI runtime"],
		["cache-error", "propagates cache initialization errors without loading the runtime"],
		["runtime-error", "propagates CLI runtime errors"],
	]) {
		test(description, () => {
			const result = spawnSync(
				process.execPath,
				["--experimental-vm-modules", fileURLToPath(import.meta.url), "--launcher-fixture", scenario],
				{ encoding: "utf8", env: {}, timeout: 10_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" },
			);
			assert.ifError(result.error);
			assert.equal(result.signal, null);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, "launcher assertions completed\n");
		});
	}
}
