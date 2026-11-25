// Runs only the 1-UA scenario (smoke/one-ua.mjs) in a real Electron: `npm run smoke:one-ua`. It makes no sound and
// shows no window. Exit code 0 on success, 1 with a "smoke: FAIL" line otherwise.
import { app } from "electron";
import { runOneUaScenario } from "./one-ua.mjs";

const TIMEOUT_MS = 120_000;
function fail(err) {
  console.error(`smoke: FAIL ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  app.exit(1);
}
const timer = setTimeout(() => fail(new Error(`timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  await runOneUaScenario({ pass: (name) => console.log(`smoke: ok   ${name}`), fail });
  clearTimeout(timer);
  console.log("smoke: PASS");
  app.exit(0);
}).catch(fail);
