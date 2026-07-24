import type { FastifyInstance } from "fastify";
import type { Invoice, AbnRecord } from "../../shared/types.ts";
import { isValidAbn } from "../../shared/abn.ts";
import { verifyInvoice } from "./rules.ts";
import { HttpAbrClient, StubAbrClient, type AbrClient } from "./abrClient.ts";
import { saveInvoice, listInvoices, deleteInvoice, clearInvoices, exportInvoicesCsv } from "./db.ts";
import { StubExtractor, TextractExtractor, type InvoiceExtractor } from "./extractor.ts";
import { consumeExtractionQuota, consumeAbrLookupQuota, remainingQuota } from "./quota.ts";

const extractor: InvoiceExtractor = process.env.AWS_ACCESS_KEY_ID
    ? new TextractExtractor(process.env.AWS_REGION ?? "ap-southeast-2")
    : new StubExtractor();

const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];

const guid = process.env.ABR_GUID;
if (!guid) throw new Error("ABR_GUID is not set: add it to server/.env");
const client: AbrClient =
    process.env.USE_STUB_ABR === "true"
        ? new StubAbrClient()
        : (() => {
            if (!guid) throw new Error("ABR_GUID is not set: Add it to server/.env");
            return new HttpAbrClient(guid);
        })();

export function registerRoutes(app: FastifyInstance) {
    app.post("/api/invoices", {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    }, async (request, reply) => {
        const invoice = request.body as Invoice;

        if (
            !invoice ||
            typeof invoice.supplierName !== "string" ||
            typeof invoice.abn !== "string" ||
            typeof invoice.amount !== "number" ||
            typeof invoice.gstCharged !== "boolean" ||
            (invoice.invoiceNumber !== undefined && typeof invoice.invoiceNumber !== "string") ||
            (invoice.invoiceDate !== undefined && typeof invoice.invoiceDate !== "string")
        ) {
            return reply.status(400).send({ error: "Invalid invoice payload." });
        }

        // Only spend an ABR lookup if the ABN passes the local checksum.
        let record: AbnRecord | null = null;
        if (isValidAbn(invoice.abn)) {
            if (!consumeAbrLookupQuota()) {
                return reply.status(429).send({ error: "The daily ABN lookup limit for this demo has been reached: please try again tomorrow." });
            }
            try {
                record = await client.lookup(invoice.abn);
            } catch (err) {
                request.log.error(err);
                return reply.status(502).send({ error: "Couldn't reach the ABN Register: please try again shortly." });
            }
        }
        const result = verifyInvoice(invoice, record);

        let stored;
        try {
            stored = saveInvoice(invoice, result);
        } catch (err) {
            request.log.error(err);
            return reply.status(500).send({ error: "Couldn't save that invoice: please try again." });
        }

        return reply.send(stored);
    });

    app.get("/api/invoices", async () => listInvoices());

    app.get("/api/invoices/export", async (_request, reply) => {
        const csv = exportInvoicesCsv();
        const date = new Date().toISOString().slice(0, 10);
        return reply
            .type("text/csv; charset=utf-8")
            .header("Content-Disposition", `attachment; filename="invoices-${date}.csv"`)
            .send(csv);
    });

    app.delete("/api/invoices/:id", {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    }, async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        if (!Number.isInteger(id)) {
            return reply.status(400).send({ error: "Invalid invoice id." });
        }

        const deleted = deleteInvoice(id);
        if (!deleted) {
            return reply.status(404).send({ error: "Invoice not found." });
        }
        return reply.status(204).send();
    });

    app.delete("/api/invoices", {
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (_request, reply) => {
        const count = clearInvoices();
        return reply.send({ deleted: count });
    });

    app.post("/api/extract", {
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (request, reply) => {
        const data = await request.file();
        if (!data) return reply.status(400).send({ error: "No file uploaded." });

        if (!ALLOWED_TYPES.includes(data.mimetype)) {
            return reply.status(415).send({ error: "Upload a PDF, PNG, or JPEG." })
        }

        let buffer: Buffer;
        try {
            buffer = await data.toBuffer();
        } catch {
            return reply.status(413).send({ error: "File is too large (5 MB max)." });
        }


        if (!consumeExtractionQuota(request.ip)) {
            return reply.status(429).send({
                error: "The daily scanning limit for this demo has been reached — enter the details manually, or try again tomorrow.",
            });
        }
        try {
            const draft = await extractor.extract(buffer);
            reply.header("X-Quota-Remaining", String(remainingQuota()));
            return reply.send(draft);;
        } catch (err) {
            request.log.error(err);
            return reply.status(502).send({ error: "Couldn't read that document. Enter the details manually." });
        }
    })

    app.get("/api/quota", async () => ({ remaining: remainingQuota() }));
}