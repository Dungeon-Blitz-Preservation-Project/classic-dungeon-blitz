import { execFileSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PATCH_SCRIPT = path.join(ROOT, "src", "server", "scripts", "patch-dungeonblitz-gear-tooltip-stat-values.ts");
const SWF_PATH = path.join(ROOT, "src", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");

execFileSync("npx", ["ts-node", PATCH_SCRIPT, "--verify", "--swf", SWF_PATH], {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("gear_tooltip_stat_values_regression passed");
