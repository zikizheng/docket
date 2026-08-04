/** Output schemas for API routes: constrain exactly which fields get serialized in each response. */

const flag = {
    type: "object",
    properties: {
        code: { type: "string" },
        message: { type: "string" },
        severity: { type: "string", enum: ["warning", "error"] },
    },
    required: ["code", "message", "severity"],
} as const;

const storedInvoice = {
    type: "object",
    properties: {
        id: { type: "integer" },
        supplierName: { type: "string" },
        abn: { type: "string" },
        amount: { type: "number" },
        gstCharged: { type: "boolean" },
        invoiceNumber: { type: "string" },
        invoiceDate: { type: "string" },
        registeredName: { type: ["string", "null"] },
        decision: { type: "string", enum: ["approved", "review", "rejected"] },
        flags: { type: "array", items: flag },
        checkedAt: { type: "string" },
    },
    required: ["id", "supplierName", "abn", "amount", "gstCharged", "registeredName", "decision", "flags", "checkedAt"],
} as const;

const draftInvoice = {
    type: "object",
    properties: {
        supplierName: { type: ["string", "null"] },
        abn: { type: ["string", "null"] },
        amount: { type: ["number", "null"] },
        gstCharged: { type: ["boolean", "null"] },
        invoiceNumber: { type: ["string", "null"] },
        invoiceDate: { type: ["string", "null"] },
        missing: { type: "array", items: { type: "string" } },
        lowConfidence: { type: "array", items: { type: "string" } },
    },
    required: ["supplierName", "abn", "amount", "gstCharged", "invoiceNumber", "invoiceDate", "missing", "lowConfidence"],
} as const;

const error = {
    type: "object",
    properties: { error: { type: "string" } },
    required: ["error"],
} as const;

/**
 * Like error, but with an optional tag the client uses to tell a real quota exhaustion apart
 * from a plain rate-limit 429. code must stay optional: Fastify's own rate-limit plugin can
 * also produce a 429 on this route, and its response has no code field — if it were required,
 * that response would fail schema serialization and come back as a 500 instead of a 429.
 */
const quotaError = {
    type: "object",
    properties: { error: { type: "string" }, code: { type: "string" } },
    required: ["error"],
} as const;

export const schemas = {
    createInvoice: {
        response: { 200: storedInvoice, 400: error, 429: error, 502: error, 500: error },
    },
    listInvoices: {
        response: { 200: { type: "array", items: storedInvoice } },
    },
    deleteInvoice: {
        response: { 204: {}, 400: error, 404: error },
    },
    clearInvoices: {
        response: {
            200: { type: "object", properties: { deleted: { type: "integer" } }, required: ["deleted"] },
        },
    },
    extract: {
        response: { 200: draftInvoice, 400: error, 415: error, 413: error, 429: quotaError, 502: error },
    },
    quota: {
        response: {
            200: { type: "object", properties: { remaining: { type: "integer" } }, required: ["remaining"] },
        },
    },
};
