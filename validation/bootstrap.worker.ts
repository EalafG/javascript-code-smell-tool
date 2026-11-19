import { bootstrap } from "./research-analysis.ts";
import type { BootstrapSettings } from "./research-analysis.ts";
import type { MethodComparison } from "./analysis.ts";

self.onmessage = (event: MessageEvent<{ comparisons: MethodComparison[]; settings: BootstrapSettings }>) => {
  try {
    const result = bootstrap(event.data.comparisons, event.data.settings, (completed) => self.postMessage({ type: "progress", completed }));
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Bootstrap failed." });
  }
};
