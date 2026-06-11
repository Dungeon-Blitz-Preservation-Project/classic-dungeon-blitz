import * as path from 'path';
import { Client } from '../core/Client';
import { Config } from '../core/config';
import { GameData } from '../core/GameData';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CharmID } from '../data/runtime/Charms';
import { ConsumableID, ConsumableType } from '../data/runtime/Consumables';
import { PetHandler } from './PetHandler';
import { sendConsumableUpdate } from '../utils/ConsumableState';
import { normalizeCharacterMaterials } from '../utils/MaterialInventory';

const db = new JsonAdapter();

type ForgeState = {
    primary: number;
    secondary: number;
    secondary_tier: number;
    usedlist: number;
    ReadyTime: number;
    forge_roll_a: number;
    forge_roll_b: number;
    is_extended_forge: boolean;
    stats_by_building: Record<string, number>;
    [key: string]: unknown;
};

export class ForgeHandler {
    private static readonly FORGE_REROLL_COSTS = [1, 2, 3, 4, 5, 7, 10, 13, 16, 20] as const;
    private static readonly FORGE_DURATIONS_BY_SIZE = [1800, 4800, 10800, 21600, 36000, 64800, 96000, 144000, 192000, 288000] as const;
    private static readonly FORGE_XP_BY_SIZE = [8, 22, 50, 101, 171, 310, 462, 697, 945, 1442] as const;
    private static readonly CRAFT_XP_MULTIPLIER = 0.03;
    private static readonly BASE_CRAFT_TIME_BONUS_PERCENT = 5;
    private static readonly CRAFT_TIME_BONUS_PER_POINT = 0.5;
    private static readonly TIME_REDUCTION_MULTIPLIER = 0.01;
    private static readonly EXTENDED_FORGE_DURATION_SECONDS = 345600;
    private static readonly RESPEC_STONE_BASE_DURATION_SECONDS = 180;
    private static readonly CHARM_REMOVER_DURATION_SECONDS = 86400;
    private static readonly FORGE_XP_CAP = 159_948;
    private static readonly DEFAULT_FORGE_XP_GAIN = 4000;
    private static readonly completionTimers = new Map<string, NodeJS.Timeout>();
    private static readonly PRIMARY_TYPE_TO_SECONDARY: Record<string, number> = {
        Trog: 1,
        Infernal: 2,
        Undead: 3,
        Mythic: 4,
        Draconic: 5,
        Sylvan: 6,
        Melee: 7,
        Magic: 8,
        Armor: 9
    };

    private static ensureGameDataLoaded(): void {
        if (GameData.CHARMS.length > 0 && GameData.CONSUMABLES.length > 0 && GameData.MATERIALS.length > 0) {
            return;
        }

        GameData.load(path.join(Config.DATA_DIR, 'data'));
    }

    private static getNowSeconds(): number {
        return Math.floor(Date.now() / 1000);
    }

    private static getCompletionTimerKey(userId: number | null, characterName: string | null | undefined): string {
        return `${Number(userId ?? 0)}:${String(characterName ?? '').trim().toLowerCase()}`;
    }

    private static clearCompletionTimer(userId: number | null, characterName: string | null | undefined): void {
        const key = ForgeHandler.getCompletionTimerKey(userId, characterName);
        const timer = ForgeHandler.completionTimers.get(key);
        if (!timer) {
            return;
        }

        clearTimeout(timer);
        ForgeHandler.completionTimers.delete(key);
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }

    private static getCharacterCharmEntry(charmId: number): any | null {
        ForgeHandler.ensureGameDataLoaded();
        return GameData.CHARMS.find((entry) => Number(entry?.CharmID ?? 0) === charmId) ?? null;
    }

    private static getConsumableEntry(consumableId: number): any | null {
        ForgeHandler.ensureGameDataLoaded();
        return GameData.CONSUMABLES.find((entry) => Number(entry?.ConsumableID ?? 0) === consumableId) ?? null;
    }

    private static getMaterialEntry(materialId: number): any | null {
        ForgeHandler.ensureGameDataLoaded();
        return GameData.MATERIALS.find((entry) => Number(entry?.MaterialID ?? 0) === materialId) ?? null;
    }

    private static ensureForgeState(character: any): ForgeState {
        const current = character?.magicForge;
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            character.magicForge = {
                stats_by_building: {}
            };
        }

        if (!character.magicForge.stats_by_building || typeof character.magicForge.stats_by_building !== 'object' || Array.isArray(character.magicForge.stats_by_building)) {
            character.magicForge.stats_by_building = {};
        }

        return character.magicForge as ForgeState;
    }

    private static normalizeCraftTalentPoints(character: any): number[] {
        const points = Array.isArray(character?.craftTalentPoints) ? character.craftTalentPoints.slice(0, 5) : [];
        while (points.length < 5) {
            points.push(0);
        }
        return points.map((value: unknown) => Math.max(0, Number(value ?? 0)));
    }

    private static getCharmSize(primaryId: number): number {
        const charm = ForgeHandler.getCharacterCharmEntry(primaryId);
        const size = Number(charm?.CharmSize ?? 1);
        return Math.max(1, Math.min(size || 1, 10));
    }

    private static getCraftTimeBonusPercent(character: any): number {
        const points = ForgeHandler.normalizeCraftTalentPoints(character);
        const timePoints = Number(points[0] ?? 0);
        const totalBonus = ForgeHandler.BASE_CRAFT_TIME_BONUS_PERCENT + (ForgeHandler.CRAFT_TIME_BONUS_PER_POINT * timePoints);
        return Math.max(0, Math.min(totalBonus, 50));
    }

    private static computeForgeDurationSeconds(character: any, primaryId: number, forgeFlags: { is_extended_forge: boolean }): number {
        if (primaryId === CharmID.RespecStone) {
            return forgeFlags.is_extended_forge
                ? ForgeHandler.EXTENDED_FORGE_DURATION_SECONDS
                : ForgeHandler.RESPEC_STONE_BASE_DURATION_SECONDS;
        }

        if (primaryId === CharmID.CharmRemover) {
            return ForgeHandler.CHARM_REMOVER_DURATION_SECONDS;
        }

        const size = ForgeHandler.getCharmSize(primaryId);
        const baseDuration = ForgeHandler.FORGE_DURATIONS_BY_SIZE[size - 1] ?? ForgeHandler.FORGE_DURATIONS_BY_SIZE[0];
        const bonusPercent = ForgeHandler.getCraftTimeBonusPercent(character);
        return Math.ceil(baseDuration * (1 - (bonusPercent * ForgeHandler.TIME_REDUCTION_MULTIPLIER)));
    }

    private static getExcludedSecondary(primaryId: number): number {
        const charm = ForgeHandler.getCharacterCharmEntry(primaryId);
        const primaryType = String(charm?.PrimaryType ?? '').trim();
        return ForgeHandler.PRIMARY_TYPE_TO_SECONDARY[primaryType] ?? 0;
    }

    private static pickSecondaryRune(
        primaryId: number,
        consumableFlags: boolean[],
        character: any,
        materialIds: number[]
    ): { secondary: number; tier: number } {
        if (primaryId === CharmID.CharmRemover) {
            return { secondary: 0, tier: 0 };
        }

        let chanceAny = 0;
        let chanceLegendary = 0;
        const catalystIds = [
            ConsumableID.MinorRareCatalyst,
            ConsumableID.MinorLegendaryCatalyst,
            ConsumableID.MajorRareCatalyst,
            ConsumableID.MajorLegendaryCatalyst
        ];

        for (const [index, consumableId] of catalystIds.entries()) {
            if (!consumableFlags[index]) {
                continue;
            }

            const consumable = ForgeHandler.getConsumableEntry(consumableId);
            chanceAny += Number(consumable?.RareBoost ?? 0);
            chanceLegendary += Number(consumable?.LegendaryBoost ?? 0);
        }

        const craftTalentPoints = ForgeHandler.normalizeCraftTalentPoints(character);
        chanceAny += Number(craftTalentPoints[1] ?? 0) * 0.9;
        chanceLegendary += Number(craftTalentPoints[1] ?? 0) * 0.4;

        let materialPoints = 0;
        for (const materialId of materialIds) {
            const material = ForgeHandler.getMaterialEntry(materialId);
            switch (String(material?.Rarity ?? 'M')) {
                case 'R':
                    materialPoints += 1.5;
                    break;
                case 'L':
                    materialPoints += 2;
                    break;
                default:
                    materialPoints += 1;
                    break;
            }
        }

        chanceAny += materialPoints * 0.99;
        chanceLegendary += materialPoints * 0.44;

        if (chanceLegendary >= 100) {
            chanceAny = 100;
        }

        chanceAny = Math.min(chanceAny, 100);
        chanceLegendary = Math.min(chanceLegendary, 100);

        const hasSecondary = (Math.random() * 100) < chanceAny;
        if (!hasSecondary) {
            return { secondary: 0, tier: 0 };
        }

        const tier = (Math.random() * 100) < chanceLegendary ? 2 : 1;
        const excludedSecondary = ForgeHandler.getExcludedSecondary(primaryId);
        const possibleSecondaries = [];

        for (let secondaryId = 1; secondaryId <= 9; secondaryId += 1) {
            if (secondaryId !== excludedSecondary) {
                possibleSecondaries.push(secondaryId);
            }
        }

        if (possibleSecondaries.length === 0) {
            return { secondary: 0, tier };
        }

        const secondary = possibleSecondaries[Math.floor(Math.random() * possibleSecondaries.length)] ?? 0;
        return { secondary, tier };
    }

    private static pickUnusedProperty(usedlist: number, primaryId: number): number | null {
        const excludedSecondary = ForgeHandler.getExcludedSecondary(primaryId);
        const availableProperties: number[] = [];

        for (let secondaryId = 1; secondaryId <= 9; secondaryId += 1) {
            if (secondaryId === excludedSecondary) {
                continue;
            }

            const bit = 1 << (secondaryId - 1);
            if ((usedlist & bit) === 0) {
                availableProperties.push(secondaryId);
            }
        }

        if (availableProperties.length === 0) {
            return null;
        }

        return availableProperties[Math.floor(Math.random() * availableProperties.length)] ?? null;
    }

    private static getForgeLevel(forgeState: ForgeState): number {
        const stats = forgeState.stats_by_building ?? {};
        const rawLevel = Number(stats['2'] ?? stats[2] ?? 1);
        return Math.max(1, Math.min(rawLevel || 1, ForgeHandler.FORGE_REROLL_COSTS.length));
    }

    private static randomRollSeed(): number {
        return Math.floor(Math.random() * 65536);
    }

    private static resetForgeState(forgeState: ForgeState): void {
        forgeState.primary = 0;
        forgeState.secondary = 0;
        forgeState.ReadyTime = 0;
        forgeState.secondary_tier = 0;
        forgeState.usedlist = 0;
        forgeState.forge_roll_a = 0;
        forgeState.forge_roll_b = 0;
        forgeState.is_extended_forge = false;
    }

    private static finalizeCompletedForgeIfNeeded(character: any): boolean {
        const forgeState = ForgeHandler.ensureForgeState(character);
        const primary = Number(forgeState.primary ?? 0);
        const readyTime = Number(forgeState.ReadyTime ?? 0);
        if (primary <= 0 || readyTime <= 0 || readyTime > ForgeHandler.getNowSeconds()) {
            return false;
        }

        forgeState.ReadyTime = 0;
        if (Number(forgeState.forge_roll_a ?? 0) === 0) {
            forgeState.forge_roll_a = ForgeHandler.randomRollSeed();
        }
        if (Number(forgeState.forge_roll_b ?? 0) === 0) {
            forgeState.forge_roll_b = ForgeHandler.randomRollSeed();
        }
        if (Number(forgeState.secondary ?? 0) > 0 && Number(forgeState.secondary_tier ?? 0) <= 0) {
            forgeState.secondary_tier = 1;
        }

        return true;
    }

    static async syncCompletionState(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        ForgeHandler.clearCompletionTimer(client.userId, client.character.name);

        const didFinalizeExpiredForge = ForgeHandler.finalizeCompletedForgeIfNeeded(client.character);
        if (didFinalizeExpiredForge) {
            await ForgeHandler.saveCharacter(client);
        }

        const forgeState = ForgeHandler.ensureForgeState(client.character);
        const primary = Number(forgeState.primary ?? 0);
        const readyTime = Number(forgeState.ReadyTime ?? 0);
        if (primary <= 0 || readyTime <= ForgeHandler.getNowSeconds()) {
            return;
        }

        const delayMs = Math.max(0, (readyTime * 1000) - Date.now());
        const timerKey = ForgeHandler.getCompletionTimerKey(client.userId, client.character.name);
        const timer = setTimeout(() => {
            void ForgeHandler.handleScheduledCompletion(client, timerKey);
        }, delayMs);
        timer.unref?.();
        ForgeHandler.completionTimers.set(timerKey, timer);
    }

    private static async handleScheduledCompletion(client: Client, timerKey: string): Promise<void> {
        if (!client.character) {
            ForgeHandler.completionTimers.delete(timerKey);
            return;
        }

        ForgeHandler.completionTimers.delete(timerKey);
        const didFinalizeExpiredForge = ForgeHandler.finalizeCompletedForgeIfNeeded(client.character);
        if (!didFinalizeExpiredForge) {
            await ForgeHandler.syncCompletionState(client);
            return;
        }

        await ForgeHandler.saveCharacter(client);

        if (client.socket.destroyed || !client.authenticated) {
            return;
        }

        ForgeHandler.sendForgeResultPacket(client, ForgeHandler.ensureForgeState(client.character));
    }

    private static sendPremiumPurchase(client: Client, itemName: string, cost: number): void {
        if (cost <= 0) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod13(itemName);
        bb.writeMethod4(cost);
        client.sendBitBuffer(0xB5, bb);
    }

    private static sendForgeResultPacket(client: Client, forgeState: ForgeState): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, Number(forgeState.primary ?? 0)), 7);
        bb.writeMethod91(Math.max(0, Math.min(Number(forgeState.forge_roll_a ?? 0), 65535)));
        bb.writeMethod91(Math.max(0, Math.min(Number(forgeState.forge_roll_b ?? 0), 65535)));

        const tier = Math.max(0, Number(forgeState.secondary_tier ?? 0));
        bb.writeMethod6(tier, 2);
        if (tier > 0) {
            bb.writeMethod6(Math.max(0, Number(forgeState.secondary ?? 0)), 5);
            bb.writeMethod6(Math.max(0, Number(forgeState.usedlist ?? 0)), 9);
        }

        client.sendBitBuffer(0xCD, bb);
    }

    static async handleStartForge(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        ForgeHandler.ensureGameDataLoaded();
        const br = new BitReader(data);
        const primary = br.readMethod20(7);
        const materialsUsed = new Map<number, number>();

        while (br.readMethod15()) {
            const materialId = br.readMethod20(7);
            const count = br.readMethod20(7);
            materialsUsed.set(materialId, Number(materialsUsed.get(materialId) ?? 0) + count);
        }

        const consumableFlags = Array.from({ length: 4 }, () => br.readMethod15());

        const materials = normalizeCharacterMaterials(client.character);
        for (const [materialId, count] of materialsUsed.entries()) {
            if (materialId <= 0 || count <= 0) {
                continue;
            }

            const entry = materials.find((material: any) => Number(material?.materialID ?? 0) === materialId);
            if (entry) {
                entry.count = Math.max(0, Number(entry.count ?? 0) - count);
            }
        }
        normalizeCharacterMaterials(client.character);

        const consumableIds = [
            ConsumableID.MinorRareCatalyst,
            ConsumableID.MinorLegendaryCatalyst,
            ConsumableID.MajorRareCatalyst,
            ConsumableID.MajorLegendaryCatalyst
        ];
        const consumables = Array.isArray(client.character.consumables) ? client.character.consumables : [];
        client.character.consumables = consumables;

        for (const [index, consumableId] of consumableIds.entries()) {
            if (!consumableFlags[index]) {
                continue;
            }

            const entry = consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId);
            if (entry) {
                entry.count = Math.max(0, Number(entry.count ?? 0) - 1);
            } else {
                consumables.push({
                    consumableID: consumableId,
                    count: 0
                });
            }

            sendConsumableUpdate(client, consumableId);
        }

        const isExtendedForge = primary === CharmID.RespecStone;
        const durationSeconds = ForgeHandler.computeForgeDurationSeconds(client.character, primary, {
            is_extended_forge: isExtendedForge
        });
        const readyTime = ForgeHandler.getNowSeconds() + durationSeconds;
        const { secondary, tier } = ForgeHandler.pickSecondaryRune(
            primary,
            consumableFlags,
            client.character,
            Array.from(materialsUsed.keys())
        );
        const usedlist = secondary >= 1 && secondary <= 9 ? (1 << (secondary - 1)) : 0;
        const forgeState = ForgeHandler.ensureForgeState(client.character);

        forgeState.primary = primary;
        forgeState.secondary = secondary;
        forgeState.ReadyTime = readyTime;
        forgeState.secondary_tier = tier;
        forgeState.usedlist = usedlist;
        forgeState.forge_roll_a = 0;
        forgeState.forge_roll_b = 0;
        forgeState.is_extended_forge = isExtendedForge;

        await ForgeHandler.saveCharacter(client);
        await ForgeHandler.syncCompletionState(client);
    }

    static async handleForgeSpeedUpPacket(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        const forgeState = ForgeHandler.ensureForgeState(client.character);
        if (Number(forgeState.primary ?? 0) <= 0) {
            return;
        }

        const didFinalizeExpiredForge = ForgeHandler.finalizeCompletedForgeIfNeeded(client.character);
        if (didFinalizeExpiredForge) {
            ForgeHandler.clearCompletionTimer(client.userId, client.character.name);
            await ForgeHandler.saveCharacter(client);
            ForgeHandler.sendForgeResultPacket(client, forgeState);
            return;
        }

        if (idolCost <= 0 || Number(client.character.mammothIdols ?? 0) < idolCost) {
            return;
        }

        ForgeHandler.clearCompletionTimer(client.userId, client.character.name);
        client.character.mammothIdols = Number(client.character.mammothIdols ?? 0) - idolCost;
        ForgeHandler.sendPremiumPurchase(client, 'Forge Speed-Up', idolCost);

        forgeState.ReadyTime = 0;
        forgeState.forge_roll_a = ForgeHandler.randomRollSeed();
        forgeState.forge_roll_b = ForgeHandler.randomRollSeed();

        await ForgeHandler.saveCharacter(client);
        ForgeHandler.sendForgeResultPacket(client, forgeState);
    }

    static async handleCollectForgeCharm(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const forgeState = ForgeHandler.ensureForgeState(client.character);
        if (Number(forgeState.primary ?? 0) <= 0) {
            return;
        }

        ForgeHandler.finalizeCompletedForgeIfNeeded(client.character);
        if (Number(forgeState.ReadyTime ?? 0) > ForgeHandler.getNowSeconds()) {
            return;
        }

        ForgeHandler.clearCompletionTimer(client.userId, client.character.name);

        const primary = Math.max(0, Number(forgeState.primary ?? 0));
        const secondary = Math.max(0, Number(forgeState.secondary ?? 0));
        const tier = Math.max(0, Number(forgeState.secondary_tier ?? 0));
        const craftedCharmId = (primary & 0x1FF) | ((secondary & 0x1F) << 9) | ((tier & 0x3) << 14);
        const charms = Array.isArray(client.character.charms) ? client.character.charms : [];
        client.character.charms = charms;

        const charmEntry = charms.find((entry: any) => Number(entry?.charmID ?? 0) === craftedCharmId);
        if (charmEntry) {
            charmEntry.count = Number(charmEntry.count ?? 0) + 1;
        } else {
            charms.push({
                charmID: craftedCharmId,
                count: 1
            });
        }

        if (primary !== CharmID.RespecStone && primary !== CharmID.CharmRemover) {
            const charmSize = ForgeHandler.getCharmSize(primary);
            const baseXp = ForgeHandler.FORGE_XP_BY_SIZE[charmSize - 1] ?? ForgeHandler.FORGE_XP_BY_SIZE[0];
            const bonusPoints = ForgeHandler.normalizeCraftTalentPoints(client.character)[4] ?? 0;
            const xpGain = Math.ceil(baseXp * (1 + (Number(bonusPoints) * ForgeHandler.CRAFT_XP_MULTIPLIER)));
            client.character.craftXP = Math.max(0, Number(client.character.craftXP ?? 0) + xpGain);
        }

        ForgeHandler.resetForgeState(forgeState);
        await ForgeHandler.saveCharacter(client);
    }

    static async handleCancelForge(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const forgeState = ForgeHandler.ensureForgeState(client.character);
        ForgeHandler.clearCompletionTimer(client.userId, client.character.name);
        ForgeHandler.resetForgeState(forgeState);
        await ForgeHandler.saveCharacter(client);
    }

    static async handleUseForgeConsumable(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        ForgeHandler.ensureGameDataLoaded();
        const br = new BitReader(data);
        const consumableId = br.readMethod20(5);
        const consumableDef = ForgeHandler.getConsumableEntry(consumableId);
        if (!consumableDef) {
            return;
        }

        if (String(consumableDef.Type ?? '') === ConsumableType.PetFood) {
            await PetHandler.handleUseConsumable(client, data);
            return;
        }

        if (String(consumableDef.Type ?? '') !== ConsumableType.ForgeXP) {
            return;
        }

        const consumables = Array.isArray(client.character.consumables) ? client.character.consumables : [];
        const entry = consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === consumableId);
        if (!entry || Number(entry.count ?? 0) <= 0) {
            return;
        }

        entry.count = Math.max(0, Number(entry.count ?? 0) - 1);
        client.character.craftXP = Math.min(
            Number(client.character.craftXP ?? 0) + Math.max(0, Number(consumableDef.ArtisanXP ?? ForgeHandler.DEFAULT_FORGE_XP_GAIN)),
            ForgeHandler.FORGE_XP_CAP
        );

        sendConsumableUpdate(client, consumableId);
        await ForgeHandler.saveCharacter(client);
    }

    static async handleAllocateMagicForgeArtisanSkillPoints(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const packedPoints = br.readMethod9();
        client.character.craftTalentPoints = Array.from({ length: 5 }, (_, index) => (packedPoints >> (index * 4)) & 0xF);
        await ForgeHandler.saveCharacter(client);
    }

    static async handleMagicForgeReroll(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        br.readMethod20(9);

        const forgeState = ForgeHandler.ensureForgeState(client.character);
        const primary = Math.max(0, Number(forgeState.primary ?? 0));
        if (primary <= 0) {
            return;
        }

        ForgeHandler.finalizeCompletedForgeIfNeeded(client.character);
        if (Number(forgeState.ReadyTime ?? 0) > ForgeHandler.getNowSeconds()) {
            return;
        }

        let usedlist = Math.max(0, Number(forgeState.usedlist ?? 0));
        const currentSecondary = Math.max(0, Number(forgeState.secondary ?? 0));
        if (currentSecondary >= 1 && currentSecondary <= 9) {
            usedlist |= (1 << (currentSecondary - 1));
        }

        const newSecondary = ForgeHandler.pickUnusedProperty(usedlist, primary);
        if (!newSecondary) {
            return;
        }

        const forgeLevel = ForgeHandler.getForgeLevel(forgeState);
        const rerollCost = ForgeHandler.FORGE_REROLL_COSTS[forgeLevel - 1] ?? ForgeHandler.FORGE_REROLL_COSTS[ForgeHandler.FORGE_REROLL_COSTS.length - 1];
        const currentIdols = Math.max(0, Number(client.character.mammothIdols ?? 0));
        if (currentIdols < rerollCost) {
            return;
        }

        client.character.mammothIdols = currentIdols - rerollCost;
        ForgeHandler.sendPremiumPurchase(client, 'Forge Reroll', rerollCost);

        const tier = Math.max(1, Number(forgeState.secondary_tier ?? 0));
        usedlist |= (1 << (newSecondary - 1));
        forgeState.secondary = newSecondary;
        forgeState.secondary_tier = tier;
        forgeState.usedlist = usedlist;

        await ForgeHandler.saveCharacter(client);
        ForgeHandler.sendForgeResultPacket(client, forgeState);
    }
}
