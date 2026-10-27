/**
 * container-engine.mjs — Detect and abstract the container engine.
 *
 * SpaceApp supports Docker (default) and rootless Podman. Podman is
 * preferred when available because it runs without a daemon and without
 * root, which matches the rootless workflow many contributors use.
 *
 * The compose interface differs between engines:
 *   - Docker:      docker compose …
 *   - Podman:      podman-compose …   (or: podman compose … on Podman >= 4.7)
 *
 * This module resolves the engine once per process and exposes helpers
 * so callers never branch on the engine name themselves.
 */

import { spawnSync } from "node:child_process";

const ENGINE_ENV_VAR = "SPACEAPP_CONTAINER_ENGINE";

/** @returns {"docker"|"podman"|null} */
export function detectEngine() {
  // Explicit override wins.
  const forced = process.env[ENGINE_ENV_VAR];
  if (forced === "docker" || forced === "podman") return forced;

  // Podman first: rootless, no daemon.
  if (commandExists("podman")) return "podman";
  if (commandExists("docker")) return "docker";
  return null;
}

function commandExists(cmd) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [cmd], { encoding: "utf8", stdio: "ignore" });
  return result.status === 0;
}

/** True when the resolved engine is Podman. */
export function isPodman(engine = detectEngine()) {
  return engine === "podman";
}

/**
 * Build the compose invocation for the resolved engine.
 *
 * @param {string[]} composeArgs  Arguments passed to the compose sub-command
 *                                (e.g. ["up", "-d"]).
 * @returns {{ command: string, args: string[] }}
 */
export function composeInvocation(composeArgs, engine = detectEngine()) {
  if (engine === "podman") {
    // Prefer `podman compose` (Podman >= 4.7 ships the compose plugin).
    // Fall back to the standalone podman-compose binary.
    if (podmanComposePluginAvailable()) {
      return { command: "podman", args: ["compose", ...composeArgs] };
    }
    return { command: "podman-compose", args: composeArgs };
  }
  // Default: Docker with the compose v2 plugin.
  return { command: "docker", args: ["compose", ...composeArgs] };
}

function podmanComposePluginAvailable() {
  const result = spawnSync("podman", ["compose", "version"], {
    encoding: "utf8",
    stdio: "ignore"
  });
  return result.status === 0;
}

/**
 * Engine-specific flags for `run`/`create` that differ between Docker and
 * rootless Podman. Currently only the userns handling differs; callers can
 * spread the result into their arg list.
 */
export function engineRunFlags(engine = detectEngine()) {
  if (engine === "podman") {
    // Rootless Podman maps the host user into the container by default;
    // --userns=keep-id is the closest match to Docker's default behaviour
    // for the fixed UIDs SpaceApp uses.
    return ["--userns=keep-id"];
  }
  return [];
}

/** Human-readable engine label for logs and status output. */
export function engineLabel(engine = detectEngine()) {
  if (engine === "podman") return "Podman (rootless)";
  if (engine === "docker") return "Docker";
  return "none";
}
