import Database from "better-sqlite3";
import type { Invoice, VerificationResult } from "../../shared/types.ts";
import type { StoredInvoice } from "../../shared/types.ts";

export const db = new Database(process.env.DB_PATH ?? "invoices.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_name TEXT NOT NULL,
    abn TEXT NOT NULL,
    amount REAL NOT NULL,
    gst_charged INTEGER NOT NULL,
    registered_name TEXT NOT NULL,
    decision TEXT NOT NULL,
    flags TEXT NOT NULL,
    checked_at TEXT NOT NULL
  )
`);

const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(invoices)`).all() as { name: string }[]).map((c) => c.name)
);
if (!existingColumns.has("invoice_number")) {
    db.exec(`ALTER TABLE invoices ADD COLUMN invoice_number TEXT`);
}
if (!existingColumns.has("invoice_date")) {
    db.exec(`ALTER TABLE invoices ADD COLUMN invoice_date TEXT`);
}

const insertStmt = db.prepare(`
  INSERT INTO invoices (supplier_name, abn, amount, gst_charged, registered_name, decision, flags, checked_at, invoice_number, invoice_date)
  VALUES (@supplierName, @abn, @amount, @gstCharged, @registeredName, @decision, @flags, @checkedAt, @invoiceNumber, @invoiceDate)
`);

export function saveInvoice(invoice: Invoice, result: VerificationResult): StoredInvoice {
    const registeredName = result.record?.entityName ?? null;
    const info = insertStmt.run({
        supplierName: invoice.supplierName,
        abn: invoice.abn,
        amount: invoice.amount,
        gstCharged: invoice.gstCharged ? 1 : 0,
        registeredName,
        decision: result.decision,
        flags: JSON.stringify(result.flags),
        checkedAt: result.checkedAt,
        invoiceNumber: invoice.invoiceNumber ?? null,
        invoiceDate: invoice.invoiceDate ?? null,
    });
    return { id: Number(info.lastInsertRowid), ...invoice, registeredName, decision: result.decision, flags: result.flags, checkedAt: result.checkedAt };
}

const listStmt = db.prepare(`SELECT * FROM invoices ORDER BY id DESC LIMIT 100`);

export function listInvoices(): StoredInvoice[] {
    return listStmt.all().map((row: any) => ({
        id: row.id,
        supplierName: row.supplier_name,
        abn: row.abn,
        amount: row.amount,
        gstCharged: row.gst_charged === 1,
        registeredName: row.registered_name,
        decision: row.decision,
        flags: JSON.parse(row.flags),
        checkedAt: row.checked_at,
        invoiceNumber: row.invoice_number ?? undefined,
        invoiceDate: row.invoice_date ?? undefined,
    }));
}

const deleteStmt = db.prepare(`DELETE FROM invoices WHERE id = ?`);

export function deleteInvoice(id: number): boolean {
    const info = deleteStmt.run(id);
    return info.changes > 0;
}

const clearStmt = db.prepare(`DELETE FROM invoices`);

export function clearInvoices(): number {
    const info = clearStmt.run();
    return info.changes;
}

const exportStmt = db.prepare(`SELECT * FROM invoices ORDER BY id DESC`);

const CSV_HEADERS = [
    "ID", "Supplier Name", "Registered Name", "ABN", "Invoice Number",
    "Invoice Date", "Amount", "GST Charged", "Decision", "Flags", "Checked At",
];

function csvCell(value: string): string {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function exportInvoicesCsv(): string {
    const rows = exportStmt.all() as any[];
    const lines = [CSV_HEADERS.map(csvCell).join(",")];
    for (const row of rows) {
        const flags = (JSON.parse(row.flags) as { message: string }[])
            .map((f) => f.message)
            .join("; ");
        lines.push([
            row.id,
            row.supplier_name,
            row.registered_name ?? "",
            row.abn,
            row.invoice_number ?? "",
            row.invoice_date ?? "",
            row.amount,
            row.gst_charged === 1 ? "Yes" : "No",
            row.decision,
            flags,
            row.checked_at,
        ].map((v) => csvCell(String(v))).join(","));
    }
    return lines.join("\r\n");
}