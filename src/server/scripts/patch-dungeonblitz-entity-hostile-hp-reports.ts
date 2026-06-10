import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  readU30,
  u30OperandName,
  writeSwf,
  writeU30,
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

const BRANCH_OPCODES = new Set([
  0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
]);

type Args = {
  swfPath: string;
  verify: boolean;
};

function parseArgs(argv: string[]): Args {
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
        "  npx ts-node src/server/scripts/patch-dungeonblitz-entity-hostile-hp-reports.ts [--verify] [--swf <path>]",
        "",
        "Patches Entity.TakeDamage so local hostile HP loss is reported to the server with PKTTYPE_CHAR_REGEN.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 branch offset out of range: ${value}`);
  }
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function op(opcode: number, ...operands: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function pushByte(value: number): Buffer {
  return op(0x24, Buffer.from([value & 0xff]));
}

function getLocal(index: number): Buffer {
  if (index >= 0 && index <= 3) {
    return op(0xd0 + index);
  }
  return op(0x62, writeU30(index));
}

function setLocal(index: number): Buffer {
  if (index >= 0 && index <= 3) {
    return op(0xd4 + index);
  }
  return op(0x63, writeU30(index));
}

function getProperty(index: number): Buffer {
  return op(0x66, writeU30(index));
}

function setProperty(index: number): Buffer {
  return op(0x68, writeU30(index));
}

function getLex(index: number): Buffer {
  return op(0x60, writeU30(index));
}

function findPropStrict(index: number): Buffer {
  return op(0x5d, writeU30(index));
}

function constructProp(index: number, argCount: number): Buffer {
  return op(0x4a, writeU30(index), writeU30(argCount));
}

function callPropVoid(index: number, argCount: number): Buffer {
  return op(0x4f, writeU30(index), writeU30(argCount));
}

function coerce(index: number): Buffer {
  return op(0x80, writeU30(index));
}

function branch(opcode: number, target: string): { opcode: number; target: string } {
  return { opcode, target };
}

type Piece = Buffer | { label: string } | { opcode: number; target: string };

function label(name: string): { label: string } {
  return { label: name };
}

function assemble(pieces: Piece[]): Buffer {
  let offset = 0;
  const labels = new Map<string, number>();
  for (const piece of pieces) {
    if (Buffer.isBuffer(piece)) {
      offset += piece.length;
      continue;
    }
    if ("label" in piece) {
      labels.set(piece.label, offset);
      continue;
    }
    offset += 4;
  }

  offset = 0;
  const out: Buffer[] = [];
  for (const piece of pieces) {
    if (Buffer.isBuffer(piece)) {
      out.push(piece);
      offset += piece.length;
      continue;
    }
    if ("label" in piece) {
      continue;
    }

    const target = labels.get(piece.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch target ${piece.target}.`);
    }
    out.push(op(piece.opcode, s24(target - (offset + 4))));
    offset += 4;
  }

  return Buffer.concat(out);
}

function requiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Could not find multiname ${name}.`);
  }
  return index;
}

function getEntityTakeDamage(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Entity");
  if (classIndex === null) {
    throw new PatchError("Could not find Entity class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "TakeDamage");
  if (methodIdx === null) {
    throw new PatchError("Could not find Entity.TakeDamage.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Entity.TakeDamage (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code };
}

function patchBranchesForInsertion(code: Buffer, instructions: Instruction[], insertAt: number, delta: number): Buffer {
  const patched = Buffer.from(code);
  for (const inst of instructions) {
    if (!BRANCH_OPCODES.has(inst.opcode)) {
      continue;
    }
    const operand = inst.operands[0];
    if (!operand || operand[0] !== "s24") {
      continue;
    }

    const oldSourceEnd = inst.offset + inst.size;
    const oldTarget = oldSourceEnd + operand[1];
    let nextOperand = operand[1];
    if (inst.offset < insertAt && oldTarget > insertAt) {
      nextOperand += delta;
    } else if (inst.offset >= insertAt && oldTarget <= insertAt) {
      nextOperand -= delta;
    }

    if (nextOperand !== operand[1]) {
      s24(nextOperand).copy(patched, inst.offset + 1);
    }
  }
  return patched;
}

function findCurrHpLossInsertion(abc: ReturnType<typeof parseAbc>, instructions: Instruction[]): number {
  const currHp = requiredMultiname(abc, "currHP");
  for (let index = 0; index < instructions.length - 5; index += 1) {
    const window = instructions.slice(index, index + 6);
    if (
      window[0].opcode === 0xd0 &&
      window[1].opcode === 0xd0 &&
      window[2].opcode === 0x66 &&
      window[2].operands[0]?.[1] === currHp &&
      window[3].opcode === 0xd1 &&
      window[4].opcode === 0xa1 &&
      window[5].opcode === 0x68 &&
      window[5].operands[0]?.[1] === currHp
    ) {
      return window[5].offset + window[5].size;
    }
  }

  throw new PatchError("Could not find Entity.TakeDamage currHP -= param1 bytecode.");
}

function buildHostileHpReport(abc: ReturnType<typeof parseAbc>): Buffer {
  const var20 = requiredMultiname(abc, "var_20");
  const team = requiredMultiname(abc, "team");
  const var1 = requiredMultiname(abc, "var_1");
  const serverConn = requiredMultiname(abc, "serverConn");
  const packet = requiredMultiname(abc, "Packet");
  const linkUpdater = requiredMultiname(abc, "LinkUpdater");
  const regenType = requiredMultiname(abc, "PKTTYPE_CHAR_REGEN");
  const method9 = requiredMultiname(abc, "method_9");
  const id = requiredMultiname(abc, "id");
  const method24 = requiredMultiname(abc, "method_24");
  const sendPacket = requiredMultiname(abc, "SendPacket");

  return assemble([
    getLocal(1),
    pushByte(0),
    branch(0x0e, "skip"),

    getLocal(0),
    getProperty(var20),
    pushByte(8),
    op(0xa8),
    branch(0x12, "skip"),

    getLocal(0),
    getProperty(var20),
    pushByte(1),
    op(0xa8),
    branch(0x11, "skip"),

    getLocal(0),
    getProperty(team),
    pushByte(2),
    branch(0x14, "skip"),

    getLocal(0),
    getProperty(var1),
    branch(0x12, "skip"),

    getLocal(0),
    getProperty(var1),
    getProperty(serverConn),
    branch(0x12, "skip"),

    findPropStrict(packet),
    getLex(linkUpdater),
    getProperty(regenType),
    constructProp(packet, 1),
    coerce(packet),
    setLocal(23),

    getLocal(23),
    getLocal(0),
    getProperty(id),
    callPropVoid(method9, 1),

    getLocal(23),
    pushByte(0),
    getLocal(1),
    op(0xa1),
    callPropVoid(method24, 1),

    getLocal(0),
    getProperty(var1),
    getProperty(serverConn),
    getLocal(23),
    callPropVoid(sendPacket, 1),

    label("skip"),
  ]);
}

function hasHostileHpReport(abc: ReturnType<typeof parseAbc>, instructions: Instruction[]): boolean {
  const currHpInsertAt = findCurrHpLossInsertion(abc, instructions);
  const names = abc.multinameNames;
  return instructions.some((inst) => {
    if (inst.offset <= currHpInsertAt || inst.offset > currHpInsertAt + 180) {
      return false;
    }
    return inst.opcode === 0x4f && u30OperandName(inst, names) === "SendPacket";
  });
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getEntityTakeDamage(swfPath);
  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("Entity.TakeDamage has an exception table; update this patch before inserting code.");
  }

  const instructions = disassemble(code, "Entity.TakeDamage");
  if (hasHostileHpReport(abc, instructions)) {
    console.log(`${swfPath}: already patched (Entity.TakeDamage hostile HP reports present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Entity.TakeDamage hostile HP reports are missing.`);
  }

  const insertAt = findCurrHpLossInsertion(abc, instructions);
  const reportCode = buildHostileHpReport(abc);
  const branchPatchedCode = patchBranchesForInsertion(code, instructions, insertAt, reportCode.length);
  const patchedCode = Buffer.concat([
    branchPatchedCode.subarray(0, insertAt),
    reportCode,
    branchPatchedCode.subarray(insertAt),
  ]);

  const patches: BytePatch[] = [
    {
      key: "Entity.TakeDamage.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "report local hostile HP loss to the server",
    },
    {
      key: "Entity.TakeDamage.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Entity.TakeDamage code length",
    },
  ];

  const [maxStack] = readU30(ctx.body, methodBody.maxStackPos, "Entity.TakeDamage.max_stack");
  if (maxStack < 4) {
    patches.push({
      key: "Entity.TakeDamage.maxStack",
      start: methodBody.maxStackPos,
      end: methodBody.localCountPos,
      data: writeU30(4),
      detail: "allow hostile HP report packet construction stack",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);

  const verifyPass = getEntityTakeDamage(swfPath);
  if (!hasHostileHpReport(verifyPass.abc, disassemble(verifyPass.code, "Entity.TakeDamage"))) {
    throw new PatchError(`${swfPath}: post-patch verification failed.`);
  }

  console.log(`${swfPath}: patched Entity.TakeDamage hostile HP reports.`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchSwf(swfPath, verify);
}
