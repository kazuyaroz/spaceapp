#!/usr/bin/env node
/**
 * dev-all.mjs — Start the full SpaceApp stack from source with one command.
 *
 * Spawns the API, web and worker dev servers concurrently and forwards
 * their output with a per-service prefix. Ctrl-C stops every child.
 *
 * External dependencies (PostgreSQL, Temporal) are optional for local
 * development: the API defaults to the in-memory runtime store and the
 * worker degrades gracefully when Temporal is unreachable. Set
 * SPACE_DATABASE_URL and SPACE_TEMPORAL_ADDRESS to use real services.
 *
 * Usage: npm run dev
 */

import { spawn } from "node:child_process";

const services = [
  { name: "api", workspace: "@space/api" },
  { name: "web", workspace: "@space/web" },
  { name: "worker", workspace: "@space/worker" },
];

const children = [];

function prefix(name, color, text) {
  const reset = "\u001b[0m";
  const lines = text.split("\n");
  const last = lines.pop();
  for (const line of lines) {
    process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
  }
  if (last) process.stdout.write(`${color}[${name}]${reset} ${last}`);
}

const colors = {
  api: "\u001b[36m",     // cyan
  web: "\u001b[32m",     // green
  worker: "\u001b[33m",  // yellow
};

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write("\n\u001b[31m[dev]\u001b[0m Shutting down…\n");
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Force-kill after a grace period.
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(0);
  }, 3000).unref();
}

for (const svc of services) {
  const child = spawn(
    "npm",
    ["run", "dev", "-w", svc.workspace],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: true,
    }
  );

  children.push(child);

  child.stdout.on("data", (data) => {
    prefix(svc.name, colors[svc.name] || "", data.toString());
  });

  child.stderr.on("data", (data) => {
    prefix(svc.name, colors[svc.name] || "", data.toString());
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `\u001b[31m[dev]\u001b[0m ${svc.name} exited (code=${code} signal=${signal})\n`
    );
    shutdown();
  });

  process.stdout.write(
    `${colors[svc.name] || ""}[dev]\u001b[0m Starting ${svc.name} (${svc.workspace})…\n`
  );
}

process.stdout.write(
  "\u001b[35m[dev]\u001b[0m SpaceApp dev stack starting. Press Ctrl-C to stop all services.\n"
);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
