import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

const cargoBin = path.join(homedir(), ".cargo", "bin");
const nextPath = [cargoBin, process.env.PATH].filter(Boolean).join(path.delimiter);
const args = process.argv.slice(2);
const localTauriJs = path.join(
  process.cwd(),
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js"
);

const command = existsSync(localTauriJs) ? process.execPath : process.platform === "win32" ? "tauri.cmd" : "tauri";
const commandArgs = existsSync(localTauriJs) ? [localTauriJs, ...args] : args;

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    PATH: nextPath
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start Tauri CLI: ${error.message}`);
  process.exit(1);
});
