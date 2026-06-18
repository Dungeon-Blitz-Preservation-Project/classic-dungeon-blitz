import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";
import {
  classIndexByName,
  disassemble,
  Instruction,
  parseAbc,
  parseSwf,
} from "../scripts/swfPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");
const CBP_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbp");

const EXPECTED_MOD_VALUES = new Map<string, string>([
  ["CritChance1", "+0.3%, +0.6%, +0.9%, +1.2%, +1.5%"],
  ["Opportunist1", "0.15%, 0.3%, 0.6%, 1.05%, 1.5%"],
  ["Dominate1", "0.15%, 0.3%, 0.45%, 0.75%, 1.2%"],
  ["CurseCrit1", "0.3%, 0.6%, 0.9%, 1.2%, 1.5%"],
]);
const EXPECTED_CHARM_PROC_CHANCE = new Map<string, string>([
  ["Infernal01", "0.033333333333333"],
  ["Infernal03", "0.1"],
  ["Infernal10", "0.333333333333333"],
  ["TripleFind", "0.266666666666667"],
  ["DoubleFind2", "0.266666666666667"],
  ["DoubleFind3", "0.266666666666667"],
]);

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function powerBlock(xml: string, powerName: string): string {
  return blockByPattern(
    xml,
    new RegExp(`<Power\\s+PowerName="${powerName}">[\\s\\S]*?<\\/Power>`),
    powerName,
  );
}

function modBlock(xml: string, modName: string): string {
  return blockByPattern(
    xml,
    new RegExp(`<PowerModType>\\s*<ModName>${modName}<\\/ModName>[\\s\\S]*?<\\/PowerModType>`),
    modName,
  );
}

function charmBlock(xml: string, charmName: string): string {
  return blockByPattern(
    xml,
    new RegExp(`<CharmType\\s+CharmName="${charmName}">[\\s\\S]*?<\\/CharmType>`),
    charmName,
  );
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function descriptionValues(description: string): string {
  const marker = description.lastIndexOf(":,");
  assert.notEqual(marker, -1, `description should include a value-list separator: ${description}`);
  return description.slice(marker + 2).trim();
}

function assertCritChanceDisplays(playerPowerXml: string, powerModXml: string, label: string): void {
  assert.equal(
    tagValue(powerBlock(playerPowerXml, "CritChance"), "Description"),
    "+1.5% Critical Chance",
    `${label}: gear crit-chance proc description`,
  );

  for (const [modName, values] of EXPECTED_MOD_VALUES) {
    const description = tagValue(modBlock(powerModXml, modName), "Description");
    assert(description, `${label}: ${modName} description`);
    assert.equal(descriptionValues(description), values, `${label}: ${modName} visible crit values`);
  }
}

function assertCriticalCharmProcValues(charmXml: string, label: string): void {
  for (const [charmName, expectedValue] of EXPECTED_CHARM_PROC_CHANCE) {
    assert.equal(
      tagValue(charmBlock(charmXml, charmName), "ProcChanceUp"),
      expectedValue,
      `${label}: ${charmName} stored critical chance multiplier`,
    );
  }
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} must contain ${marker}`);
  return chunk.xml;
}

function localOperand(inst: Instruction): number | null {
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  const operand = inst.operands[0];
  if (inst.opcode !== 0x62 || !operand || operand[0] !== "u30") {
    return null;
  }
  return operand[1];
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x24 || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

function multiname(abc: ReturnType<typeof parseAbc>, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function isGetLexMath(abc: ReturnType<typeof parseAbc>, inst: Instruction | undefined): boolean {
  return Boolean(inst && inst.opcode === 0x60 && multiname(abc, inst) === "Math");
}

function isScaledInventoryDisplay(instructions: Instruction[], index: number): boolean {
  return (
    pushByteValue(instructions[index + 1]) === 15 &&
    instructions[index + 2]?.opcode === 0xa2 &&
    instructions[index + 3]?.opcode === 0x02
  );
}

function assertScreenArmoryCritChanceStatScale(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "ScreenArmory");
  assert.notEqual(classIndex, null, "DungeonBlitz.swf must contain ScreenArmory");

  let oldCount = 0;
  let patchedCount = 0;
  const traits = [
    ...abc.instances[classIndex as number].traits,
    ...(abc.classTraits[classIndex as number] ?? []),
  ];

  for (const trait of traits) {
    if (trait.methodIdx === null) {
      continue;
    }
    const methodBody = abc.methodBodies.get(trait.methodIdx);
    if (!methodBody) {
      continue;
    }
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `ScreenArmory.${abc.multinameNames[trait.nameIdx] ?? trait.methodIdx}`);
    } catch {
      continue;
    }

    for (let index = 0; index < instructions.length - 3; index += 1) {
      const previousInst = instructions[index - 1];
      const local = localOperand(instructions[index]);
      if (local !== 7 && local !== 65) {
        continue;
      }

      if (
        isScaledInventoryDisplay(instructions, index)
      ) {
        patchedCount += 1;
        continue;
      }

      if (
        isGetLexMath(abc, previousInst) &&
        pushByteValue(instructions[index + 1]) === 15 &&
        instructions[index + 2]?.opcode === 0xa2 &&
        instructions[index + 3]?.opcode === 0x46 &&
        multiname(abc, instructions[index + 3]) === "round"
      ) {
        oldCount += 1;
      }

      if (
        isGetLexMath(abc, previousInst) &&
        pushByteValue(instructions[index + 1]) === 100 &&
        instructions[index + 2]?.opcode === 0xa2 &&
        instructions[index + 3]?.opcode === 0x46 &&
        multiname(abc, instructions[index + 3]) === "round"
      ) {
        oldCount += 1;
      }
    }
  }

  assert.equal(oldCount, 0, "served DungeonBlitz.swf should not render Critical Chance with old integer-percent scaling");
  assert.equal(patchedCount, 3, "served DungeonBlitz.swf should patch all Critical Chance stat-page formatters to preserve decimals");
}

assertCritChanceDisplays(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8"),
  "loose XML",
);
assertCriticalCharmProcValues(fs.readFileSync(path.join(XML_DIR, "CharmTypes.xml"), "utf8"), "loose XML");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  assertCritChanceDisplays(
    swzChunk(swzPath, "<PlayerPowerTypes"),
    swzChunk(swzPath, "<PowerModTypes"),
    fileName,
  );
  assertCriticalCharmProcValues(swzChunk(swzPath, "<CharmTypes"), fileName);
}

assertScreenArmoryCritChanceStatScale(path.join(CBP_DIR, "DungeonBlitz.swf"));

console.log("crit_chance_display_regression passed");
