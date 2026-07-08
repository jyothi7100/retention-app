namespace retention.db;
using { Attachments } from '@cap-js/attachments';

/**
 * Mirrors the real shape of the S/4HANA OData entity
 * /sap/opu/odata/SAP/ZMM_RETENTION_LIST_SRV/ListSet
 *
 * Field names and the composite key below were taken directly from a
 * live sample response of that service (verified 2026-06-19), NOT
 * guessed. The composite key matches how S/4 itself addresses a
 * record: ListSet(Invoicenumber='5105630353',Invoiceyear='2021',
 * Companycode='FEWA').
 *
 * This entity is NOT persisted as the source of truth in production -
 * it just gives the CAP service a strongly-typed shape for HDI/HANA
 * deployment and for local SQLite fallback. In production,
 * srv/retention-service.js forwards requests to S/4HANA via the
 * configured destination and returns live data, normalized into this
 * shape. For local development without S/4HANA connectivity, the same
 * entity is backed by an in-memory SQLite table seeded with realistic
 * mock data (see db/data/retention.db-RetentionList.csv).
 */
entity RetentionList {
  key Invoicenumber              : String(10);
  key Invoiceyear                : String(4);
  key Companycode                : String(4);

      Accountingdocument          : String(10);
      Fiscalyear                  : String(4);
      Rtclearingyear               : String(4);
      Rtclearing                  : String(8);
      Rtcreationdate               : Date;
      Rtcleardocument              : String(10);
      Payclearingdate              : Date;
      Paydocument                  : String(10);
      Creationtime                 : String(8); // stored as HH:MM:SS, source is an ISO duration (e.g. PT13H35M43S)

      // Raw S/4 status field. Pass-through, exactly as returned.
      Docstatus                   : String(30);

      Invoicedate                 : Date;
      Accountingdocumentcreationdate : Date;
      Anid                         : String(20);
      Suppliername                 : String(80);
      Supplier                     : String(10);
      Purchaseorder                 : String(10);
      Workflowtext                  : String(60);
      Workflow                      : String(12);
      Netduedate                    : Date;
      Externalref                   : String(20);
      Invoicedescription             : String(255);
      // CHANGED 2026-06-22: was Decimal(15,2). Switched to String
      // because CAP/OData v4's Edm.Decimal serialization was
      // silently dropping valid negative values (e.g. "-27890.00")
      // before they reached the UI - the value confirmed correct
      // and present right up until our service handler returned it,
      // but came back empty over OData. Since these fields are only
      // ever displayed (not used in server-side arithmetic), String
      // sidesteps the issue entirely. Sign is passed through exactly
      // as S/4 sends it, same as before.
      Netamount                     : String(20);
      Currency                      : String(5);
      Retentionamount               : String(20);

      // NOT part of the raw S/4 payload - mapped server-side from
      // Docstatus, see srv/retention-service.js (mapDocstatusToTile).
      //
      // UPDATED 2026-06-22: real sample data confirmed Docstatus
      // already contains the final business status as plain text
      // (e.g. "RETAINED"). The earlier assumption that this needed
      // deriving from a combination of fields (Rtcleardocument,
      // Workflow status/level, Netduedate) was incorrect - S/4 (or
      // the CDS view behind ZMM_RETENTION_LIST_SRV) already computes
      // this. FinalStatus is now just Docstatus, case-normalized to
      // match the UI tile names: Retained, Approved, Due for Refund,
      // Request In Progress, Rejected.
      //
      // Only "RETAINED" has been confirmed in real samples so far.
      // The mapping for the other 4 tile names in
      // srv/retention-service.js (DOCSTATUS_TO_TILE) is still a
      // best-guess pending more real samples.
      FinalStatus                   : String(30);
}

/**
 * Persisted record of a submitted retention claim. Added 2026-06-25.
 *
 * ONE ROW PER RECORD in the claim (confirmed with user) - if multiple
 * RetentionList records are selected and submitted together as one
 * claim, they all share the same ClaimId; a single-record claim still
 * gets its own ClaimId, just with only one row.
 *
 * CHANGED 2026-06-26: ClaimId switched from UUID to a human-readable
 * sequential String (e.g. "RTAClaim-1", "RTAClaim-2", ...), per user
 * requirement - this needs to display as a clickable reference on
 * the dashboard, and a UUID wasn't suitable for that. ClaimSequence
 * holds the underlying plain Integer (1, 2, 3, ...) separately from
 * the formatted ClaimId string, so the "next number" can be computed
 * with a simple MAX(ClaimSequence) + 1 query (see
 * srv/retention-service.js) rather than parsing numbers back out of
 * formatted strings. This is a SELECT MAX()+1 approach, not a true
 * HANA-native sequence (hdbsequence) - acceptable for this app's
 * current single-instance, low-concurrency scale; a real DB sequence
 * would be needed if this app is later deployed with multiple
 * concurrent instances, to fully rule out a race condition between
 * two near-simultaneous submissions reading the same MAX value before
 * either has inserted.
 *
 * Attachments are stored as a JSON-encoded array of file metadata
 * (name, size, type) in AttachmentsJson - NOT the actual file bytes.
 * Storing the raw file content in a plain CDS String/LargeString
 * column would work for small files but isn't a robust long-term
 * storage approach for binary attachments; the actual file bytes
 * should go through a proper attachment-storage mechanism once the
 * ABAP/CPI team confirms one (same open item as before - see
 * srv/retention-service.js). This table is therefore METADATA ONLY
 * for now: it records WHICH files were attached and their names, not
 * the file content itself.
 */
entity ClaimRecords {
  key ClaimId         : String(30);
  key Invoicenumber   : String(10);

      ClaimSequence       : Integer;
      Invoiceyear           : String(4);
      Companycode             : String(4);
      Accountingdocument        : String(10);
      Fiscalyear                  : String(4);
      Purchaseorder                  : String(10);

      // JSON-encoded array of { name, size, type } objects - the
      // names of files attached to THIS SPECIFIC record within the
      // claim (attachments remain per-record, per the requirement
      // confirmed 2026-06-25, not shared across the whole claim).
      attachments         : Composition of many Attachments; // REPLACES AttachmentsJson

      // Result of the S4/CPI submission for this specific record -
      // stored alongside the claim so the outcome is preserved, not
      // just shown transiently in a toast.
      WorkflowId               : String(20);
      AttachmentsJson          : LargeString;
      SubmissionSuccess        : Boolean;
      SubmissionSubrc           : String(2);
      SubmissionMessage          : String(255);
      CreatedDate                 : DateTime @cds.on.insert: $now;
}