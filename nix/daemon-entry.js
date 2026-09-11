import { runDaemon } from "./runtime.js";

runDaemon().catch((error) => {
  console.error("Failed to start Routstr daemon:", error);
  process.exit(1);
});
