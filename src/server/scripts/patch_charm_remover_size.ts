import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const DATA_DIR = path.resolve(__dirname, "..", "data");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

const CHARM_NAME = "CharmRemover";
const DISPLAY_SIZE = "9";

type PatchResult = {
  text: string;
  changes: number;
};

function replaceCharmSizeXml(text: string): PatchResult {
  let changes = 0;
  const patched = text.replace(/<CharmType\s+CharmName="([^"]+)">[\s\S]*?<\/CharmType>/g, (block, charmName: string) => {
    if (charmName !== CHARM_NAME) {
      return block;
    }

    return block.replace(/(<CharmSize>)([\s\S]*?)(<\/CharmSize>)/, (match, prefix: string, oldValue: string, suffix: string) => {
      if (oldValue.trim() === DISPLAY_SIZE) {
        return match;
      }
      changes += 1;
      return `${prefix}${DISPLAY_SIZE}${suffix}`;
    });
  });

  return { text: patched, changes };
}

function replaceCharmSizeJsonText(text: string): PatchResult {
  let changes = 0;
  const patched = text.replace(
    /("CharmName"\s*:\s*"CharmRemover"[\s\S]*?"CharmSize"\s*:\s*")([^"]*)(")/,
    (match, prefix: string, oldValue: string, suffix: string) => {
      if (oldValue.trim() === DISPLAY_SIZE) {
        return match;
      }
      changes += 1;
      return `${prefix}${DISPLAY_SIZE}${suffix}`;
    },
  );

  return { text: patched, changes };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = replaceCharmSizeXml(original);
  if (!verifyOnly && patched.text !== original) {
    fs.writeFileSync(filePath, patched.text, "utf8");
  }
  return patched.changes;
}

function patchCharmsJson(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(original);
  let changes = 0;

  for (const charm of Array.isArray(data) ? data : Object.values(data)) {
    if (!charm || typeof charm !== "object") {
      continue;
    }
    const record = charm as Record<string, unknown>;
    if (String(record.CharmName ?? "") !== CHARM_NAME || String(record.CharmSize ?? "") === DISPLAY_SIZE) {
      continue;
    }
    record.CharmSize = DISPLAY_SIZE;
    changes += 1;
  }

  if (!verifyOnly && changes > 0) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 4)}\n`, "utf8");
  }

  return changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  const charmChunk = ctx.chunks.find((entry) => entry.xml.includes("<CharmTypes") || entry.xml.includes('"CharmName"'));
  if (!charmChunk) {
    return 0;
  }

  const patched = charmChunk.xml.includes("<CharmTypes")
    ? replaceCharmSizeXml(charmChunk.xml)
    : replaceCharmSizeJsonText(charmChunk.xml);
  if (!verifyOnly && patched.text !== charmChunk.xml) {
    charmChunk.xml = patched.text;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }
  return patched.changes;
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify") || args.includes("--dry-run");
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  const changes =
    patchXmlFile(path.join(XML_DIR, "CharmTypes.xml"), verifyOnly) +
    patchCharmsJson(path.join(DATA_DIR, "Charms.json"), verifyOnly) +
    swzPaths.reduce((total, swzPath) => total + patchSwzFile(swzPath, verifyOnly), 0);

  console.log(JSON.stringify({ verifyOnly, swzPaths, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
