import type { Invoice, StoredInvoice, DraftInvoice } from "../../shared/types"

export class QuotaExhaustedError extends Error { }

export interface ExtractionResult {
    draft: DraftInvoice;
    remaining: number | null;
}

export async function verifyInvoice(invoice: Invoice): Promise<StoredInvoice> {
    const res = await fetch("api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invoice),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
    }
    return res.json();
}

export async function listInvoices(): Promise<StoredInvoice[]> {
    const res = await fetch("/api/invoices");
    if (!res.ok) {
        throw new Error(`Couldn't load invoices (${res.status})`);
    }
    return res.json();
}

export async function extractInvoice(file: File): Promise<ExtractionResult> {
    const body = new FormData();
    body.append("file", file);

    const res = await fetch("/api/extract", { method: "POST", body });

    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const message = payload.error ?? `Extraction failed (${res.status})`;
        // Only the daily quota (tagged QUOTA_EXCEEDED) should lock the upload UI — a plain
        // per-minute rate limit is also a 429, but is transient and shouldn't look the same.
        throw payload.code === "QUOTA_EXCEEDED" ? new QuotaExhaustedError(message) : new Error(message);
    }

    const header = res.headers.get("X-Quota-Remaining");
    return { draft: await res.json(), remaining: header ? Number(header) : null }
}

export async function fetchQuota(): Promise<number> {
    const res = await fetch("/api/quota");
    if (!res.ok) throw new Error("Couldn't load quota.");
    const data = await res.json();
    return data.remaining;
}

export async function deleteInvoice(id: number): Promise<void> {
    const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Couldn't delete invoice (${res.status})`);
    }
}

export async function clearInvoices(): Promise<void> {
    const res = await fetch("/api/invoices", { method: "DELETE" });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Couldn't clear invoices (${res.status})`);
    }
}