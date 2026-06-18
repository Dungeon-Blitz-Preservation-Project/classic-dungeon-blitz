import { strict as assert } from 'assert';
import * as net from 'net';
import * as path from 'path';
import { Client } from '../core/Client';
import { getStoredDungeonSnapshot } from '../core/DungeonSnapshot';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { Character } from '../database/Database';
import { CharacterHandler } from '../handlers/CharacterHandler';

function createCharacter(name: string): Character {
    return {
        name,
        class: 'Paladin',
        gender: 'male',
        level: 1,
        CurrentLevel: { name: 'JadeCity', x: 10399, y: 1043 },
        PreviousLevel: { name: 'WolfsEnd', x: 1210, y: 880 }
    };
}

function withMockedRandom(values: number[], fn: () => void): void {
    const originalRandom = Math.random;
    let nextIndex = 0;
    Math.random = () => values[Math.min(nextIndex++, values.length - 1)] ?? 0;
    try {
        fn();
    } finally {
        Math.random = originalRandom;
    }
}

function createEnterWorldClient(character: Character): any {
    return {
        userId: 41,
        account: null,
        characters: [character],
        sendBitBuffer() {
            return undefined;
        }
    };
}

function resetGlobalState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.usedTransferTokens.clear();
    GlobalState.tokenChar.clear();
    GlobalState.transferTokenAliases.clear();
    GlobalState.levelEntities.clear();
    GlobalState.partyByMember.clear();
}

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('JC_Mission1')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function testDungeonDisconnectClearsResumeSnapshotAndKeepsSafeReturn(): void {
    const client = new Client(
        new net.Socket(),
        {
            handle: async () => undefined
        } as never
    );
    const character = createCharacter('SnapshotHero');
    character.questTrackerState = 64;

    client.userId = 41;
    client.authenticated = true;
    client.character = character;
    client.characters = [character];
    client.token = 19301;
    client.clientEntID = 501;
    client.currentLevel = 'JC_Mission1';
    client.levelInstanceId = 'jc-mission1-run';
    client.entryLevel = 'JadeCity';
    client.entryX = 10399;
    client.entryY = 1043;
    client.entryHasCoord = true;
    client.currentRoomId = 8;
    client.startedRoomEvents.add('JC_Mission1:2');
    client.startedRoomEvents.add('JC_Mission1:8');
    client.startedRoomEvents.add('OtherDungeon:9');
    client.syncAnchorStartedAt = 1700000000;
    client.entities.set(501, { x: 8120, y: -144 });

    (client as any).repairDungeonLocationBeforeSave();

    const snapshot = getStoredDungeonSnapshot(character);
    assert.equal(snapshot, null, 'refreshing inside a dungeon should not persist a resume snapshot');
    assert.deepEqual(
        character.CurrentLevel,
        { name: 'JadeCity', x: 10399, y: 1043 },
        'disconnect save should leave CurrentLevel at the safe dungeon return point'
    );
}

function testStoredDungeonSnapshotIsIgnoredOnEnterWorld(): void {
    const character = createCharacter('SnapshotHero');
    character.DungeonSnapshot = {
        levelName: 'JC_Mission1',
        x: 8120,
        y: -144,
        hasCoord: true,
        levelInstanceId: 'jc-mission1-run',
        entryLevel: 'JadeCity',
        entryX: 10399,
        entryY: 1043,
        entryHasCoord: true,
        currentRoomId: 8,
        startedRoomIds: [2, 8],
        questProgress: 64,
        syncAnchorStartedAt: 1700000000,
        savedAt: 1700000123
    };
    const client = createEnterWorldClient(character);

    withMockedRandom([50002.5 / 0x10000], () => {
        (CharacterHandler as any).sendEnterWorld(client, character);
    });

    const pendingEntry = GlobalState.pendingWorld.get(50002);
    assert.ok(pendingEntry, 'enter-world should still create a pending transfer');
    assert.equal(pendingEntry.targetLevel, 'JadeCity');
    assert.equal(pendingEntry.previousLevel, 'WolfsEnd');
    assert.equal(pendingEntry.levelInstanceId, undefined);
    assert.equal(pendingEntry.newX, 10399);
    assert.equal(pendingEntry.newY, 1043);
    assert.equal(pendingEntry.newHasCoord, true);
    assert.equal(pendingEntry.syncAnchorStartedAt, undefined);
    assert.equal(pendingEntry.syncAnchorToken, undefined);
    assert.equal(pendingEntry.syncAnchorCharacterName, undefined);
    assert.equal(pendingEntry.syncEntryLevel, undefined);
    assert.equal(pendingEntry.syncRoomId, undefined);
    assert.equal(pendingEntry.syncStartedRoomIds, undefined);
    assert.equal(pendingEntry.syncQuestProgress, undefined);
    assert.equal(getStoredDungeonSnapshot(character), null, 'stale stored dungeon snapshots should be cleared before entering world');
}

function testOverworldSaveClearsStoredDungeonSnapshot(): void {
    const client = new Client(
        new net.Socket(),
        {
            handle: async () => undefined
        } as never
    );
    const character = createCharacter('ReturnedHero');
    character.DungeonSnapshot = {
        levelName: 'JC_Mission1',
        currentRoomId: 8,
        startedRoomIds: [2, 8],
        savedAt: 1700000123
    };

    client.userId = 41;
    client.authenticated = true;
    client.character = character;
    client.characters = [character];
    client.currentLevel = 'JadeCity';

    (client as any).repairDungeonLocationBeforeSave();

    assert.equal(getStoredDungeonSnapshot(character), null, 'saving outside a dungeon should clear stale resume snapshots');
    assert.equal(character.DungeonSnapshot, undefined);
}

function main(): void {
    try {
        ensureLevelConfigLoaded();

        resetGlobalState();
        testDungeonDisconnectClearsResumeSnapshotAndKeepsSafeReturn();

        resetGlobalState();
        testStoredDungeonSnapshotIsIgnoredOnEnterWorld();

        resetGlobalState();
        testOverworldSaveClearsStoredDungeonSnapshot();

        console.log('dungeon_snapshot_regression: ok');
    } catch (error) {
        console.error('dungeon_snapshot_regression: failed');
        console.error(error);
        process.exitCode = 1;
    } finally {
        resetGlobalState();
    }
}

main();
