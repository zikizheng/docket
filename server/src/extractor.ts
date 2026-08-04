import { TextractClient, AnalyzeExpenseCommand } from "@aws-sdk/client-textract";
import { isValidAbn } from "../../shared/abn.ts";
import type { DraftInvoice } from "../../shared/types.ts"
import { parse, isValid, format } from "date-fns";

const CONFIDENCE_THRESHOLD = 90;

/**
 * Below this, a field reading is treated as noise rather than a real (if imperfect) OCR
 * result. Low enough that a correctly-identified vendor name (which often sits next to a
 * logo/stylised header and scores lower than plain body text) doesn't get discarded.
 */
const MIN_TRUSTWORTHY_CONFIDENCE = 50;

export interface InvoiceExtractor {
    extract(file: Buffer): Promise<DraftInvoice>;
}

export class StubExtractor implements InvoiceExtractor {
    async extract(_file: Buffer): Promise<DraftInvoice> {
        return {
            supplierName: "Acme Staging Pty Ltd",
            abn: "51824753556",
            amount: 1000,
            gstCharged: true,
            invoiceNumber: "1",
            invoiceDate: "2026-02-12",
            missing: [],
            lowConfidence: [],
        };
    }
}

export class TextractExtractor implements InvoiceExtractor {
    private client: TextractClient;

    constructor(region: string) {
        this.client = new TextractClient({ region });
    }

    async extract(file: Buffer): Promise<DraftInvoice> {
        const response = await this.client.send(
            new AnalyzeExpenseCommand({ Document: { Bytes: file } })
        );
        return mapExpenseResponse(response);
    }
}

export function mapExpenseResponse(response: any): DraftInvoice {
    const doc = response?.ExpenseDocuments?.[0];
    const summary: any[] = doc?.SummaryFields ?? [];
    const missing: string[] = [];

    const bestField = (types: string[]): { text: string; confidence: number } | null => {
        for (const type of types) {
            const matches = summary
                .filter((f) => f?.Type?.Text === type && f?.ValueDetection?.Text?.trim())
                .sort((a, b) => (b.ValueDetection.Confidence ?? 0) - (a.ValueDetection.Confidence ?? 0));
            if (matches.length > 0) {
                return {
                    text: matches[0].ValueDetection.Text.trim(),
                    confidence: matches[0].ValueDetection.Confidence ?? 0,
                };
            }
        }
        return null;
    };

    /**
     * Like bestField, but for fields where the correct candidate is conventionally the one
     * nearest the top of the page (the vendor name, printed in the letterhead). Textract's
     * per-candidate confidence reflects OCR fidelity, not which candidate is semantically
     * correct — a cleanly-printed decoy elsewhere on the page (e.g. a legal entity name quoted
     * in payment instructions) can out-score the real header, so position wins by default,
     * and confidence only breaks in when the topmost candidate is too garbled to trust at all.
     *
     * Position alone isn't enough either: a logo mark (e.g. stylised initials inside a badge
     * graphic) can sit higher on the page than the real name printed below it. A real business
     * name tends to be printed more than once on an invoice (letterhead, footer, payment
     * details); a logo mark is normally a one-off. So candidates are first ranked by how many
     * times their (normalised) text recurs among the trustworthy candidates, and only ties are
     * broken by position.
     */
    const bestFieldByPosition = (types: string[]): { text: string; confidence: number } | null => {
        const top = (f: any): number => f?.ValueDetection?.Geometry?.BoundingBox?.Top ?? Number.POSITIVE_INFINITY;
        const confidence = (f: any): number => f?.ValueDetection?.Confidence ?? 0;
        const normalise = (f: any): string => f.ValueDetection.Text.trim().toLowerCase().replace(/\s+/g, " ");

        for (const type of types) {
            const matches = summary.filter((f) => f?.Type?.Text === type && f?.ValueDetection?.Text?.trim());
            if (matches.length === 0) continue;

            const trustworthy = matches.filter((f) => confidence(f) >= MIN_TRUSTWORTHY_CONFIDENCE);

            let ranked;
            if (trustworthy.length > 0) {
                const occurrences = new Map<string, number>();
                for (const f of trustworthy) occurrences.set(normalise(f), (occurrences.get(normalise(f)) ?? 0) + 1);

                ranked = trustworthy.sort((a, b) => {
                    const byOccurrences = occurrences.get(normalise(b))! - occurrences.get(normalise(a))!;
                    return byOccurrences !== 0 ? byOccurrences : top(a) - top(b);
                });
            } else {
                ranked = matches.sort((a, b) => confidence(b) - confidence(a));
            }

            return { text: ranked[0].ValueDetection.Text.trim(), confidence: confidence(ranked[0]) };
        }
        return null;
    };

    const supplierField = bestFieldByPosition(["VENDOR_NAME", "SUPPLIER_NAME"]);
    const totalField = bestField(["TOTAL", "AMOUNT_DUE", "AMOUNT_PAID"]);
    const gstField = bestField(["TAX", "GST"]);
    const invoiceNumberField = bestField(["INVOICE_RECEIPT_ID"]);
    const invoiceDateField = bestField(["INVOICE_RECEIPT_DATE"]);

    const allText = collectText(doc);

    const supplierName = supplierField?.text ?? null;
    const amount = parseMoney(totalField?.text ?? null) ?? findLargestDollarAmount(collectText(doc));
    const gst = parseMoney(gstField?.text ?? null);
    const invoiceNumber = invoiceNumberField?.text ?? null;
    const invoiceDate = parseInvoiceDate(invoiceDateField?.text ?? null);
    const abn = findAbn(allText);

    const gstCharged = detectGst(gst, amount, allText);


    if (!supplierName) missing.push("supplierName");
    if (!abn) missing.push("abn");
    if (amount === null) missing.push("amount");
    if (gstCharged === null) missing.push("gstCharged")

    const lowConfidence: string[] = [];
    if (totalField && totalField.confidence < CONFIDENCE_THRESHOLD) lowConfidence.push("amount");
    if (supplierField && supplierField.confidence < CONFIDENCE_THRESHOLD) lowConfidence.push("supplierName");

    return { supplierName, abn, amount, gstCharged, invoiceNumber, invoiceDate, missing, lowConfidence };
}

export function findAbn(text: string): string | null {
    const candidates = text.match(/\b\d[\d ]{9,14}\d\b/g) ?? [];
    for (const candidate of candidates) {
        const digits = candidate.replace(/\D/g, "");
        if (digits.length === 11 && isValidAbn(digits)) return digits;
    }
    return null;
}

export function parseMoney(value: string | null): number | null {
    if (!value) return null;
    // Match: optional minus, optional $, digits with optional thousands separators, optional cents.
    const pattern = /(-?)\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/;
    const match = value.match(pattern);
    if (!match) return null;

    const [, sign, whole, cents = "0"] = match;
    const n = Number.parseFloat(`${whole.replace(/,/g, "")}.${cents.padEnd(2, "0")}`);
    if (!Number.isFinite(n)) return null;
    return sign === "-" ? -n : n;
}

export function amountForLabel(text: string, label: RegExp): number | null {
    const lines = text.split("\n").map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
        if (!label.test(lines[i])) continue;
        const sameLine = parseMoney(lines[i].replace(label, ""));
        if (sameLine !== null) return sameLine;
        if (i + 1 < lines.length) {
            const nextLine = parseMoney(lines[i + 1]);
            if (nextLine !== null) return nextLine;
        }
    }
    return null;
}

const GST_DIVISOR = 11

export function detectGst(taxAmount: number | null, total: number | null, text: string): boolean | null {
    if (taxAmount !== null) return taxAmount > 0;

    const labelled = amountForLabel(text, /\bGST\b/i);
    if (labelled !== null) return labelled > 0;

    if (/\b(no|not|excl(?:uding)?|exempt)\b[^.\n]{0,20}\bGST\b/i.test(text)) return false;
    if (/\bGST\b/i.test(text)) return true;

    if (total !== null && total > 0) {
        const expected = total / GST_DIVISOR;
        const figures = (text.match(/\d+(?:,\d{3})*(?:\.\d{2})?/g) ?? [])
            .map((f) => Number(f.replace(/,/g, "")))
            .filter(Number.isFinite);
        if (figures.some((f) => Math.abs(f - expected) < 0.02)) return true;
    }
    return null;
}

export function findLargestDollarAmount(text: string): number | null {
    const matches = text.match(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\$\s*\d+(?:\.\d{2})?/g);
    if (!matches) return null;
    const values = matches.map((m) => parseMoney(m)).filter((n): n is number => n !== null);
    return values.length > 0 ? Math.max(...values) : null;
}


function collectText(doc: any): string {
    const parts: string[] = [];
    for (const f of doc?.SummaryFields ?? []) {
        if (f?.LabelDetection?.Text) parts.push(f.LabelDetection.Text);
        if (f?.ValueDetection?.Text) parts.push(f.ValueDetection.Text);
    }
    for (const group of doc?.LineItemGroups ?? []) {
        for (const item of group?.LineItems ?? []) {
            for (const f of item?.LineItemExpenseFields ?? []) {
                if (f?.LabelDetection?.Text) parts.push(f.LabelDetection.Text);
                if (f?.ValueDetection?.Text) parts.push(f.ValueDetection.Text)
            }
        }
    }
    return parts.join("\n");
}

const DATE_FORMATS = [
    "yyyy-MM-dd",
    "dd/MM/yyyy", "d/M/yyyy",
    "dd/MM/yy", "d/M/yy",
    "dd-MM-yyyy", "d-M-yyyy",
    "dd.MM.yyyy", "d.M.yyyy",
    "dd-MMM-yyyy", "d-MMM-yyyy",
    "dd-MMM-yy", "d-MMM-yy",
    "d MMMM yyyy", "d MMM yyyy", "dd MMM yyyy",
    "MMMM d, yyyy", "MMM d, yyyy",
];

export function parseInvoiceDate(value: string | null): string | null {
    if (!value) return null;
    const cleaned = value.trim();

    const match = cleaned.match(
        /\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}[\s\-.]+[A-Za-z]{3,9}[\s\-.,]+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/
    );
    const candidate = match ? match[0] : cleaned;

    for (const fmt of DATE_FORMATS) {
        const parsed = parse(candidate, fmt, new Date());
        if (isValid(parsed) && format(parsed, fmt).toLowerCase() === candidate.toLowerCase()) {
            return format(parsed, "yyyy-MM-dd");
        }
    }
    return null;
}