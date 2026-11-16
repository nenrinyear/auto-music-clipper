import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tools = path.join(root, ".build-tools");
const executable = (name) => process.platform === "win32" ? `${name}.exe` : name;
const env = { ...process.env };
const localCargo = path.join(tools, "cargo");
if (existsSync(path.join(localCargo, "bin", executable("rustup")))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(tools, "rustup");
  env.PATH = `${path.join(localCargo, "bin")}${path.delimiter}${env.PATH ?? ""}`;
}
const probe = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

// Workers Builds does not guarantee a preinstalled Rust toolchain.
// Bootstrap into the checkout, without modifying the build machine's PATH/profile.
if (probe("rustup", ["--version"]).status !== 0) {
  if (process.platform !== "linux") {
    throw new Error("Install rustup from https://rustup.rs, then rerun pnpm run build:wasm.");
  }
  env.CARGO_HOME = path.join(tools, "cargo");
  env.RUSTUP_HOME = path.join(tools, "rustup");
  env.PATH = `${path.join(env.CARGO_HOME, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  mkdirSync(tools, { recursive: true });
  const installer = path.join(tools, "rustup-init.sh");
  run("curl", ["--proto", "=https", "--tlsv1.2", "--fail", "--silent", "--show-error", "--location", "https://sh.rustup.rs", "--output", installer]);
  run("sh", [installer, "-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", "none"]);
}

// rust-toolchain.toml pins Rust and adds the WASM target automatically.
run("cargo", ["--version"]);
const lock = readFileSync(path.join(root, "Cargo.lock"), "utf8");
const version = lock.match(/\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/)?.[1];
if (!version) throw new Error("Cannot find wasm-bindgen version in Cargo.lock");
const cliRoot = path.join(tools, `wasm-bindgen-${version}`);
let cli = executable("wasm-bindgen");
if (probe(cli, ["--version"]).stdout?.trim() !== `wasm-bindgen ${version}`) {
  cli = path.join(cliRoot, "bin", executable("wasm-bindgen"));
  if (probe(cli, ["--version"]).stdout?.trim() !== `wasm-bindgen ${version}`) {
    run("cargo", ["install", "wasm-bindgen-cli", "--version", version, "--locked", "--root", cliRoot]);
  }
}
run("cargo", ["build", "--locked", "--release", "-p", "audio-wasm", "--target", "wasm32-unknown-unknown"]);
const target = path.resolve(root, env.CARGO_TARGET_DIR || "target");
run(cli, ["--target", "web", "--out-dir", path.join(root, "web/src/wasm"), "--out-name", "audio_wasm", path.join(target, "wasm32-unknown-unknown/release/audio_wasm.wasm")]);
