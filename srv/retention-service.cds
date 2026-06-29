using retention.db as db from '../db/schema';

service RetentionService {

  entity RetentionList {
    key Invoicenumber     : String;
    Invoiceyear           : String;
    Invoicedate           : DateTime;
    Accountingdocument    : String;
    Fiscalyear             : String;
    Companycode            : String;
    Rtclearingyear         : String;
    Rtclearing             : String;
    Rtcreationdate          : DateTime;
    Rtcleardocument         : String;
    Payclearingdate         : DateTime;
    Paydocument             : String;
    Docstatus               : String;
    Suppliername            : String;
    Supplier                : String;
    Purchaseorder           : String;
    Netduedate              : DateTime;
    Externalref             : String;
    Invoicedescription      : String;
    Netamount               : String;
    Currency                : String;
    Retentionamount         : String;
    FinalStatus              : String;
  }

  // Exposed read-only so the new Claim Detail page can look up a
  // previously-submitted claim's persisted record by ClaimId if
  // needed (e.g. on a page refresh) - the primary write path is via
  // submitClaimWithAttachments below, not direct entity CRUD.
  @readonly
  entity ClaimRecords as projection on db.ClaimRecords;

  // ---------------------------------------------------------------
  // Submit Claim (with attachments + HANA persistence) action
  // ---------------------------------------------------------------
  // REPLACES the earlier submitClaim action (2026-06-25). Now does
  // THREE things together, as one combined action (confirmed with
  // user: save-to-HANA and send-to-S4 happen together, not as
  // separate steps):
  //   1. Sends ONE POST per record to the CPI claim-submission
  //      endpoint (/http/retentionclaim), same as before.
  //   2. Persists ONE ClaimRecords row per record to the local HANA
  //      DB, all sharing the same generated ClaimId (a single record
  //      submitted alone still gets its own ClaimId, just one row).
  //   3. Stores each record's attachment FILE METADATA (name, size,
  //      type - not the actual file bytes, see the ClaimRecords
  //      entity comment in db/schema.cds for why) as a JSON string
  //      alongside that record's row.
  //
  // attachments is a parallel array to records (attachments[i]
  // corresponds to records[i]) rather than nested inside each
  // record, to keep the records array's shape identical to what the
  // old submitClaim accepted - minimizing frontend changes beyond
  // adding the attachments array itself.
  // attachments is a FLAT array (CDS does not support nested
  // "array of array of {...}" - confirmed by a real compile error
  // when first attempted), with each entry tagged by which record it
  // belongs to via Invoicenumber, rather than nested per-record
  // arrays. Multiple attachment entries can share the same
  // Invoicenumber (one record can have several files).
  action submitClaimWithAttachments(
    records: array of {
      Invoicenumber       : String;
      Invoiceyear          : String;
      Companycode           : String;
      Accountingdocument     : String;
      Fiscalyear              : String;
      Purchaseorder            : String;
    },
    attachments: array of {
      Invoicenumber : String;
      name           : String;
      size           : Integer;
      type           : String;
    }
  ) returns {
    ClaimId : String;
    results : array of {
      Invoicenumber : String;
      success        : Boolean;
      subrc          : String;
      message        : String;
    };
  };
}
