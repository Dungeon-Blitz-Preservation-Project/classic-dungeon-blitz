import * as fs from 'fs';
import * as path from 'path';

type PackageInfo = {
    name: string;
    version: string;
    packagePath: string;
};

function readPackageInfo(packagePath: string): PackageInfo | null {
    try {
        const raw = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: unknown; version?: unknown };
        const name = String(raw.name ?? '').trim();
        const version = String(raw.version ?? '').trim();
        if (!name || !version) {
            return null;
        }

        return { name, version, packagePath };
    } catch {
        return null;
    }
}

function resolveProjectPackage(): PackageInfo {
    const candidates = [
        path.resolve(process.cwd(), 'package.json'),
        path.resolve(process.cwd(), '..', 'package.json'),
        path.resolve(__dirname, '..', '..', '..', 'package.json'),
        path.resolve(__dirname, '..', '..', '..', '..', 'package.json')
    ];

    let fallback: PackageInfo | null = null;
    for (const candidate of [...new Set(candidates)]) {
        const info = readPackageInfo(candidate);
        if (!info) {
            continue;
        }
        if (info.name === 'dungeon-blitz-r') {
            return info;
        }
        fallback = fallback ?? info;
    }

    return fallback ?? {
        name: 'dungeon-blitz-r',
        version: process.env.npm_package_version || 'unknown',
        packagePath: ''
    };
}

const projectPackage = resolveProjectPackage();

export const ProjectInfo = {
    name: projectPackage.name,
    version: projectPackage.version,
    packagePath: projectPackage.packagePath
} as const;
