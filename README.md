# Docket

Automated verification of supplier details on invoices, using the
Australian Business Register (ABR) ABN Lookup web services.

Upload an invoice (or enter its details by hand) and the tool checks the
supplier's ABN against the public register, flags anything that looks off,
and returns a clear **approved / review / rejected** decision.

## Why I built this

While working in support at CampaignAgent, a pay-later provider for
property vendors, part of my job was manually verifying supplier
invoices during loan approvals. This tool is intended to automate those checks.

## What it does

**ABN & compliance checks** ([rules.ts](server/src/rules.ts))
- Validates an ABN's format locally using the official checksum, before
  spending a lookup on the live register
- Looks the ABN up on the ABR and confirms it exists and is **Active**
  (not cancelled)
- Compares the invoice's supplier name against the registered entity name
  (fuzzy match, tolerant of "Pty Ltd" suffixes and punctuation) and flags
  mismatches
- Flags invoices that charge GST when the supplier isn't registered for it
- Flags invoices that are missing a date, undated in the future, stale
  (>180 days old), or missing an invoice number
- Rolls everything up into a decision: `approved`, `review`, or `rejected`

**Document scanning** ([extractor.ts](server/src/extractor.ts))
- Upload a PDF/PNG/JPEG invoice and have its fields (supplier, ABN, amount,
  GST, invoice number, date) pulled out automatically via AWS Textract's
  expense analysis, pre-filling the form for review
- Falls back to a stub extractor for local development when no AWS
  credentials are configured
- Daily extraction quotas (global and per-IP) keep the (billed) Textract
  calls bounded for demo/hosted use; a daily cap on ABR lookups protects
  the register API the same way

**History**
- Verified invoices are stored (SQLite) and listed, with delete/clear support
- Export the full history as a CSV download

## Architecture

A small monorepo:

| Folder | What it is |
| --- | --- |
| [server/](server) | Fastify + TypeScript API — verification rules, ABR client, Textract extraction, SQLite storage |
| [web/](web) | React + Vite single-page frontend |
| [shared/](shared) | Types and ABN checksum logic shared by both server and web |

In production the server also serves the built web app as static files, so
it's a single deployable process (see [Dockerfile](Dockerfile)).

## Tech

TypeScript, Node 24, Fastify, better-sqlite3, AWS Textract, React 19, Vite.

## API

| Method & path | Purpose |
| --- | --- |
| `POST /api/invoices` | Verify an invoice and store the result |
| `GET /api/invoices` | List stored invoices |
| `GET /api/invoices/export` | Download all stored invoices as CSV |
| `DELETE /api/invoices/:id` | Delete one invoice |
| `DELETE /api/invoices` | Clear all invoices |
| `POST /api/extract` | Upload a PDF/PNG/JPEG and extract a draft invoice |
| `GET /api/quota` | Remaining daily extractions (global) |

## Getting started

Prerequisites: Node 24+

1. `git clone …`
2. `npm install --prefix server` and `npm install --prefix web`
3. Copy `server/.env.example` to `server/.env` and add your [ABR GUID](https://abr.business.gov.au/Tools/WebServices)
   (set `USE_STUB_ABR=true` instead to use canned data with no GUID)
4. AWS credentials in `server/.env` are optional — without them, document
   uploads use a stub extractor instead of calling Textract
5. `npm run test:server` — run the server test suite
6. `npm run dev:server` and, in another terminal, `npm run dev:web` — start the app

## Deployment

The [Dockerfile](Dockerfile) builds the web app and server into a single
image; [fly.toml](fly.toml) deploys it to Fly.io with a persistent volume
for the SQLite database.

## Note on data

Uses synthetic invoice data only; ABNs are validated against real,
public ABR records. No real customer data is used.

## License

MIT — see [LICENSE](LICENSE).
