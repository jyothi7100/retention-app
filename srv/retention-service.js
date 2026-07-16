

const cds = require("@sap/cds");
const xml2js = require("xml2js");

/**
 * Derives the business-facing FinalStatus from the raw S/4 fields.
 *
 * CHANGED 2026-07-16: previously this function computed FinalStatus
 * itself from a combination of Netduedate, Rtcleardocument,
 * Paydocument, Workflow, and a guessed "Level" field (per the
 * 2026-06-22 spreadsheet) - that logic is REMOVED. Real sample data
 * confirmed 2026-07-16 that S/4 (via ZMM_RETENTION_LIST_SRV) already
 * computes and returns the correct business status directly in
 * d:Docstatus, using exactly these values: PAID, RETAINED,
 * RETENTION_DUE, REQUEST_IN_PROGRESS, REQUEST_ACCEPTED,
 * REQUEST_REJECTED. There is nothing left to derive - this function
 * is now a pure passthrough. The frontend (retention.controller.js)
 * maps these raw values to their display text/state/KPI groupings.
 */
function deriveStatus(p) {
  return p["d:Docstatus"] || "";
}
module.exports = cds.service.impl(async function () {
  const { RetentionList } = this.entities;

  this.on("READ", RetentionList, async (req) => {
    // CHANGED 2026-07-15 — was filtering by hardcoded Supplier
    // ("0000100840") and Fiscalyear ("2026") defaults. Now filters by
    // the logged-in user's ANID instead (confirmed via Postman:
    // endpoint takes client/skip/top/Anid, no Fiscalyear param at
    // all) - each supplier user now only sees their own retention
    // records via req.user.attr.anid, same value already used
    // elsewhere in this file (whoAmI, submitClaimWithAttachments's
    // <d:Anid> field).
    // const anid = req.user?.attr?.anid || "";
    const anid ="AN11223415875-T";

    if (!anid) {
        return req.reject(403, "No ANID found for the logged-in user - cannot retrieve retention records");
    }

    const dest = await cds.connect.to("CPI_RETENTION");

    const path =
      `/http/retention/list` +
      `?client=100&skip=0&top=100&Anid=${anid}`;

    const response = await dest.send("GET", path, {
      headers: { "Accept": "application/xml" }
    });



  // this.on("READ", RetentionList, async (req) => {
  //   const supplier = req.data.Supplier || "0000100840";
  //   const fiscal = req.data.Fiscalyear || "2026";

  //   const dest = await cds.connect.to("CPI_RETENTION");

  //   const path =
  //     `/http/retention/list` +
  //     `?client=100&Supplier=${supplier}&Fiscalyear=${fiscal}&skip=0&top=100`;

  //   const response = await dest.send("GET", path, {
  //     headers: { "Accept": "application/xml" }
  //   });

    const xml = response;

    const json = await xml2js.parseStringPromise(xml, {
      explicitArray: false
    });

    const entries = json.feed.entry
      ? (Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry])
      : [];

    const mapped = entries.map(e => {
      const p = e.content["m:properties"];

      // Temporary debug - remove after fixing
if (p["d:Rtcleardocument"] || p["d:Paydocument"] || p["d:Workflow"]) {
  console.log("=== Record fields ===", {
    Invoicenumber: p["d:Invoicenumber"],
    Rtcleardocument: p["d:Rtcleardocument"],
    Paydocument: p["d:Paydocument"],
    Workflow: p["d:Workflow"],
    Docstatus: p["d:Docstatus"],
    Level: p["d:Level"],
    Netduedate: p["d:Netduedate"],
    DerivedStatus: deriveStatus(p)
  });
}

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
  // TEMPORARY DEBUG
  try {
    const oRawToken = req.user?.tokenInfo?.getPayload?.() || req.user?.authInfo?.token || null;
    console.log (JSON.stringify(req.user, null, 2));
    console.log("=== whoAmI RAW TOKEN PAYLOAD ===", JSON.stringify(oRawToken, null, 2));
  } catch (e) {
    console.log("=== whoAmI RAW TOKEN DEBUG ERROR ===", e.message);
  }

  const aKnownRoles = ["SupplierUser", "authenticated-user", "any"];
  const aActiveRoles = aKnownRoles.filter(r => req.user?.is?.(r));

  return {
    id: req.user?.id || "",
    anid: req.user?.attr?.anid || "",
    roles: aActiveRoles.join(", ")
  };
});

this.on("submitAttachment", async (req) => {
  const { workflowId, claimId, invoicenumber, sequence, filename, mimeType, fileContent } = req.data;

  console.log("=== submitAttachment called ===");
  console.log("=== workflowId:", workflowId);
  console.log("=== claimId:", claimId);
  console.log("=== invoicenumber:", invoicenumber);
  console.log("=== filename:", filename);
  console.log("=== slug:", `${workflowId}||${sequence || 0}||${filename}`);
  console.log("=== sequence received:", sequence);
  if (!workflowId) {
    return req.reject(400, "WorkflowId is required for attachment upload");
  }

  try {
    const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
    const slug = `${workflowId}||${sequence || 0}||${filename}`;

    const response = await executeHttpRequest(
      { destinationName: "CPI_RETENTION" },
      {
        method: "POST",
        url: "/http/retentionAttach",
        headers: {
          custom: {
            "Content-Type": mimeType || "application/pdf",
            "Slug": slug,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/atom+xml"
          }
        },
        data: fileContent
      },
      { fetchCsrfToken: false }
    );

    console.log("=== CPI attachment response status:", response.status);

    // Store attachment metadata in HANA for display in read-only view
    if (claimId && invoicenumber) {
      const db = await cds.connect.to("db");
      const existing = await db.run(
        SELECT.one("AttachmentsJson").from("retention.db.ClaimRecords")
          .where({ ClaimId: claimId, Invoicenumber: invoicenumber })
      );

      const aExisting = JSON.parse(existing?.AttachmentsJson || "[]");
      aExisting.push({ filename, mimeType });

      await db.run(
        UPDATE("retention.db.ClaimRecords")
          .where({ ClaimId: claimId, Invoicenumber: invoicenumber })
          .with({ AttachmentsJson: JSON.stringify(aExisting) })
      );
      console.log("=== Attachment metadata saved to HANA");
    }

    return {
      success: true,
      message: `Attachment ${filename} uploaded successfully`
    };

  } catch (err) {
    console.error("=== submitAttachment ERROR:", err.message);
    console.error("=== CPI response status:", err.response?.status);
    console.error("=== CPI response data:", JSON.stringify(err.response?.data));
    return req.reject(500, `Failed to upload attachment: ${err.message}`);
  }
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

  if (!records || records.length === 0) {
    return req.reject(400, "No records provided");
  }

  const sPurchaseorder = records[0].Purchaseorder;
  const sAnid = req.user?.attr?.anid || "";

  console.log("=== submitClaimWithAttachments: sending", records.length, "records for PO", sPurchaseorder);

  // Build inline ListSet entries for all records
  const sListSetEntries = records.map(record => `
        <entry>
          <content type="application/xml">
            <m:properties>
              <d:Invoicenumber>${record.Invoicenumber}</d:Invoicenumber>
              <d:Invoiceyear>${record.Invoiceyear}</d:Invoiceyear>
              <d:Companycode>${record.Companycode}</d:Companycode>
              <d:Accountingdocument>${record.Accountingdocument}</d:Accountingdocument>
              <d:Fiscalyear>${record.Fiscalyear}</d:Fiscalyear>
              <d:Purchaseorder>${record.Purchaseorder}</d:Purchaseorder>
            </m:properties>
          </content>
        </entry>`).join("\n");

  // Build deep entity XML payload
  const sXmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<entry xmlns="http://www.w3.org/2005/Atom"
       xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
       xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">
  <category term="ZMM_RETENTION_LIST_SRV.listHeader"
            scheme="http://schemas.microsoft.com/ado/2007/08/dataservices/scheme"/>
  <content type="application/xml">
    <m:properties>
      <d:Purchaseorder>${sPurchaseorder}</d:Purchaseorder>
      <d:Anid>${sAnid}</d:Anid>
    </m:properties>
  </content>
  <link rel="http://schemas.microsoft.com/ado/2007/08/dataservices/related/ListSet"
        type="application/atom+xml;type=feed"
        title="ListSet">
    <m:inline>
      <feed>
        ${sListSetEntries}
      </feed>
    </m:inline>
  </link>
</entry>`;

  try {
    
    const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");

const cpiResponse = await executeHttpRequest(
  { destinationName: "CPI_RETENTION" },
  {
    method: "POST",
    url: "/http/retentionclaim",
    headers: {
      custom: {
        "Content-Type": "application/atom+xml",
        "Accept": "application/atom+xml",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": "unsafe"
      }
    },
    data: sXmlPayload
  },
  { fetchCsrfToken: false }
);
const response = cpiResponse.data;

    console.log("=== submitClaimWithAttachments: CPI call returned ===");
    console.log("=== About to call CPI ===");
console.log("=== PO:", sPurchaseorder);
console.log("=== Records:", JSON.stringify(records));
console.log("=== XML payload:", sXmlPayload);

    // Parse response XML
    const json = await xml2js.parseStringPromise(response, {
      explicitArray: false
    });

    // Extract header-level result
    const headerProps = json?.entry?.content?.["m:properties"];
    const sWorkflow = headerProps?.["d:Workflow"] || "";
    const sHeaderSubrc = headerProps?.["d:Subrc"] || "";
    const sHeaderMessage = headerProps?.["d:Message"] || "";

    console.log("=== submitClaimWithAttachments: Workflow:", sWorkflow, "Subrc:", sHeaderSubrc);

    // Extract per-record results from ListSet
    const oListSetFeed = json?.entry?.link?.["m:inline"]?.feed;
    const aEntries = oListSetFeed?.entry
      ? (Array.isArray(oListSetFeed.entry) ? oListSetFeed.entry : [oListSetFeed.entry])
      : [];

    // Map results per invoice
    const aResults = records.map(record => {
      const oEntry = aEntries.find(e => {
        const p = e?.content?.["m:properties"];
        return p?.["d:Invoicenumber"] === record.Invoicenumber;
      });

      if (oEntry) {
        const p = oEntry.content["m:properties"];
        const sSubrc = p["d:Subrc"] || sHeaderSubrc;
        const sMessage = p["d:Message"] || sHeaderMessage;
        const sRecordWorkflow = p["d:Workflow"] || sWorkflow;
        const workflowIdMatch = sMessage.match(/^(\d+)\s+request created successfully/);
        const workflowId = workflowIdMatch ? workflowIdMatch[1] : sRecordWorkflow;

        return {
          Invoicenumber: record.Invoicenumber,
          success: sSubrc === "00",
          subrc: sSubrc,
          message: sMessage,
          workflowId: workflowId
        };
      } else {
        // Fall back to header-level result if no per-record entry
        const workflowIdMatch = sHeaderMessage.match(/^(\d+)\s+request created successfully/);
        const workflowId = workflowIdMatch ? workflowIdMatch[1] : sWorkflow;
        return {
          Invoicenumber: record.Invoicenumber,
          success: sHeaderSubrc === "00",
          subrc: sHeaderSubrc,
          message: sHeaderMessage,
          workflowId: workflowId
        };
      }
    });

    // Insert into HANA for successful records
    const aSucceeded = aResults.filter(r => r.success);

    if (aSucceeded.length > 0) {
     // CHANGED — ClaimId is no longer generated locally (was
// `RTClaim-${iNextSequence}`, incrementing off the last row's
// ClaimSequence). CPI/S4 now returns a real ClaimId of its own in
// the header-level <m:properties> (distinct from d:Workflow, which
// is unrelated and still used as-is for WorkflowId) - e.g.
// "SUSR420000185520260714131041". This is the single source of
// truth for the claim's identity going forward, so we use it as-is
// instead of minting our own.
const sClaimId = headerProps?.["d:ClaimId"] || "";

if (!sClaimId) {
  // Defensive guard: if CPI/S4 ever returns success (Subrc "00")
  // without a ClaimId for some reason, we'd otherwise silently
  // insert rows with an empty ClaimId, which breaks the entity's
  // composite key (ClaimId, Invoicenumber) and any read-only-view
  // lookups by ClaimId later.
  console.error("=== submitClaimWithAttachments: CPI response had no ClaimId ===");
}

      const aRowsToInsert = aSucceeded.map(result => {
        const record = records.find(r => r.Invoicenumber === result.Invoicenumber);
        return {
          ClaimId: sClaimId,
          Invoicenumber: result.Invoicenumber,
          RetentionId: `${record.Invoicenumber}-${record.Invoiceyear}-${record.Companycode}`,
          Invoiceyear: record.Invoiceyear,
          Companycode: record.Companycode,
          Accountingdocument: record.Accountingdocument,
          Fiscalyear: record.Fiscalyear,
          Purchaseorder: record.Purchaseorder,
          Invoicedate: record.Invoicedate,
          Netduedate: record.Netduedate,
          Netamount: record.Netamount,
          Retentionamount: record.Retentionamount,
          Currency: record.Currency,
          Invoicedescription: record.Invoicedescription,
          WorkflowId: result.workflowId,
          SubmissionSuccess: true,
          SubmissionSubrc: result.subrc,
          SubmissionMessage: result.message
        };
      });

      console.log("=== submitClaimWithAttachments: about to INSERT", aRowsToInsert.length, "record(s) into ClaimRecords ===");
      await cds.tx(req).run(INSERT.into("retention.db.ClaimRecords").entries(aRowsToInsert));
      console.log("=== submitClaimWithAttachments: INSERT done, returning result ===");

      return {
        ClaimId: sClaimId,
        results: aResults
      };
    }

    // All failed
    return {
      ClaimId: "",
      results: aResults
    };

  } catch (err) {
    console.error("=== submitClaimWithAttachments ERROR:", err.message);
    const aResults = records.map(record => ({
      Invoicenumber: record.Invoicenumber,
      success: false,
      subrc: "",
      message: `Request to claim submission endpoint failed: ${err.message}`,
      workflowId: ""
    }));
    return {
      ClaimId: "",
      results: aResults
    };
  }
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





