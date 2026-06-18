import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseSwz } from '../scripts/swzPatchUtils';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DREAD_DISPLAY = 'Dread Bandit Camp';
const BAD_DREAD_DISPLAY = 'dehset Bandit Camp';
const BAD_DESCRIPTION_FRAGMENT = 'aoutsiders';
const GOOD_DESCRIPTION = 'The townsfolk shun outsiders, who often turn to banditry. To win their trust, you decide to tackle their bandit problem.';
const BANDIT_MISSIONS = ['DefeatBanditCamp', 'DefeatBanditCampHard'];

function getEntry(xml: string, tagName: string, childTag: string, childValue: string): string {
    const entries = xml.match(new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g')) ?? [];
    const entry = entries.find((candidate) => candidate.includes(`<${childTag}>${childValue}</${childTag}>`));
    assert.ok(entry, `${childValue} should exist in ${tagName}`);
    return entry!;
}

function tagValue(entry: string, tagName: string): string {
    return entry.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`))?.[1]?.trim() ?? '';
}

function assertLevelText(xml: string, label: string): void {
    assert.equal(xml.includes(BAD_DREAD_DISPLAY), false, `${label} should not contain ${BAD_DREAD_DISPLAY}`);
    const entry = xml.match(/<LevelType LevelName="BT_Mission1Hard">[\s\S]*?<\/LevelType>/)?.[0] ?? '';
    assert.notEqual(entry, '', `${label} should include BT_Mission1Hard`);
    assert.equal(tagValue(entry, 'DisplayName'), DREAD_DISPLAY, `${label} should show ${DREAD_DISPLAY}`);
}

function assertMissionText(xml: string, label: string): void {
    assert.equal(xml.includes(BAD_DESCRIPTION_FRAGMENT), false, `${label} should not contain aoutsiders`);
    for (const missionName of BANDIT_MISSIONS) {
        const entry = getEntry(xml, 'MissionType', 'MissionName', missionName);
        const description = tagValue(entry, 'Description');
        if (description.startsWith('The townsfolk shun')) {
            assert.equal(description, GOOD_DESCRIPTION, `${label} ${missionName} should fix outsiders typo`);
        }
    }
}

function testSourceText(): void {
    assertLevelText(
        fs.readFileSync(path.join(ROOT, 'src', 'client', 'content', 'xml', 'LevelTypes.xml'), 'utf8'),
        'source LevelTypes.xml'
    );

    const missionTypes = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'server', 'data', 'MissionTypes.json'), 'utf8')) as Array<Record<string, string>>;
    for (const missionName of BANDIT_MISSIONS) {
        const mission = missionTypes.find((entry) => entry.MissionName === missionName);
        assert.ok(mission, `${missionName} should exist in server MissionTypes.json`);
        assert.equal(mission!.Description, GOOD_DESCRIPTION, `${missionName} server description should fix outsiders typo`);
    }

    const translations = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'server', 'data', 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations: Record<string, string>;
    };
    assert.equal(Object.prototype.hasOwnProperty.call(translations.translations, GOOD_DESCRIPTION), true);
    assert.equal(Object.prototype.hasOwnProperty.call(translations.translations, GOOD_DESCRIPTION.replace('outsiders', 'aoutsiders')), false);
}

function testPackedText(): void {
    const cbqDir = path.join(ROOT, 'src', 'client', 'content', 'localhost', 'p', 'cbq');
    for (const fileName of ['Game.swz', 'Game.en.swz', 'Game.tr.swz']) {
        const ctx = parseSwz(path.join(cbqDir, fileName));
        const levelTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<LevelTypes[>\s]/));
        const missionTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<MissionTypes[>\s]/));
        assert.ok(levelTypes, `${fileName} should contain LevelTypes`);
        assert.ok(missionTypes, `${fileName} should contain MissionTypes`);
        assertLevelText(levelTypes!.xml, fileName);
        assertMissionText(missionTypes!.xml, fileName);
    }
}

testSourceText();
testPackedText();
console.log('bandit_camp_text_regression: ok');
