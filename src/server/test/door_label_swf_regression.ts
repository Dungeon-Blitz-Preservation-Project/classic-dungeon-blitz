import { strict as assert } from 'assert';
import * as path from 'path';
import {
    classIndexByName,
    disassemble,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    u30OperandName
} from '../scripts/swfPatchUtils';

const swfPath = path.resolve(
    __dirname,
    '..',
    '..',
    'client',
    'content',
    'localhost',
    'p',
    'cbp',
    'DungeonBlitz.swf'
);

const ctx = parseSwf(swfPath);
const abc = parseAbc(ctx);

let sharedDungeonLabelMatches = 0;
let normalizedTravelLabelMatches = 0;
let staleReturnLabelMatches = 0;

for (let i = 1; i < abc.stringValues.length; i += 1) {
    if (
        abc.stringValues[i] === 'Dungeon' &&
        abc.stringValues[i - 1] === 'Trap' &&
        abc.stringValues[i + 1] === 'TravelToTownOne'
    ) {
        sharedDungeonLabelMatches += 1;
    }

    if (abc.stringValues[i] === 'Travel to') {
        normalizedTravelLabelMatches += 1;
    }

    if (abc.stringValues[i] === 'Return to') {
        staleReturnLabelMatches += 1;
    }
}

assert.equal(sharedDungeonLabelMatches, 1, 'shared dungeon door label should remain Dungeon');
assert.equal(normalizedTravelLabelMatches, 1, 'town travel label should be normalized to Travel to');
assert.equal(staleReturnLabelMatches, 0, 'served SWF should not keep the old Return to travel label');

const entityClassIndex = classIndexByName(abc, 'Entity');
assert.notEqual(entityClassIndex, null, 'served SWF should contain Entity');

const methodIndex = methodIdxForTrait(abc.instances[entityClassIndex!].traits, abc, 'method_579');
assert.notEqual(methodIndex, null, 'Entity.method_579 should exist');

const methodBody = abc.methodBodies.get(methodIndex!);
assert(methodBody, 'Entity.method_579 body should exist');

const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
const instructions = disassemble(code, 'Entity.method_579');
let patchedWorldTravelRuleFound = false;
let staleDoorTwoRuleFound = false;

for (let i = 0; i <= instructions.length - 4; i += 1) {
    const [getLocal, getProperty, pushByte, comparison] = instructions.slice(i, i + 4);
    if (
        getLocal.opcode !== 0xd1 ||
        getProperty.opcode !== 0x66 ||
        u30OperandName(getProperty, abc.multinameNames) !== 'doorID' ||
        pushByte.opcode !== 0x24
    ) {
        continue;
    }

    const pushValue = pushByte.operands[0]?.[1];
    if (pushValue === 100 && comparison.opcode === 0xb0) {
        patchedWorldTravelRuleFound = true;
    }
    if (pushValue === 2 && comparison.opcode === 0xab) {
        staleDoorTwoRuleFound = true;
    }
}

assert.equal(patchedWorldTravelRuleFound, true, 'world travel doors should use the doorID >= 100 dungeon-header rule');
assert.equal(staleDoorTwoRuleFound, false, 'served SWF should not use the old doorID == 2 header rule');

console.log('door_label_swf_regression: ok');
