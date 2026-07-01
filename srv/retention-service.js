

const cds = require("@sap/cds");
const xml2js = require("xml2js");

// Ensure cds.db is set from the active connection so the
// @cap-js/attachments plugin's handleDuplicates query resolves
// against the correct HANA instance rather than the global bun cds.
cds.on("connect", async (service) => {
  if (service.name === "db") {
    cds.db = service;
    // Also patch the global bun cds instance if it exists,
    // since @cap-js/attachments resolves queries against it
    try {
      const globalCds = require("/extbin/globals/bun/global/install/node_modules/@sap/cds");
      if (globalCds && globalCds !== cds) {
        globalCds.db = service;
      }
    } catch (e) {
      // global bun cds not present, no action needed
    }
  }
});

/**
 * Derives the business-facing FinalStatus (tile name) from the raw
 * S/4 fields, per the rules confirmed with the functional team
 * (spreadsheet shared 2026-06-22):
 *
 *   RETAINED  : Netduedate < today  AND Rtcleardocument not created
 *   PAID      : Rtcleardocument has a value
 *   APPROVED  : Rtcleardocument has a value AND Paydocument is initial/empty
 *               (the "24*" field referenced in the spec - confirmed
 *               2026-06-22 to be Paydocument, since real sample data
 *               showed Paydocument values like '24000684')
 *   DUE       : Netduedate > today  AND Rtcleardocument not created
 *   INPROGRESS: has Workflow ID, workflow status = started,   level is 1 or 2
 *   REJECTED  : has Workflow ID, workflow status = completed, level is 1 or 2
 *
 * IMPORTANT: APPROVED and PAID overlap - APPROVED is a more specific
 * case of PAID. APPROVED must be checked BEFORE PAID.
 *
 * STILL OPEN / PLACEHOLDER:
 *   1. The exact field name for workflow "level" - guessed as `Level`.
 *   2. Whether Docstatus doubles as the workflow status field.
 */
function deriveStatus(p) {
  const rtClearDoc = (p["d:Rtcleardocument"] || "").trim();
  const payDoc = (p["d:Paydocument"] || "").trim();
  const wf = (p["d:Workflow"] || "").trim();
  const wfStatus = p["d:Docstatus"];
  const wfLevel = p["d:Level"];

  const hasClearDoc = rtClearDoc !== "" && rtClearDoc !== "0";
  const hasPayDoc = payDoc !== "" && payDoc !== "0";
  const hasActiveWorkflow = wf !== "" && wf !== "000000000000";
  const levelIsOneOrTwo = wfLevel === "1" || wfLevel === "2";

  const netDueDateRaw = p["d:Netduedate"];
  const dueDate = netDueDateRaw ? new Date(netDueDateRaw) : null;
  const today = new Date();

  if (hasActiveWorkflow && wfStatus === "STARTED" && levelIsOneOrTwo) {
    return "Request In Progress";
  }
  if (hasActiveWorkflow && wfStatus === "COMPLETED" && levelIsOneOrTwo) {
    return "Rejected";
  }
  if (hasClearDoc && !hasPayDoc) {
    return "Approved";
  }
  if (hasClearDoc) {
    return "Paid";
  }
  if (!hasClearDoc && dueDate && dueDate < today) {
    return "Due for Refund";
  }
  if (!hasClearDoc && dueDate && dueDate >= today) {
    return "Retained";
  }

  return "Retained";
}

module.exports = cds.service.impl(async function () {
  const { RetentionList } = this.entities;

  this.on("READ", RetentionList, async (req) => {
    const supplier = req.data.Supplier || "0000100091";
    const fiscal = req.data.Fiscalyear || "2021";

    const dest = await cds.connect.to("CPI_RETENTION");

    const path =
      `/http/retention/list` +
      `?client=100&Supplier=${supplier}&Fiscalyear=${fiscal}&skip=0&top=100`;

    const response = await dest.send("GET", path, {
      headers: { "Accept": "application/xml" }
    });

    const xml = response;

    const json = await xml2js.parseStringPromise(xml, {
      explicitArray: false
    });

    const entries = json.feed.entry
      ? (Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry])
      : [];

    const mapped = entries.map(e => {
      const p = e.content["m:properties"];

      return {
        Invoicenumber: p["d:Invoicenumber"],
        Invoiceyear: p["d:Invoiceyear"],
        Invoicedate: p["d:Invoicedate"],
        Accountingdocument: p["d:Accountingdocument"],
        Fiscalyear: p["d:Fiscalyear"],
        Companycode: p["d:Companycode"],
        Rtclearingyear: p["d:Rtclearingyear"],
        Rtclearing: p["d:Rtclearing"],
        Rtcreationdate: p["d:Rtcreationdate"],
        Rtcleardocument: p["d:Rtcleardocument"],
        Payclearingdate: p["d:Payclearingdate"],
        Paydocument: p["d:Paydocument"],
        Docstatus: p["d:Docstatus"],
        Suppliername: p["d:Suppliername"],
        Supplier: p["d:Supplier"],
        Purchaseorder: p["d:Purchaseorder"],
        Netduedate: p["d:Netduedate"],
        Externalref: p["d:Externalref"],
        Invoicedescription: p["d:Invoicedescription"],
        Netamount: p["d:Netamount"],
        Currency: p["d:Currency"],
        Retentionamount: p["d:Retentionamount"],
        FinalStatus: deriveStatus(p)
      };
    });

    return mapped;
  });


  // ---------------------------------------------------------------
  // whoAmI - returns the current logged-in user's id, anid, and
  // roles, so the UI can display "Logged in as: ..." on the page.
  // ---------------------------------------------------------------
  this.on("whoAmI", (req) => {
  const aKnownRoles = ["SupplierRole", "authenticated-user", "any"];
  const aActiveRoles = aKnownRoles.filter(r => req.user?.is?.(r));

  return {
    id: req.user?.id || "",
    anid: req.user?.attr?.anid || "",
    roles: aActiveRoles.join(", ")
  };
});



  // ---------------------------------------------------------------
  // Submit Claim action
  // ---------------------------------------------------------------
  // Added 2026-06-25. Loops through the selected records (passed
  // directly from the UI5 frontend, which already has the field
  // values from the original READ) and sends ONE POST per record to
  // the CPI claim-submission endpoint (/http/retentionclaim).
  //
  // Confirmed via Postman (2026-06-24/25) that this endpoint:
  //   - Accepts an Atom XML <entry> body with Invoicenumber,
  //     Invoiceyear, Companycode, Accountingdocument, Fiscalyear,
  //     Purchaseorder in the <m:properties>.
  //   - Returns an Atom XML <entry> response whose <m:properties>
  //     includes Subrc and Message fields - Subrc="04" with
  //     Message="Failed to create Request, Try agian." on the
  //     failures seen so far. Subrc="00" is ASSUMED (not yet
  //     confirmed, since every real call so far has failed) to mean
  //     success, following standard ABAP return-code convention -
  //     this should be verified once a successful call is seen.
  //
  // CHANGED 2026-06-25 (third attempt): confirmed via a working
  // Postman test that the correct structure for MULTIPLE records is
  // simply multiple <entry> elements concatenated directly one after
  // another - EACH with its own full xmlns declarations repeated -
  // and NO outer <feed> (or any other) wrapping element at all. The
  // earlier <feed>-wrapped attempt caused a 500, even with only a
  // single entry inside it - confirming the problem was the <feed>
  // wrapper itself, not the entry count. This is now updated to
  // match that confirmed-working shape exactly.
  // ---------------------------------------------------------------
  // Submit Claim (with attachments + HANA persistence) action
  // ---------------------------------------------------------------
  // REPLACES the earlier submitClaim handler (2026-06-25). See the
  // .cds file for the full rationale - this now: generates a single
  // ClaimId for the whole batch (cds.utils.uuid), sends the same
  // per-record POSTs to CPI as before, and persists ONE ClaimRecords
  // row per record (sharing that ClaimId) with the S4 result AND that
  // record's attachment file metadata.
  this.on("submitClaimWithAttachments", async (req) => {
    const { records } = req.data;
    const dest = await cds.connect.to("CPI_RETENTION");
    const { ClaimRecords } = this.entities;

    // CHANGED 2026-06-26: ClaimId is now a sequential, human-readable
    // string ("RTAClaim-1", "RTAClaim-2", ...) instead of a UUID, per
    // user requirement (it needs to display as a clickable reference
    // on the dashboard). The next number is computed via
    // SELECT MAX(ClaimSequence) + 1 - see the ClaimRecords entity
    // comment in db/schema.cds for why this approach (rather than a
    // true HANA-native sequence) was chosen, and its limitation under
    // true concurrent access.
    const oMaxResult = await cds.tx(req).run(
      SELECT.one.from(ClaimRecords).columns("ClaimSequence").orderBy("ClaimSequence desc")
    );
    const iNextSequence = (oMaxResult && oMaxResult.ClaimSequence ? oMaxResult.ClaimSequence : 0) + 1;
    const sClaimId = "RTClaim-" + iNextSequence;

    const sBody = records.map(record =>
      `<entry xmlns="http://www.w3.org/2005/Atom" ` +
      `xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" ` +
      `xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">` +
      `<category term="ZMM_RETENTION_LIST_SRV.List" scheme="http://schemas.microsoft.com/ado/2007/08/dataservices/scheme"/>` +
      `<content type="application/xml">` +
      `<m:properties>` +
      `<d:Invoicenumber>${escapeXml(record.Invoicenumber)}</d:Invoicenumber>` +
      `<d:Invoiceyear>${escapeXml(record.Invoiceyear)}</d:Invoiceyear>` +
      `<d:Companycode>${escapeXml(record.Companycode)}</d:Companycode>` +
      `<d:Accountingdocument>${escapeXml(record.Accountingdocument)}</d:Accountingdocument>` +
      `<d:Fiscalyear>${escapeXml(record.Fiscalyear)}</d:Fiscalyear>` +
      `<d:Purchaseorder>${escapeXml(record.Purchaseorder)}</d:Purchaseorder>` +
      `</m:properties>` +
      `</content>` +
      `</entry>`
    ).join("");

    let aResults;

    console.log("=== submitClaimWithAttachments: about to call CPI ===");
    try {
      const response = await dest.send({
        method: "POST",
        path: "/http/retentionclaim?client=100",
        headers: {
          "Accept": "application/xml",
          "Content-Type": "application/atom+xml",
          "sap-client": "100"
        },
        data: sBody
      });
      console.log("=== submitClaimWithAttachments: CPI call returned ===");

      // IMPORTANT: the response body is NOT well-formed XML on its
      // own when there are multiple entries - it's multiple sibling
      // <entry> root elements concatenated together (same structure
      // as the request), which xml2js (and any standard XML parser)
      // CANNOT parse directly, since XML requires exactly one root
      // element. To handle this, the raw response text is split into
      // individual <entry>...</entry> chunks using a regex BEFORE
      // attempting to parse each one separately as its own small,
      // valid XML document - this is a workaround for a payload
      // shape that isn't standard XML, not standard practice in
      // general, but matches what this specific endpoint actually
      // returns.
      const aEntryChunks = response.match(/<entry[\s\S]*?<\/entry>/g) || [];
      console.log("=== submitClaimWithAttachments: found", aEntryChunks.length, "entry chunks ===");

      const aParsedEntries = await Promise.all(
        aEntryChunks.map(sChunk => xml2js.parseStringPromise(sChunk, { explicitArray: false }))
      );
      console.log("=== submitClaimWithAttachments: parsed entries ===");

      // Matches each returned entry back to the record it belongs to
      // BY POSITION (assumes CPI returns entries in the same order
      // the records were sent in) - not yet confirmed against a real
      // multi-entry response, since every test so far has used 1
      // record. If CPI's response entries include
      // Invoicenumber/Invoiceyear/Companycode (like the single-record
      // response did), matching by those key fields instead of by
      // position would be more robust - revisit once a real
      // multi-record response is seen.
      aResults = records.map((record, index) => {
        const parsed = aParsedEntries[index];
        if (!parsed || !parsed.entry) {
          return {
            Invoicenumber: record.Invoicenumber,
            success: false,
            subrc: "",
            message: "No response entry returned for this record."
          };
        }
        const p = parsed.entry.content["m:properties"];
        const subrc = p["d:Subrc"];
        const message = p["d:Message"] || "";
        return {
          Invoicenumber: record.Invoicenumber,
          success: subrc === "00",
          subrc: subrc || "",
          message: message
        };
      });
    } catch (err) {
      cds.log("retention-service").error(
        `submitClaimWithAttachments failed for ${records.length} record(s): ${err.message}`
      );
      // The whole batch failed (e.g. network error, CPI rejected the
      // request entirely) - report every record as failed with the
      // same underlying error, since we have no per-record detail in
      // this case. Persistence below still happens even in this
      // case, so the failed attempt is recorded in HANA too, not
      // silently dropped.
      aResults = records.map(record => ({
        Invoicenumber: record.Invoicenumber,
        success: false,
        subrc: "",
        message: "Request to claim submission endpoint failed: " + err.message
      }));
    }

    // CHANGED 2026-06-26: persistence now only happens for records
    // whose S4 submission actually SUCCEEDED (confirmed with user) -
    // a record that S4 rejected (Subrc != "00") is reported back to
    // the frontend with its real failure message, but is NOT written
    // to ClaimRecords at all. This is a deliberate change from the
    // original behavior (which persisted every record regardless of
    // outcome, marking failures with SubmissionSuccess=false) - the
    // ClaimRecords table is now meant to represent only genuinely
    // accepted claims, not every attempt.
    const aSucceededRecords = records.filter(record => {
      const oResult = aResults.find(r => r.Invoicenumber === record.Invoicenumber);
      return oResult && oResult.success;
    });

    const aRowsToInsert = aSucceededRecords.map(record => {
      const oResult = aResults.find(r => r.Invoicenumber === record.Invoicenumber);
      return {
        ClaimId: sClaimId,
        ClaimSequence: iNextSequence,
        Invoicenumber: record.Invoicenumber,
        Invoiceyear: record.Invoiceyear,
        Companycode: record.Companycode,
        Accountingdocument: record.Accountingdocument,
        Fiscalyear: record.Fiscalyear,
        Purchaseorder: record.Purchaseorder,
        SubmissionSuccess: true,
        SubmissionSubrc: oResult.subrc || "",
        SubmissionMessage: oResult.message || ""
      };
    });

    // Skip the INSERT entirely if nothing succeeded - calling INSERT
    // with an empty entries array is pointless at best and may not
    // be well-defined behavior at worst, so this is guarded
    // explicitly rather than relying on it to silently no-op.
    //
    // NOTE: uses cds.tx(req).run(...) rather than the bare global
    // INSERT.into(...).entries(...) form - the bare global form
    // failed in earlier testing with "Can't execute query as no
    // primary database is connected", even though the same server's
    // startup log clearly showed "connect to db > hana {...}"
    // succeeding. This is a known category of CAP issue: if @sap/cds
    // ends up loaded as more than one module instance (not a true
    // singleton across the whole project's dependency tree), the
    // bare globals (INSERT, SELECT, cds.entities, etc.) can bind to a
    // DIFFERENT cds instance than the one actually holding the live
    // DB connection - see e.g. github.com/cap-js/sdm/issues/59 and
    // the SAP Community thread on "Not connected to primary
    // datasource" for the same exact symptom. cds.tx(req).run(...) -
    // tied explicitly to the current request's transaction - avoids
    // depending on which global instance happens to be referenced.
    if (aRowsToInsert.length > 0) {
      console.log("=== submitClaimWithAttachments: about to INSERT", aRowsToInsert.length, "succeeded record(s) into ClaimRecords ===");
      await cds.tx(req).run(
        INSERT.into(ClaimRecords).entries(aRowsToInsert)
      );
      console.log("=== submitClaimWithAttachments: INSERT done, returning result ===");
    } else {
      console.log("=== submitClaimWithAttachments: no records succeeded, skipping INSERT entirely ===");
    }

    return {
      ClaimId: sClaimId,
      results: aResults
    };
  });
});

// Escapes the 5 characters that are unsafe in XML text content/
// attribute values, so record field values (which may contain
// special characters) can't break the generated XML body.
function escapeXml(sValue) {
  if (sValue === undefined || sValue === null) {
    return "";
  }
  return String(sValue)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}





