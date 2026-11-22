import { parentPort, workerData } from "node:worker_threads";

import { redactText } from "./redaction.js";

const { prompt, patterns } = workerData as { prompt: string; patterns: string[] };
parentPort?.postMessage(redactText(prompt, patterns));
