import { homedir } from "node:os";

/**
 * Resolve the user's home directory across Windows, macOS, and Linux.
 * Windows services and shells may omit HOME while still setting USERPROFILE.
 */
export function getUserHomeDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallback: string = homedir(),
): string {
  const platformHome = platform === "win32" ? env.USERPROFILE : env.HOME;
  const candidate = platformHome || env.HOME || env.USERPROFILE || fallback;
  return candidate.trim() ? candidate : fallback;
}
