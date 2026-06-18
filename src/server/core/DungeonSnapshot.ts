import { Character } from '../database/Database';
import { LevelConfig } from './LevelConfig';

export interface StoredDungeonSnapshot {
    levelName: string;
    x?: number;
    y?: number;
    hasCoord?: boolean;
    levelInstanceId?: string;
    entryLevel?: string;
    entryX?: number;
    entryY?: number;
    entryHasCoord?: boolean;
    currentRoomId?: number;
    startedRoomIds: number[];
    questProgress?: number;
    syncAnchorStartedAt?: number;
    savedAt: number;
}

type DungeonSnapshotSource = {
    character?: Character | null;
    currentLevel?: string | null;
    levelInstanceId?: string | null;
    entryLevel?: string | null;
    entryX?: number | null;
    entryY?: number | null;
    entryHasCoord?: boolean | null;
    currentRoomId?: number | null;
    startedRoomEvents?: Set<string> | null;
    syncAnchorStartedAt?: number | null;
    clientEntID?: number | null;
    entities?: Map<number, { x?: number; y?: number }> | null;
};

const SNAPSHOT_KEY = 'DungeonSnapshot';

function normalizePositiveInteger(value: unknown): number | undefined {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return undefined;
    }

    return Math.round(numericValue);
}

function normalizePositiveTimestamp(value: unknown): number | undefined {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return undefined;
    }

    return Math.round(numericValue);
}

function normalizeQuestProgress(value: unknown): number | undefined {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return undefined;
    }

    return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function normalizeCoordinate(value: unknown): number | undefined {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return undefined;
    }

    return Math.round(numericValue);
}

function normalizeInstanceId(value: unknown): string | undefined {
    const normalized = String(value ?? '').trim();
    return normalized || undefined;
}

function normalizeLevelName(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }

    return LevelConfig.normalizeLevelName(value);
}

function normalizeStartedRoomIds(levelName: string, value: unknown): number[] {
    const roomIds = new Set<number>();
    if (!Array.isArray(value)) {
        return [];
    }

    for (const rawRoomId of value) {
        const roomId = normalizePositiveInteger(rawRoomId);
        if (roomId !== undefined) {
            roomIds.add(roomId);
        }
    }

    return Array.from(roomIds.values()).sort((left, right) => left - right);
}

function getStartedRoomIdsFromEvents(levelName: string, startedRoomEvents?: Set<string> | null): number[] {
    if (!startedRoomEvents) {
        return [];
    }

    const prefix = `${levelName}:`;
    const roomIds = new Set<number>();
    for (const eventKey of startedRoomEvents.values()) {
        if (!eventKey.startsWith(prefix)) {
            continue;
        }

        const roomId = normalizePositiveInteger(eventKey.substring(prefix.length));
        if (roomId !== undefined) {
            roomIds.add(roomId);
        }
    }

    return Array.from(roomIds.values()).sort((left, right) => left - right);
}

function getRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function getStoredDungeonSnapshot(character: Character | null | undefined): StoredDungeonSnapshot | null {
    const record = getRecord(character);
    if (!record) {
        return null;
    }

    return normalizeStoredDungeonSnapshot(record[SNAPSHOT_KEY]);
}

export function normalizeStoredDungeonSnapshot(value: unknown): StoredDungeonSnapshot | null {
    const record = getRecord(value);
    if (!record) {
        return null;
    }

    const levelName = normalizeLevelName(
        record.levelName ??
        record.currentLevel ??
        record.targetLevel ??
        record.name
    );
    if (!levelName || !LevelConfig.isDungeonLevel(levelName)) {
        return null;
    }

    const currentRoomId = normalizePositiveInteger(record.currentRoomId ?? record.syncRoomId);
    const startedRoomIds = normalizeStartedRoomIds(
        levelName,
        record.startedRoomIds ?? record.syncStartedRoomIds
    );
    if (currentRoomId !== undefined && !startedRoomIds.includes(currentRoomId)) {
        startedRoomIds.push(currentRoomId);
        startedRoomIds.sort((left, right) => left - right);
    }

    const x = normalizeCoordinate(record.x);
    const y = normalizeCoordinate(record.y);
    const hasCoord = Boolean(record.hasCoord) && x !== undefined && y !== undefined;
    const entryX = normalizeCoordinate(record.entryX ?? record.syncEntryX);
    const entryY = normalizeCoordinate(record.entryY ?? record.syncEntryY);
    const entryHasCoord = Boolean(record.entryHasCoord ?? record.syncEntryHasCoord) &&
        entryX !== undefined &&
        entryY !== undefined;
    const entryLevel = normalizeLevelName(record.entryLevel ?? record.previousLevel ?? record.syncEntryLevel);
    const questProgress = normalizeQuestProgress(record.questProgress ?? record.syncQuestProgress);

    return {
        levelName,
        ...(hasCoord ? { x, y, hasCoord } : {}),
        ...(normalizeInstanceId(record.levelInstanceId) ? { levelInstanceId: normalizeInstanceId(record.levelInstanceId) } : {}),
        ...(entryLevel ? { entryLevel } : {}),
        ...(entryHasCoord ? { entryX, entryY, entryHasCoord } : {}),
        ...(currentRoomId !== undefined ? { currentRoomId } : {}),
        startedRoomIds,
        ...(questProgress !== undefined ? { questProgress } : {}),
        ...(normalizePositiveTimestamp(record.syncAnchorStartedAt) ? { syncAnchorStartedAt: normalizePositiveTimestamp(record.syncAnchorStartedAt) } : {}),
        savedAt: normalizePositiveTimestamp(record.savedAt) ?? Date.now()
    };
}

export function createStoredDungeonSnapshot(source: DungeonSnapshotSource, now: number = Date.now()): StoredDungeonSnapshot | null {
    const character = source.character;
    const levelName = LevelConfig.normalizeLevelName(source.currentLevel || character?.CurrentLevel?.name);
    if (!levelName || !LevelConfig.isDungeonLevel(levelName)) {
        return null;
    }

    const entityId = normalizePositiveInteger(source.clientEntID);
    const entity = entityId !== undefined ? source.entities?.get(entityId) : null;
    const x = normalizeCoordinate(entity?.x);
    const y = normalizeCoordinate(entity?.y);
    const hasCoord = x !== undefined && y !== undefined;
    const currentRoomId = normalizePositiveInteger(source.currentRoomId);
    const startedRoomIds = getStartedRoomIdsFromEvents(levelName, source.startedRoomEvents);
    if (currentRoomId !== undefined && !startedRoomIds.includes(currentRoomId)) {
        startedRoomIds.push(currentRoomId);
        startedRoomIds.sort((left, right) => left - right);
    }

    const entryLevel =
        LevelConfig.resolveDungeonEntryLevel(
            levelName,
            source.entryLevel || character?.PreviousLevel?.name || character?.CurrentLevel?.name || '',
            character
        ) ||
        LevelConfig.normalizeLevelName(source.entryLevel || character?.PreviousLevel?.name);
    const entryX = normalizeCoordinate(source.entryX);
    const entryY = normalizeCoordinate(source.entryY);
    const entryHasCoord = Boolean(source.entryHasCoord) && entryX !== undefined && entryY !== undefined;
    const questProgress = normalizeQuestProgress(character?.questTrackerState);

    return {
        levelName,
        ...(hasCoord ? { x, y, hasCoord } : {}),
        ...(normalizeInstanceId(source.levelInstanceId) ? { levelInstanceId: normalizeInstanceId(source.levelInstanceId) } : {}),
        ...(entryLevel ? { entryLevel } : {}),
        ...(entryHasCoord ? { entryX, entryY, entryHasCoord } : {}),
        ...(currentRoomId !== undefined ? { currentRoomId } : {}),
        startedRoomIds,
        ...(questProgress !== undefined ? { questProgress } : {}),
        ...(normalizePositiveTimestamp(source.syncAnchorStartedAt) ? { syncAnchorStartedAt: normalizePositiveTimestamp(source.syncAnchorStartedAt) } : {}),
        savedAt: normalizePositiveTimestamp(now) ?? Date.now()
    };
}

export function setStoredDungeonSnapshot(character: Character | null | undefined, snapshot: StoredDungeonSnapshot | null): boolean {
    if (!character) {
        return false;
    }

    if (!snapshot) {
        return clearStoredDungeonSnapshot(character);
    }

    const previous = JSON.stringify(getRecord(character)?.[SNAPSHOT_KEY] ?? null);
    character[SNAPSHOT_KEY] = snapshot;
    return JSON.stringify(snapshot) !== previous;
}

export function clearStoredDungeonSnapshot(character: Character | null | undefined): boolean {
    const record = getRecord(character);
    if (!record || !(SNAPSHOT_KEY in record)) {
        return false;
    }

    delete record[SNAPSHOT_KEY];
    return true;
}
