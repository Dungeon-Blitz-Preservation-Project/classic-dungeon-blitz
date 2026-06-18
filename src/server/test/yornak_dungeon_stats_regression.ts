import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import {
    getActiveDungeonRunStats,
    noteDungeonRunBossCutscene,
    noteDungeonRunChestOpened,
    noteDungeonRunKill,
    syncClientDungeonRunState
} from '../core/DungeonRunStats';
import { NpcLoader } from '../data/NpcLoader';

type FakeClient = {
    token: number;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    character: {
        name: string;
        CurrentLevel: { name: string; x: number; y: number };
    };
    entities: Map<number, any>;
    dungeonRun: any;
};

function ensureDataLoaded(): void {
    const sourceDataDir = path.resolve(__dirname, '../data');
    const compiledDataDir = path.resolve(__dirname, '../../data');
    const dataDir = fs.existsSync(path.join(sourceDataDir, 'level_config.json'))
        ? sourceDataDir
        : compiledDataDir;
    if (!LevelConfig.has('SRN_Mission2')) {
        LevelConfig.load(dataDir);
    }
    if (!GameData.getEntType('SwampKing') || !GameData.getEntType('TreasureChestEmpty')) {
        GameData.load(dataDir);
    }
    if (!NpcLoader.getNpcsForLevel('SwampRoadNorth').length) {
        NpcLoader.load(dataDir);
    }
}

function createClient(levelInstanceId: string, roomId: number): FakeClient {
    return {
        token: Math.floor(Math.random() * 100000) + 43800,
        currentLevel: 'SRN_Mission2',
        levelInstanceId,
        currentRoomId: roomId,
        playerSpawned: true,
        character: {
            name: `YornakStats-${levelInstanceId}`,
            CurrentLevel: { name: 'SRN_Mission2', x: 0, y: 0 }
        },
        entities: new Map<number, any>(),
        dungeonRun: null
    };
}

function addEntity(client: FakeClient, entity: any): void {
    client.entities.set(Number(entity.id), entity);
    const levelScope = getClientLevelScope(client as never);
    let levelEntities = GlobalState.levelEntities.get(levelScope);
    if (!levelEntities) {
        levelEntities = new Map<number, any>();
        GlobalState.levelEntities.set(levelScope, levelEntities);
    }
    levelEntities.set(Number(entity.id), entity);
}

function removeClient(client: FakeClient): void {
    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.levelEntities.delete(getClientLevelScope(client as never));
}

function hostile(id: number, name: string, roomId: number, rank: string = 'Minion'): any {
    return {
        id,
        name,
        roomId,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: rank,
        hp: 10,
        maxHp: 10,
        entState: 0,
        clientSpawned: true
    };
}

function chest(id: number, roomId: number): any {
    return {
        id,
        name: 'TreasureChestEmpty',
        roomId,
        isPlayer: false,
        team: 0,
        hp: 1,
        maxHp: 1,
        entState: 0,
        clientSpawned: true
    };
}

function dead(entity: any): any {
    return {
        ...entity,
        hp: 0,
        dead: true,
        entState: EntityState.DEAD
    };
}

function statsFor(client: FakeClient): NonNullable<ReturnType<typeof getActiveDungeonRunStats>> {
    const stats = getActiveDungeonRunStats(client as never);
    assert.ok(stats, 'client should have active dungeon run stats');
    return stats!;
}

async function testYornakBossRoomAddsAndChestDoNotPenalizeRank(): Promise<void> {
    const roomId = 18;
    const client = createClient('boss-room', roomId);
    const boss = hostile(43801, 'SwampKing', roomId, 'Boss');
    const deathEye = hostile(43802, 'NephitLeftEye', roomId, 'Lieutenant');
    const bossChest = chest(43803, roomId);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, boss);
    addEntity(client, deathEye);
    addEntity(client, bossChest);

    try {
        syncClientDungeonRunState(client as never);
        noteDungeonRunBossCutscene(getClientLevelScope(client as never), roomId, boss.id);
        noteDungeonRunKill(getClientLevelScope(client as never), [client.character.name], boss.id, dead(boss));
        noteDungeonRunKill(getClientLevelScope(client as never), [client.character.name], deathEye.id, dead(deathEye));
        noteDungeonRunChestOpened(client as never, bossChest.id, bossChest);

        const stats = statsFor(client);
        assert.equal(stats.totalEnemiesEligible, 1, 'Yornak boss room should only count Lord Yornak as eligible');
        assert.equal(stats.killedEnemies, 1, 'killing Lord Yornak should satisfy the boss-room enemy budget');
        assert.equal(stats.skippedEnemies, 0, 'unkilled Yornak boss adds should not reduce kill rank');
        assert.equal(stats.totalChestsEligible, 0, 'Yornak boss room chest should not count toward treasure rank');
        assert.equal(stats.openedChests, 0, 'opening the boss room chest should not change treasure rank');
    } finally {
        removeClient(client);
    }
}

async function testYornakNormalChestStillCountsBeforeBossRoom(): Promise<void> {
    const roomId = 12;
    const client = createClient('pre-boss-chest', roomId);
    const normalChest = chest(43811, roomId);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, normalChest);

    try {
        syncClientDungeonRunState(client as never);
        noteDungeonRunChestOpened(client as never, normalChest.id, normalChest);

        const stats = statsFor(client);
        assert.equal(stats.totalChestsEligible, 1, 'normal Yornak chests before the boss room should still count');
        assert.equal(stats.openedChests, 1, 'opened normal Yornak chests should still award treasure credit');
    } finally {
        removeClient(client);
    }
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testYornakBossRoomAddsAndChestDoNotPenalizeRank();
    await testYornakNormalChestStillCountsBeforeBossRoom();
    console.log('yornak_dungeon_stats_regression: ok');
}

void main().catch((error) => {
    console.error('yornak_dungeon_stats_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
