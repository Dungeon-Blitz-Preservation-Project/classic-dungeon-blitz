import * as fs from 'fs';
import * as path from 'path';
import { readJsonFile } from '../utils/JsonFile';

export class PetConfig {
    static PET_TYPES: any[] = [];
    static EGG_TYPES: any[] = [];
    private static readonly STANDARD_EGG_COLORS = ['Red', 'Yellow', 'Blue', 'Green'];
    private static readonly EGG_EXCLUDED_PET_CLASS: Record<string, string> = {
        Generic: 'Ancient',
        Common: 'Bird',
        Ordinary: 'Ghost',
        Plain: 'Dragon'
    };
    private static readonly EGG_FIXED_PET_CLASSES = new Set(['Dragon', 'Bird', 'Ancient', 'Ghost']);
    
    // Constants from class_16 (pets.py)
    static NEW_EGG_SET_TIME = 72000; // 20 hours
    static EGG_HATCH_MAX_TIME = 7 * 24 * 60 * 60;
    static EGG_HATCH_TIMES = {
        0: 259200, // 3 days
        1: 432000, // 5 days
        2: 604800  // 7 days
    };
    static MAX_EGG_SLOTS = 8;
    static EGG_GOLD_COST = [0, 5000, 25000, 50000, 75000, 250000, 500000, 750000];
    static EGG_IDOL_COST = [0, 3, 13, 25, 37, 60, 94, 119];

    // Constants from class_7 (pets.py)
    static TRAINING_TIME = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    static TRAINING_GOLD_COST = [0, 0, 2000, 4000, 6000, 8000, 10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000,100000, 200000, 300000, 400000, 500000, 600000];
    static TRAINING_IDOL_COST = [0, 0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 38, 39, 40, 54, 67, 80, 94, 107];
    
    // XP Thresholds
    static PET_XP_THRESHOLDS = [
        0, 4000, 12500, 24200, 39400, 57300, 78800, 103200, 130100, 158800, 
        192100, 229000, 272100, 320300, 375500, 434600, 501100, 573800, 605300, 744100
    ];

    static load(dataDir: string) {
        try {
            const petsPath = path.join(dataDir, 'pet_types.json');
            PetConfig.PET_TYPES = readJsonFile<any[]>(petsPath);
            console.log(`[PetConfig] Loaded ${PetConfig.PET_TYPES.length} pets.`);
        } catch (err) {
            console.error(`[PetConfig] Failed to load pet_types.json:`, err);
        }

        try {
            const eggsPath = path.join(dataDir, 'egg_types.json');
            PetConfig.EGG_TYPES = readJsonFile<any[]>(eggsPath);
            console.log(`[PetConfig] Loaded ${PetConfig.EGG_TYPES.length} eggs.`);
        } catch (err) {
            console.error(`[PetConfig] Failed to load egg_types.json:`, err);
        }
    }

    static getPetDef(petId: number) {
        const normalizedPetId = Number(petId ?? 0);
        return PetConfig.PET_TYPES.find((p) => Number(p?.PetID ?? 0) === normalizedPetId);
    }

    static getEggDef(eggId: number) {
         const normalizedEggId = Number(eggId ?? 0);
         return PetConfig.EGG_TYPES.find((e) => Number(e?.EggID ?? 0) === normalizedEggId);
    }

    static getEggDefByName(eggName: string) {
        const normalizedEggName = String(eggName ?? '').trim();
        return PetConfig.EGG_TYPES.find((egg) => String(egg?.EggName ?? '') === normalizedEggName);
    }

    static getHatchablePetsForEgg(eggId: number): any[] {
        return PetConfig.getHatchablePetsForEggDef(PetConfig.getEggDef(eggId));
    }

    static getHatchablePetsForEggName(eggName: string): any[] {
        return PetConfig.getHatchablePetsForEggDef(PetConfig.getEggDefByName(eggName));
    }

    static resolveRandomPetForEgg(eggId: number, randomValue = Math.random()): any | undefined {
        return PetConfig.resolveRandomPetFromPool(PetConfig.getHatchablePetsForEgg(eggId), randomValue);
    }

    static resolveRandomPetForEggName(eggName: string, randomValue = Math.random()): any | undefined {
        return PetConfig.resolveRandomPetFromPool(PetConfig.getHatchablePetsForEggName(eggName), randomValue);
    }

    static getEggHatchTime(rank: number): number {
        const normalizedRank = Math.max(0, Math.floor(Number(rank ?? 0)));
        const hatchTime = Number(PetConfig.EGG_HATCH_TIMES[normalizedRank as 0 | 1 | 2] ?? PetConfig.EGG_HATCH_MAX_TIME);
        return Math.max(0, Math.min(hatchTime, PetConfig.EGG_HATCH_MAX_TIME));
    }

    private static getHatchablePetsForEggDef(eggDef: any): any[] {
        if (!eggDef) {
            return [];
        }

        const eggClassType = String(eggDef?.ClassType ?? '').trim();
        const eggColor = String(eggDef?.Color ?? '').trim();
        const allowedColors = PetConfig.getAllowedEggColors(eggColor);
        const fixedPetClass = PetConfig.EGG_FIXED_PET_CLASSES.has(eggClassType) ? eggClassType : null;
        const excludedPetClass = fixedPetClass ? null : PetConfig.EGG_EXCLUDED_PET_CLASS[eggClassType] ?? null;

        return PetConfig.PET_TYPES.filter((pet) => {
            const petId = Number(pet?.PetID ?? 0);
            if (petId <= 0 || Boolean(pet?.UseVanityPower)) {
                return false;
            }

            const petClassType = String(pet?.ClassType ?? '').trim();
            const petColor = String(pet?.Color ?? '').trim();
            if (!allowedColors.includes(petColor)) {
                return false;
            }
            if (fixedPetClass) {
                return petClassType === fixedPetClass;
            }
            if (excludedPetClass) {
                return petClassType !== excludedPetClass;
            }
            return true;
        });
    }

    private static getAllowedEggColors(color: string): string[] {
        if (color === 'Brown' || color === 'White') {
            return PetConfig.STANDARD_EGG_COLORS;
        }
        return PetConfig.STANDARD_EGG_COLORS.includes(color)
            ? [color]
            : [];
    }

    private static resolveRandomPetFromPool(pets: any[], randomValue: number): any | undefined {
        if (pets.length === 0) {
            return undefined;
        }

        const normalizedRandom = Number.isFinite(randomValue) ? Math.max(0, Math.min(randomValue, 0.999999999)) : 0;
        return pets[Math.floor(normalizedRandom * pets.length)] ?? pets[0];
    }
}
