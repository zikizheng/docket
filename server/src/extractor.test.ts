import { test } from "node:test";
import assert from "node:assert/strict";
import { findAbn, parseMoney, findLargestDollarAmount, mapExpenseResponse, parseInvoiceDate } from "./extractor.ts";

test("picks the valid ABN out of surrounding numbers", () => {
    const text =" Invoice 12345678\n Phone 0412 345 678\nABN 51 824 753 556\nTotal 1000.00";
    assert.equal(findAbn(text), "51824753556");
});

test("ignores 11 digit numbers that fail the checksum", () => {
    assert.equal(findAbn("Reference 12345678901"), null);
});

test("parses common invoice amount formats", () => {
    assert.equal(parseMoney("$1,320.00"), 1320);
    assert.equal(parseMoney("Total: $1,320.00 (inc GST)"), 1320);
    assert.equal(parseMoney("1320"), 1320);
    assert.equal(parseMoney("$12,345.67"), 12345.67);
    assert.equal(parseMoney("-$50.00"), -50);
    assert.equal(parseMoney("no digits here"), null);
});

test("falls back to the largest dollar figure", () => {
    const text = "Subtotal $1,200.00\nGST $120.00\nTotal $1,320.00";
    assert.equal(findLargestDollarAmount(text), 1320);
});

test("zero tax means GST is not charged, despite the word appearing", () => {
  const response = {
    ExpenseDocuments: [{
      SummaryFields: [
        { Type: { Text: "TOTAL" }, ValueDetection: { Text: "$1,200.00", Confidence: 99 } },
        { Type: { Text: "GST" }, ValueDetection: { Text: "$0.00", Confidence: 99 } },
      ],
    }],
  };
  assert.equal(mapExpenseResponse(response).gstCharged, false);
});

test("parses Australian day-first numeric dates", () => {
    assert.equal(parseInvoiceDate("12/03/2026"), "2026-03-12");
    assert.equal(parseInvoiceDate("1/7/2026"), "2026-07-01");
    assert.equal(parseInvoiceDate("14-07-2026"), "2026-07-14");
    assert.equal(parseInvoiceDate("14.07.2026"), "2026-07-14");
});

test("expands two-digit years", () => {
    assert.equal(parseInvoiceDate("14/07/26"), "2026-07-14");
});

test("parses textual dates in both orders", () => {
    assert.equal(parseInvoiceDate("14 July 2026"), "2026-07-14");
    assert.equal(parseInvoiceDate("July 14, 2026"), "2026-07-14");
    assert.equal(parseInvoiceDate("3 Sep 2026"), "2026-09-03");
});

test("finds a date inside surrounding label text", () => {
    assert.equal(parseInvoiceDate("Invoice date: 14/07/2026"), "2026-07-14");
});

test("rejects impossible and unparseable dates", () => {
    assert.equal(parseInvoiceDate("31/02/2026"), null);   // February has no 31st
    assert.equal(parseInvoiceDate("14/13/2026"), null);   // no month 13
    assert.equal(parseInvoiceDate("not a date"), null);
    assert.equal(parseInvoiceDate(""), null);
    assert.equal(parseInvoiceDate(null), null);
});

test("extracts invoice number and date from a Textract response", () => {
    const response = {
        ExpenseDocuments: [{
        SummaryFields: [
            { Type: { Text: "INVOICE_RECEIPT_ID" }, ValueDetection: { Text: "INV-2026-0042", Confidence: 99 } },
            { Type: { Text: "INVOICE_RECEIPT_DATE" }, ValueDetection: { Text: "14/07/2026", Confidence: 98 } },
        ],
        }],
    };
    const draft = mapExpenseResponse(response);
    assert.equal(draft.invoiceNumber, "INV-2026-0042");
    assert.equal(draft.invoiceDate, "2026-07-14");
});

test("parses dash-separated textual dates", () => {
    assert.equal(parseInvoiceDate("13-Jul-2026"), "2026-07-13");
    assert.equal(parseInvoiceDate("13-JUL-2026"), "2026-07-13");
    assert.equal(parseInvoiceDate("Date\n13-Jul-2026"), "2026-07-13");
});

test("prefers the vendor name nearest the top of the page over a higher-confidence decoy lower down", () => {
    // Reproduces a real Textract response: a legal entity name quoted inside payment
    // instructions ("...pay via BPAY, referencing Acme Holdings Pty Ltd") OCR'd more cleanly
    // than the letterhead business name, and out-scored it on confidence alone.
    const response = {
        ExpenseDocuments: [{
            SummaryFields: [
                { Type: { Text: "VENDOR_NAME" }, ValueDetection: { Text: "Riverside Physio Clinic", Confidence: 87.75, Geometry: { BoundingBox: { Top: 0.164 } } } },
                { Type: { Text: "VENDOR_NAME" }, ValueDetection: { Text: "Acme Holdings Pty Ltd", Confidence: 96.10, Geometry: { BoundingBox: { Top: 0.584 } } } },
            ],
        }],
    };
    assert.equal(mapExpenseResponse(response).supplierName, "Riverside Physio Clinic");
});

test("falls back to confidence when the topmost vendor-name candidate is too low to trust", () => {
    const response = {
        ExpenseDocuments: [{
            SummaryFields: [
                { Type: { Text: "VENDOR_NAME" }, ValueDetection: { Text: "###unreadable###", Confidence: 22, Geometry: { BoundingBox: { Top: 0.05 } } } },
                { Type: { Text: "VENDOR_NAME" }, ValueDetection: { Text: "Riverside Physio Clinic", Confidence: 91, Geometry: { BoundingBox: { Top: 0.5 } } } },
            ],
        }],
    };
    assert.equal(mapExpenseResponse(response).supplierName, "Riverside Physio Clinic");
});