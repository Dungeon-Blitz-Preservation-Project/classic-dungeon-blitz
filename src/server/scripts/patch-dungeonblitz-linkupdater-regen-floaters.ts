import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

type Args = {
  swfPath: string;
  outputPath: string;
  verify: boolean;
};

function parseArgs(argv: string[]): Args {
  let swfPath = DEFAULT_SWF;
  let outputPath = "";
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      outputPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-linkupdater-regen-floaters.ts [--verify] [--swf <path>] [--output <path>]",
        "",
        "Makes LinkUpdater.method_1813 pass false to method_3000 so PKTTYPE_CHAR_REGEN displays green heal floaters.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, outputPath: outputPath || swfPath, verify };
}

function analyzePatch(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("LinkUpdater class not found");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1813");
  if (methodIdx === null) {
    throw new PatchError("LinkUpdater.method_1813 not found");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError("LinkUpdater.method_1813 body not found");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "LinkUpdater.method_1813");
  const method3000CallIndex = instructions.findIndex(
    (inst) =>
      inst.opcode === 0x4f &&
      inst.operands[1]?.[1] === 3 &&
      u30OperandName(inst, abc.multinameNames) === "method_3000",
  );
  if (method3000CallIndex <= 0) {
    throw new PatchError("LinkUpdater.method_1813 method_3000 call not found");
  }

  const booleanInstruction = instructions[method3000CallIndex - 1];
  const absoluteBooleanOffset = methodBody.codeStart + booleanInstruction.offset;
  if (booleanInstruction.opcode === 0x27) {
    return { ctx, patches: [] };
  }
  if (booleanInstruction.opcode !== 0x26) {
    throw new PatchError(
      `Expected pushtrue before LinkUpdater.method_1813 method_3000 call, found opcode 0x${booleanInstruction.opcode.toString(16)}`,
    );
  }

  return {
    ctx,
    patches: [
      {
        key: "linkupdater-char-regen-show-floaters",
        start: absoluteBooleanOffset,
        end: absoluteBooleanOffset + 1,
        data: Buffer.from([0x27]),
        detail: "LinkUpdater.method_1813 passes false to method_3000 so PKTTYPE_CHAR_REGEN shows heal floaters",
      },
    ],
  };
}

function main(): number {
  const args = parseArgs(process.argv);
  const { ctx, patches } = analyzePatch(args.swfPath);
  console.log(`SWF: ${args.swfPath}`);

  if (patches.length === 0) {
    console.log("No changes needed.");
    return 0;
  }

  for (const patch of patches) {
    console.log(`Patch: ${patch.detail}`);
  }
  if (args.verify) {
    return 0;
  }

  if (path.resolve(args.outputPath) === path.resolve(args.swfPath)) {
    ensureBackup(args.swfPath);
  }
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  ctx.path = args.outputPath;
  writeSwf(ctx, body, delta);
  console.log(`Patched SWF written to ${args.outputPath}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
