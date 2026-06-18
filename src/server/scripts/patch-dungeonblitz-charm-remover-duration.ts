import * as fs from "fs";
import * as path from "path";
import {
  classIndexByName,
  disassemble,
  ensureBackup,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
} from "./swfPatchUtils";

const DEFAULT_SWF_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
  path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
];
const DEFAULT_SWF = DEFAULT_SWF_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_SWF_CANDIDATES[0];

const OLD_CHARM_REMOVER_SECONDS = 86400;
const MODERN_CHARM_REMOVER_SECONDS = 43200;
const CHARM_REMOVER_DURATION_CONST = "const_1166";
const OLD_CHARM_REMOVER_HOURS = 24;
const MODERN_CHARM_REMOVER_HOURS = 12;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-charm-remover-duration.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf so the Charm Remover special forge duration uses 12 hours.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function getCharmRemoverDurationDoubleIndex(swfPath: string): { index: number; value: number; position: number } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_64");
  if (classIndex === null) {
    throw new PatchError("Could not find class_64.");
  }

  const trait = abc.classTraits[classIndex]?.find((entry) => abc.multinameNames[entry.nameIdx] === CHARM_REMOVER_DURATION_CONST);
  if (!trait) {
    throw new PatchError(`Could not find class_64.${CHARM_REMOVER_DURATION_CONST}.`);
  }
  if (trait.vkind !== 6 || !trait.vindex) {
    throw new PatchError(`class_64.${CHARM_REMOVER_DURATION_CONST} is not a double constant.`);
  }

  return {
    index: trait.vindex,
    value: abc.doubleValues[trait.vindex],
    position: abc.doubleValuePositions[trait.vindex],
  };
}

function getCharmRemoverInitializerHours(swfPath: string): { value: number; position: number } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  for (const body of abc.methodBodies.values()) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: ReturnType<typeof disassemble>;
    try {
      instructions = disassemble(code, `method#${body.methodIdx}`);
    } catch {
      continue;
    }

    for (let index = 0; index < instructions.length; index += 1) {
      const instruction = instructions[index];
      if (instruction.opcode !== 0x68 || u30OperandName(instruction, abc.multinameNames) !== CHARM_REMOVER_DURATION_CONST) {
        continue;
      }

      const hoursInstruction = instructions
        .slice(Math.max(0, index - 8), index)
        .reverse()
        .find((entry) =>
          entry.opcode === 0x24 &&
          entry.operands[0]?.[0] === "s8" &&
          [OLD_CHARM_REMOVER_HOURS, MODERN_CHARM_REMOVER_HOURS].includes(entry.operands[0][1])
        );
      if (!hoursInstruction) {
        throw new PatchError(`Could not find the hour multiplier before class_64.${CHARM_REMOVER_DURATION_CONST}.`);
      }

      return {
        value: hoursInstruction.operands[0][1],
        position: body.codeStart + hoursInstruction.offset + 1,
      };
    }
  }

  throw new PatchError(`Could not find the runtime initializer for class_64.${CHARM_REMOVER_DURATION_CONST}.`);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const duration = getCharmRemoverDurationDoubleIndex(swfPath);
  const initializer = getCharmRemoverInitializerHours(swfPath);

  if (verify) {
    if (duration.value !== MODERN_CHARM_REMOVER_SECONDS) {
      throw new PatchError(`Charm Remover duration patch missing: found ${duration.value}, expected ${MODERN_CHARM_REMOVER_SECONDS}.`);
    }
    if (initializer.value !== MODERN_CHARM_REMOVER_HOURS) {
      throw new PatchError(
        `Charm Remover runtime initializer patch missing: found ${initializer.value} hours, expected ${MODERN_CHARM_REMOVER_HOURS}.`,
      );
    }
    console.log("Charm Remover duration patch verified.");
    return;
  }

  if (duration.value === MODERN_CHARM_REMOVER_SECONDS && initializer.value === MODERN_CHARM_REMOVER_HOURS) {
    console.log("Charm Remover duration patch already applied.");
    return;
  }
  if (duration.value !== OLD_CHARM_REMOVER_SECONDS && duration.value !== MODERN_CHARM_REMOVER_SECONDS) {
    throw new PatchError(`Unexpected Charm Remover duration ${duration.value}; expected ${OLD_CHARM_REMOVER_SECONDS}.`);
  }
  if (initializer.value !== OLD_CHARM_REMOVER_HOURS && initializer.value !== MODERN_CHARM_REMOVER_HOURS) {
    throw new PatchError(
      `Unexpected Charm Remover runtime initializer ${initializer.value} hours; expected ${OLD_CHARM_REMOVER_HOURS}.`,
    );
  }

  const ctx = parseSwf(swfPath);
  const body = Buffer.from(ctx.body);
  if (duration.value !== MODERN_CHARM_REMOVER_SECONDS) {
    body.writeDoubleLE(MODERN_CHARM_REMOVER_SECONDS, duration.position);
  }
  if (initializer.value !== MODERN_CHARM_REMOVER_HOURS) {
    body.writeInt8(MODERN_CHARM_REMOVER_HOURS, initializer.position);
  }
  ensureBackup(swfPath);
  writeSwf(ctx, body, 0);

  const secondPass = getCharmRemoverDurationDoubleIndex(swfPath);
  if (secondPass.value !== MODERN_CHARM_REMOVER_SECONDS) {
    throw new PatchError(`Charm Remover duration patch did not verify after write: found ${secondPass.value}.`);
  }
  const secondInitializer = getCharmRemoverInitializerHours(swfPath);
  if (secondInitializer.value !== MODERN_CHARM_REMOVER_HOURS) {
    throw new PatchError(
      `Charm Remover runtime initializer patch did not verify after write: found ${secondInitializer.value} hours.`,
    );
  }

  console.log("Charm Remover duration patch applied.");
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
