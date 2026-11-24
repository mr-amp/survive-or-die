import os from "node:os";

export interface ResourceSnapshot {
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
  processCpuPercentOneCore: number;
  sampledAt: string;
}

let previousCpu = process.cpuUsage();
let previousSampleAt = Date.now();

/** Return host RAM and this Node process's resident memory/CPU use. */
export function getResourceSnapshot(): ResourceSnapshot {
  const now = Date.now();
  const elapsedMs = Math.max(1, now - previousSampleAt);
  const cpuDelta = process.cpuUsage(previousCpu);
  const cpuPercent = Math.min(100, ((cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs) * 100);
  previousCpu = process.cpuUsage();
  previousSampleAt = now;

  return {
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: os.freemem(),
    processRssBytes: process.memoryUsage().rss,
    processHeapUsedBytes: process.memoryUsage().heapUsed,
    processCpuPercentOneCore: Math.round(cpuPercent * 10) / 10,
    sampledAt: new Date(now).toISOString(),
  };
}

/** Keep local child workers from adding memory pressure to the primary agent. */
export function hasMemoryForLocalWorker(
  availableMemoryBytes: number,
  profile: "16gb" | "32gb" = "16gb",
): boolean {
  const reserveBytes = profile === "32gb" ? 3 * 1024 ** 3 : 1536 * 1024 ** 2;
  return availableMemoryBytes >= reserveBytes;
}
