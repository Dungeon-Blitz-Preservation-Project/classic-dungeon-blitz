import * as path from 'path';
import { strict as assert } from 'assert';
import { Client } from '../core/Client';
import { Config } from '../core/config';
import { GameData } from '../core/GameData';
import { JsonAdapter } from '../database/JsonAdapter';
import { EquipmentHandler } from '../handlers/EquipmentHandler';
import { CommandHandler } from '../handlers/CommandHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { getEquippedCharmBonuses } from '../utils/CharmBonuses';
import { ensureSigilStoreAlertState } from '../utils/AlertState';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    character: any;
    characters: any[];
    clientEntID: number;
    token: number;
    currentLevel: string;
    currentRoomId: number;
    playerSpawned: boolean;
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    sentPackets: SentPacket[];
    combatStatsDirty: boolean;
    lastCombatStatsRefreshRequestAt: number;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name: 'CharmTester',
        class: 'Mage',
        level: 50,
        SilverSigils: 0,
        alertState: 0,
        equippedGears: [
            { gearID: 1177, tier: 2, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 1181, tier: 1, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] }
        ],
        inventoryGears: [
            { gearID: 1177, tier: 2, runes: [0, 0, 0], colors: [0, 0] }
        ],
        charms: []
    };

    return {
        userId: 6,
        character,
        characters: [character],
        clientEntID: 4001,
        token: 4001,
        currentLevel: 'CraftTown',
        currentRoomId: 0,
        playerSpawned: true,
        entities: new Map([[4001, { id: 4001, isPlayer: true, equippedGears: character.equippedGears }]]),
        knownEntityIds: new Set<number>(),
        sentPackets,
        combatStatsDirty: false,
        lastCombatStatsRefreshRequestAt: 0,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createSocketCharmPacket(entityId: number, gearId: number, tier: number, charmId: number, socketIndex: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entityId);
    bb.writeMethod20(11, gearId);
    bb.writeMethod20(2, tier);
    bb.writeMethod20(16, charmId);
    bb.writeMethod20(2, socketIndex);
    return bb.toBuffer();
}

function createAlertPacket(alertMask: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(4, alertMask);
    return bb.toBuffer();
}

function assertAlmostEqual(actual: number, expected: number, message: string): void {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`);
}

function inventoryCriticalChancePercent(procChanceUp: number): number {
    return 15 * (1 + procChanceUp);
}

async function withMockedSave<T>(fn: () => Promise<T>): Promise<T> {
    const originalSaveCharacters = JsonAdapter.prototype.saveCharacters;
    JsonAdapter.prototype.saveCharacters = async function(userId: number, characters: any[]): Promise<void> {
        assert.equal(userId, 6);
        assert.ok(characters.some((character) => character.name === 'CharmTester'));
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacters = originalSaveCharacters;
    }
}

async function testSocketCharmPersistsGearAndRequestsStatsRefresh(): Promise<void> {
    const client = createClient();
    client.character.charms = [{ charmID: 15, count: 1 }];

    await withMockedSave(async () => {
        await EquipmentHandler.handleSocketCharm(client as unknown as Client, createSocketCharmPacket(4001, 1177, 2, 15, 1));
    });

    assert.deepEqual(client.character.equippedGears[0].runes, [15, 0, 0]);
    assert.deepEqual(client.character.inventoryGears[0].runes, [15, 0, 0]);
    assert.deepEqual(client.character.charms, []);
    assert.equal(client.combatStatsDirty, true);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xFB), true, 'socketing should request fresh combat stats');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xAF), true, 'socketing should refresh live gear');
}

async function testCharmRemoverUnsocketsAndReturnsCharm(): Promise<void> {
    const client = createClient();
    client.character.equippedGears[0].runes = [15, 0, 0];
    client.character.inventoryGears[0].runes = [15, 0, 0];
    client.character.charms = [{ charmID: 96, count: 1 }];

    await withMockedSave(async () => {
        await EquipmentHandler.handleSocketCharm(client as unknown as Client, createSocketCharmPacket(4001, 1177, 2, 96, 1));
    });

    assert.deepEqual(client.character.equippedGears[0].runes, [0, 0, 0]);
    assert.deepEqual(client.character.inventoryGears[0].runes, [0, 0, 0]);
    assert.deepEqual(client.character.charms, [{ charmID: 15, count: 1 }]);
}

function testCompositeCharmBonusesDecodePrimaryAndSecondaryEffects(): void {
    if (GameData.CHARMS.length === 0) {
        GameData.load(path.join(Config.DATA_DIR, 'data'));
    }

    const compositeUndead03WithLegendaryTrog03 = 15 | (1 << 9) | (2 << 14);
    const bonuses = getEquippedCharmBonuses({
        equippedGears: [{ gearID: 1177, tier: 2, runes: [compositeUndead03WithLegendaryTrog03, 0, 0], colors: [0, 0] }]
    });

    assert.equal(bonuses.goldFind, 0.03, 'primary Undead03 gold find should apply');
    assert.equal(bonuses.itemFind, 0.03, 'legendary secondary Trog03 gear find should apply');

    const compositeTrog03WithLegendaryInfernal03 = 13 | (2 << 9) | (2 << 14);
    const criticalBonuses = getEquippedCharmBonuses({
        equippedGears: [{ gearID: 1177, tier: 2, runes: [compositeTrog03WithLegendaryInfernal03, 0, 0], colors: [0, 0] }]
    });

    assertAlmostEqual(criticalBonuses.procChanceUp, 0.1, 'legendary secondary Infernal03 should add a real +1.5% critical chance');
    assertAlmostEqual(inventoryCriticalChancePercent(criticalBonuses.procChanceUp), 16.5, 'inventory display should add the 15% base critical chance');
    assert.equal(criticalBonuses.itemFind, 0.03, 'primary Trog03 gear find should still apply with critical secondary');

    const maxCriticalBonuses = getEquippedCharmBonuses({
        equippedGears: [{ gearID: 1177, tier: 2, runes: [56, 0, 0], colors: [0, 0] }]
    });
    assertAlmostEqual(maxCriticalBonuses.procChanceUp, 1 / 3, 'Infernal10 should add a real +5% critical chance');
    assertAlmostEqual(inventoryCriticalChancePercent(maxCriticalBonuses.procChanceUp), 20, 'max Infernal inventory display should include the 15% base critical chance');
}

async function testAlertStatePersistsAndExistingSigilsSuppressRepeatedUnlock(): Promise<void> {
    const client = createClient();

    await withMockedSave(async () => {
        await CommandHandler.handleUpdateAlertState(client as unknown as Client, createAlertPacket(1));
    });

    assert.equal(client.character.alertState, 1);

    client.character.SilverSigils = 50;
    client.character.alertState = 0;
    assert.equal(ensureSigilStoreAlertState(client.character), true);
    assert.equal(client.character.alertState, 3, 'existing sigils should unlock old man and suppress repeated sigil-store unlock popups');
}

async function main(): Promise<void> {
    await testSocketCharmPersistsGearAndRequestsStatsRefresh();
    await testCharmRemoverUnsocketsAndReturnsCharm();
    testCompositeCharmBonusesDecodePrimaryAndSecondaryEffects();
    await testAlertStatePersistsAndExistingSigilsSuppressRepeatedUnlock();
    console.log('charm_socket_regression: ok');
}

void main().catch((error) => {
    console.error('charm_socket_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
