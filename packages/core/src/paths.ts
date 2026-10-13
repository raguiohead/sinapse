import os from "node:os";
import path from "node:path";

// SINAPSE_HOME lets tests and parallel setups use an isolated data dir without touching the real ~/.sinapse.
export function sinapseDir(): string {
  return process.env.SINAPSE_HOME || path.join(os.homedir(), ".sinapse");
}
