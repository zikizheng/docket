import { db } from "./db.ts";

const EXTRACTION_DAILY_LIMIT = Number(process.env.MAX_EXTRACTIONS_PER_DAY ?? 25);
const EXTRACTION_PER_IP_DAILY_LIMIT = Number(process.env.MAX_EXTRACTIONS_PER_IP_PER_DAY ?? 10);
const ABR_LOOKUP_DAILY_LIMIT = Number(process.env.MAX_ABR_LOOKUPS_PER_DAY ?? 200);

db.exec(`
    CREATE TABLE IF NOT EXISTS daily_counters (
    kind TEXT NOT NULL,
    day TEXT NOT NULL,
    scope TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (kind, day, scope)
    )
`);

const readStmt = db.prepare(`SELECT count FROM daily_counters WHERE kind = ? AND day = ? AND scope = ?`);
const bumpStmt = db.prepare(`
    INSERT INTO daily_counters (kind, day, scope, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(kind, day, scope) DO UPDATE SET count = count + 1
`);

const today = () => new Date().toISOString().slice(0, 10);

function count(kind: string, scope: string): number {
    const row = readStmt.get(kind, today(), scope) as { count: number } | undefined;
    return row?.count ?? 0;
}

function bump(kind: string, scope: string) {
    bumpStmt.run(kind, today(), scope);
}

export function consumeExtractionQuota(ip: string): boolean {
    if (count("extract", "global") >= EXTRACTION_DAILY_LIMIT) return false;
    if (count("extract", ip) >= EXTRACTION_PER_IP_DAILY_LIMIT) return false;
    bump("extract", "global");
    bump("extract", ip);
    return true;
}

/** The lower of the global and per-IP allowances: whichever one the caller will actually hit next. */
export function remainingQuota(ip: string): number {
    const globalRemaining = EXTRACTION_DAILY_LIMIT - count("extract", "global");
    const ipRemaining = EXTRACTION_PER_IP_DAILY_LIMIT - count("extract", ip);
    return Math.max(0, Math.min(globalRemaining, ipRemaining));
}

export function consumeAbrLookupQuota(): boolean {
    if (count("abr_lookup", "global") >= ABR_LOOKUP_DAILY_LIMIT) return false;
    bump("abr_lookup", "global");
    return true;
}
