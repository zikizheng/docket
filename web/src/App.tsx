import { useEffect, useState, type SyntheticEvent } from "react";
import type { Invoice, StoredInvoice, DraftInvoice, Decision } from "../../shared/types";
import { verifyInvoice, listInvoices, deleteInvoice, clearInvoices } from "./api";
import "./App.css";
import { isValidAbn } from './../../shared/abn';
import UploadPanel from "./components/UploadPanel";

const EMPTY: Invoice = { supplierName: "", abn: "", amount: 0, gstCharged: false };

type FieldErrors = Partial<Record<keyof Invoice, string>>;

export default function App() {
    const [form, setForm] = useState<Invoice>(EMPTY);
    const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [touched, setTouched] = useState<Partial<Record<keyof Invoice, boolean>>>({});
    const [needsReview, setNeedsReview] = useState<string[]>([]);
    const [sourceFile, setSourceFile] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const errors = validate(form);
    const isValid = Object.keys(errors).length === 0;
    const totals = summarizeInvoices(invoices);

    useEffect(() => {
        listInvoices().then(setInvoices).catch((e) => setError(e.message));
    }, []);

    function handleExtracted(draft: DraftInvoice, fileName: string) {
        setForm({
            supplierName: draft.supplierName ?? "",
            abn: draft.abn ?? "",
            amount: draft.amount ?? 0,
            gstCharged: draft.gstCharged ?? false,
            invoiceNumber: draft.invoiceNumber ?? "",
            invoiceDate: draft.invoiceDate ?? "",
        });
        setNeedsReview([...draft.missing, ...draft.lowConfidence]);
        setSourceFile(fileName);
        setTouched({});
        setError(null);
    }

    function clearReview(field: string) {
        setNeedsReview((prev) => prev.filter((f) => f !== field));
    }

    async function handleSubmit(e: SyntheticEvent) {
        e.preventDefault();
        setError(null);
        setTouched({ supplierName: true, abn: true, amount: true });
        if (!isValid) return;

        setSubmitting(true);
        try {
            const result = await verifyInvoice(form);
            setInvoices((prev) => [result, ...prev]);
            setForm(EMPTY);
            setTouched({});
            setSourceFile(null);
            setNeedsReview([]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong.");
        } finally {
            setSubmitting(false);
        }
    }

    function markTouched(field: keyof Invoice) {
        setTouched((prev) => ({ ...prev, [field]: true }));
    }

    async function handleDelete(id: number) {
        if (!window.confirm("Delete this invoice?")) return;
        try {
            await deleteInvoice(id);
            setInvoices((prev) => prev.filter((inv) => inv.id !== id));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't delete that invoice.");
        }
    }

    async function handleClearAll() {
        if (!window.confirm("Delete all logged invoices? This can't be undone.")) return;
        try {
            await clearInvoices();
            setInvoices([]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't clear invoices.");
        }
    }

    async function handleCopyList() {
        const lines = invoices.map((inv) => {
            const flags = inv.flags.length === 0 ? "-" : inv.flags.map((f) => f.message).join(" | ");
            return `Supplier Name: ${inv.supplierName} - Amount: $${inv.amount.toFixed(2)}\nFlags: ${flags}\n`;
        });
        const text = [...lines, "", `Total sum: $${totals.grand.amount.toFixed(2)}`].join("\n");

        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setError("Couldn't copy to clipboard.");
        }
    }

    return (
        <main>
            <section className="panel panel-center" id="hero">
                <div className="panel-inner">
                    <h1>Docket</h1>
                    <p className="lede">
                        Check a supplier invoice against the Australian Business Register:
                        confirm ABNs, GST status, and catch mismatches before you pay.
                    </p>
                    <a className="scroll-hint" href="#features">See how it works ↓</a>
                </div>
            </section>

            <section className="panel panel-center" id="features">
                <div className="panel-inner panel-inner-wide">
                    <h2>What it checks</h2>
                    <div className="feature-grid">
                        <div className="feature-card">
                            <h3>ABR lookup</h3>
                            <p>Cross-checks every ABN against the live Australian Business Register.</p>
                        </div>
                        <div className="feature-card">
                            <h3>GST detection</h3>
                            <p>Flags invoices that charge GST they shouldn't, or miss it when they should.</p>
                        </div>
                        <div className="feature-card">
                            <h3>Document scan</h3>
                            <p>Upload a PDF or photo and we'll pre-fill the form for you.</p>
                        </div>
                    </div>
                    <a className="scroll-hint" href="#tool">Try it ↓</a>
                </div>
            </section>

            <section className="panel" id="tool">
                <div className="app">
                    <UploadPanel onExtracted={handleExtracted} />

                    {sourceFile && (
                        <p className="source-note">
                            Pre-filled from <strong>{sourceFile}</strong>
                            {needsReview.length > 0 && "check the highlighted fields before verifying."}
                        </p>
                    )}

                    <h2>Verify an invoice</h2>

                    <form className="card" onSubmit={handleSubmit}>
                <label>
                    Supplier Name
                    <input
                        type="text"
                        value={form.supplierName}
                        className={needsReview.includes("supplierName") ? "needs-review" : ""}
                        onChange={(e) => {
                            setForm({ ...form, supplierName: e.target.value });
                            clearReview("supplierName")
                        }}
                        onBlur={() => markTouched("supplierName")}
                    />
                    {needsReview.includes("supplierName") && (
                        <span className="review-hint">Could not read this reliably. Please confirm.</span>
                    )}
                    {touched.supplierName && errors.supplierName && (
                        <span className="field-error">{errors.supplierName}</span>
                    )}
                </label>
                <label>
                    ABN
                    <input
                        type="text"
                        inputMode="numeric"
                        value={form.abn}
                        placeholder="51 824 753 556"
                        className={needsReview.includes("abn") ? "needs-review" : ""}
                        onChange={(e) => {
                            setForm({ ...form, abn: e.target.value.replace(/[^\d ]/g, "") });
                            clearReview("abn")
                        }}
                        onBlur={() => markTouched("abn")}
                    />
                    {needsReview.includes("abn") && (
                        <span className="review-hint">Could not read this reliably. Please confirm.</span>
                    )}
                    {touched.supplierName && errors.abn && (
                        <span className="field-error">{errors.abn}</span>
                    )}
                </label>
                <label>
                    Invoice Number
                    <input
                        type="text"
                        value={form.invoiceNumber ?? ""}
                        className={needsReview.includes("invoiceNumber") ? "needs-review" : ""}
                        onChange={(e) => {
                            setForm({ ...form, invoiceNumber: e.target.value });
                            clearReview("invoiceNumber")
                        }}
                    />
                    {needsReview.includes("invoiceNumber") && (
                        <span className="review-hint">Could not read this reliably. Please confirm.</span>
                    )}
                </label>
                <label>
                    Invoice Date
                    <input
                        type="date"
                        value={form.invoiceDate ?? ""}
                        className={needsReview.includes("invoiceDate") ? "needs-review" : ""}
                        onChange={(e) => {
                            setForm({ ...form, invoiceDate: e.target.value });
                            clearReview("invoiceDate")
                        }}
                    />
                    {needsReview.includes("invoiceDate") && (
                        <span className="review-hint">Could not read this reliably. Please confirm.</span>
                    )}
                </label>
                <label>
                    Amount (AUD)
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.amount || ""}
                        className={needsReview.includes("amount") ? "needs-review" : ""}
                        onChange={(e) => {
                            setForm({ ...form, amount: Number(e.target.value) })
                            clearReview("amount")
                        }}
                        onBlur={() => markTouched("amount")}
                    />
                    {needsReview.includes("amount") && (
                        <span className="review-hint">Could not read this reliably. Please confirm.</span>
                    )}
                    {touched.abn && errors.abn && <span className="field-error">{errors.amount}</span>}
                </label>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={form.gstCharged}
                        className={needsReview.includes("gstCharged") ? "needs-review" : ""}
                        onChange={(e) => {
                            setForm({ ...form, gstCharged: e.target.checked })
                            clearReview("gstCharged")
                        }}
                    />
                    Invoice charges GST
                </label>
                    {needsReview.includes("gstCharged") && (
                        <span className="review-hint">Could not read this reliably. Please confirm.</span>
                    )}
                <button type="submit" disabled={submitting}>
                    {submitting ? "Verifying..." : "Verify invoice"}
                </button>
                {error && <p className="error">{error}</p>}
            </form>

            <div className="section-header">
                <h2>Processed invoices</h2>
                {invoices.length > 0 && (
                    <div className="header-actions">
                        <a className="export-csv-button" href="/api/invoices/export" download>
                            Export CSV
                        </a>
                        <button type="button" className="clear-all-button" onClick={handleClearAll}>
                            Clear all
                        </button>
                    </div>
                )}
            </div>
            {invoices.length === 0 ? (
                <p className="empty"> Nothing verified yet.</p>
            ) : (
                <>
                <div className="tablescroll">
                    <table className="card">
                        <thead>
                            <tr><th>Supplier Name</th><th>Registered Name</th><th>ABN</th><th>Invoice Number</th><th>Invoice Date</th><th>Amount</th><th>Decision</th><th>Flags</th><th></th></tr>
                        </thead>
                        <tbody>
                            {invoices.map((inv) => (
                                <tr key={inv.id}>
                                    <td data-label="Supplier">{inv.supplierName}</td>
                                    <td data-label="Registered Name">{inv.registeredName}</td>
                                    <td data-label="ABN">{inv.abn}</td>
                                    <td data-label="Invoice Number">{inv.invoiceNumber ?? <span className="muted">-</span>}</td>
                                    <td data-label="Invoice Date">{inv.invoiceDate ?? <span className="muted">-</span>}</td>
                                    <td data-label="Amount">{"$" + inv.amount.toFixed(2)}</td>
                                    <td data-label="Decision"><span className={`badge badge-${inv.decision}`}>{inv.decision}</span></td>
                                    <td data-label="Flags">
                                        {inv.flags.length === 0 ? (
                                            <span className="muted">-</span>
                                        ) : (
                                            <ul className="flags">
                                                {inv.flags.map((f, i) => (
                                                    <li key={i} className={`flag flag-${f.severity}`}>{f.message}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </td>
                                    <td data-label="">
                                        <button
                                            type="button"
                                            className="delete-row-button"
                                            aria-label="Delete invoice"
                                            onClick={() => handleDelete(inv.id)}
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <div className="card totals-card">
                    <table className="totals-table">
                        <thead>
                            <tr><th>Decision</th><th>Count</th><th>Amount</th></tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td><span className="badge badge-approved">approved</span></td>
                                <td>{totals.approved.count}</td>
                                <td>${totals.approved.amount.toFixed(2)}</td>
                            </tr>
                            <tr>
                                <td><span className="badge badge-review">review</span></td>
                                <td>{totals.review.count}</td>
                                <td>${totals.review.amount.toFixed(2)}</td>
                            </tr>
                            <tr>
                                <td><span className="badge badge-rejected">rejected</span></td>
                                <td>{totals.rejected.count}</td>
                                <td>${totals.rejected.amount.toFixed(2)}</td>
                            </tr>
                            <tr className="totals-grand-row">
                                <td>Total</td>
                                <td>{totals.grand.count}</td>
                                <td>${totals.grand.amount.toFixed(2)}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div className="totals-card-footer">
                        <button
                            type="button"
                            className="copy-list-button"
                            onClick={handleCopyList}
                            aria-label="Copy list to clipboard"
                            title="Copy list to clipboard"
                        >
                            {copied ? "✓" : "📋"}
                        </button>
                    </div>
                </div>
                </>
            )}
                <div className="bottom-spacer" aria-hidden="true" />
                </div>
            </section>
        </main>
    )
}

interface DecisionTotal {
    count: number;
    amount: number;
}

function summarizeInvoices(invoices: StoredInvoice[]): Record<Decision, DecisionTotal> & { grand: DecisionTotal } {
    const totals = {
        approved: { count: 0, amount: 0 },
        review: { count: 0, amount: 0 },
        rejected: { count: 0, amount: 0 },
        grand: { count: 0, amount: 0 },
    };
    for (const inv of invoices) {
        totals[inv.decision].count += 1;
        totals[inv.decision].amount += inv.amount;
        totals.grand.count += 1;
        totals.grand.amount += inv.amount;
    }
    return totals;
}

function validate(form: Invoice): FieldErrors {
    const errors: FieldErrors = {};

    if (!form.supplierName.trim()) {
        errors.supplierName = "Supplier name is required.";
    }

    if (!form.abn.trim()) {
        errors.abn = "ABN is required.";
    } else if (form.abn.replace(/\D/g, "").length !== 11) {
        errors.abn = "An ABN must be 11 digits.";
    } else if (!isValidAbn(form.abn)) {
        errors.abn = "This ABN fails the checksum. Check for a typo.";
    }

    if (!form.amount || form.amount <= 0) {
        errors.amount = "Enter an amount greater than zero.";
    }

    return errors;
}