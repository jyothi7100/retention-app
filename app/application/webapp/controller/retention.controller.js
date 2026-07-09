sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/FilterType",
    "sap/ui/core/format/NumberFormat"
], (Controller, JSONModel, MessageToast, MessageBox, Filter, FilterOperator, FilterType, NumberFormat) => {
    "use strict";

    return Controller.extend("application.controller.Retention", {
        onInit() {

            this.getView().setModel(new JSONModel({ displayText: "" }), "loggedInUser");
            this._loadLoggedInUser();
            // CHANGED 2026-06-26: attachments now live entirely on
            // the new Claim Detail page (see
            // ClaimDetail.controller.js) - the dashboard no longer
            // has an Attachment column.
            //
            // CHANGED 2026-06-26 (second time): this._oSubmittedInvoiceNumbers
            // (in-memory-only, session-scoped) is REMOVED. Status
            // badges and KPI counts now use this._oClaimMap instead -
            // a real lookup built from the persisted ClaimRecords
            // table (see _loadRetentionData / _buildClaimMap), so
            // "is this submitted" correctly survives a page refresh
            // or a different browser session, not just the current
            // one.
            //
            // ADDED 2026-06-26: also re-fetches on every route match
            // (not just once on initial load) - navigating back from
            // the Claim Detail page does NOT destroy/recreate this
            // view or re-run onInit, so without this, a newly
            // submitted claim's hyperlink/status would only appear
            // after a manual page refresh. attachPatternMatched fires
            // every time this route becomes active, including
            // returning from elsewhere in the app.
            this.getOwnerComponent().getRouter()
                .getRoute("Routeretention")
                .attachPatternMatched(this._loadRetentionData, this);
        },

        _loadLoggedInUser: function () {
    const oModel = this.getOwnerComponent().getModel();
    const oOperation = oModel.bindContext("/whoAmI(...)");

    oOperation.execute().then(() => {
        const oResult = oOperation.getBoundContext().getObject();
        let sText = "Logged in as: " + oResult.id;
        if (oResult.anid) {
            sText += " (ANID: " + oResult.anid + ")";
        }
        this.getView().getModel("loggedInUser").setProperty("/displayText", sText);
    }).catch((oError) => {
        this.getView().getModel("loggedInUser").setProperty("/displayText", "Not authorized");

        const iStatusCode = oError?.error?.["@http.status"] || oError?.status || (oError?.message && oError.message.includes("403") ? 403 : null);

        if (iStatusCode === 403 || (oError?.message && oError.message.toLowerCase().includes("forbidden"))) {
            MessageToast.show("You are not authorized to access this application. Please contact your administrator.");
        } else {
            MessageToast.show("Unable to verify your login. Please try again.");
        }
    });
},
        // ---------------------------------------------------------
        // Load Retention Data + Claim Records from CAP Service
        // ---------------------------------------------------------
        // NOTE: FinalStatus values must match EXACTLY what
        // srv/retention-service.js (mapDocstatusToTile /
        // DOCSTATUS_TO_TILE) produces: "Retained", "Approved",
        // "Due for Refund", "Request In Progress", "Rejected",
        // "Paid" - mixed case, full words. Earlier versions of this
        // controller compared against uppercase short codes
        // (RETAINED, DUE, INPROGRESS, etc.) left over from an early
        // draft of the backend logic that was since replaced - that
        // mismatch was why every KPI count except "All" showed 0.
        //
        // CHANGED 2026-06-26: now ALSO fetches ClaimRecords (the
        // persisted table written by submitClaimWithAttachments) and
        // builds this._oClaimMap, an Invoicenumber -> ClaimRecords-row
        // lookup. This map is the new, real source of truth for "has
        // this record been submitted" - replacing the old in-memory-
        // only this._oSubmittedInvoiceNumbers, which didn't survive a
        // page refresh. Both fetches happen in parallel via
        // Promise.all, since they're independent of each other.
        _loadRetentionData: async function () {
            const oModel = this.getOwnerComponent().getModel();

            const [aRetentionContexts, aClaimContexts] = await Promise.all([
                oModel.bindList("/RetentionList").requestContexts(),
                oModel.bindList("/ClaimRecords").requestContexts()
            ]);

            // Stored on the controller (not just used locally) so
            // _recomputeKpiCounts can rebuild the KPI tile counts
            // later, after a claim submission changes a record's
            // effective status, without needing to re-fetch from the
            // server.
           this._aAllResults = aRetentionContexts.map(ctx => ctx.getObject());
            this._buildClaimMap(aClaimContexts.map(ctx => ctx.getObject()));

            // ADDED 2026-06-29: the table is now bound to this local
            // JSON model ("retentionList") instead of the OData model
            // directly - confirmed via diagnostic logging that
            // sap.ui.model.odata.v4.ODataListBinding.filter() never
            // actually triggered a refetch/re-render on this table's
            // binding (three different targeted fixes attempted -
            // refresh(), explicit FilterType.Application - none
            // worked, item count stayed at 30 every time despite
            // mAggregatedQueryOptions.$filter being correctly set) -
            // filtering a plain JS array and reassigning a JSONModel's
            // data is simple, synchronous, and has none of that
            // binding-lifecycle complexity.
            this.getView().setModel(new JSONModel({ records: this._aAllResults }), "retentionList");

            this._recomputeKpiCounts();
            // FIXED 2026-06-26: confirmed via diagnostic logging that
            // _oClaimMap WAS being built correctly (right data, right
            // keys) - the actual gap was that formatStatusText/
            // formatStatusState/formatClaimIdText/formatClaimIdVisible
            // are XML-bound formatters, and formatters do not
            // automatically re-run just because external (non-model)
            // controller state changed - only the underlying bound
            // model properties changing triggers that (same root
            // cause/limitation already confirmed earlier - see
            // _refreshStatusBadges, which worked around this for the
            // in-session submission flow before the Claim Detail page
            // existed). This refreshes the table's status badge and
            // claim-link cells directly/imperatively after EVERY
            // _loadRetentionData call (including on navigating back
            // from the Claim Detail page, not just an in-session
            // submission), so newly persisted claims show correctly
            // without requiring a manual page refresh.
            this._refreshClaimRelatedCells();
        },

        // Directly/imperatively re-applies the Status badge and Claim
        // ID link formatters to every currently-rendered row, since
        // XML formatter bindings do not re-run on their own when only
        // external (non-model) controller state - this._oClaimMap -
        // has changed. Walks every row the table currently has
        // rendered (not just specific Invoicenumbers, unlike the
        // narrower _refreshStatusBadges this replaces for this call
        // site) since _loadRetentionData affects the whole table, not
        // a specific selection.
        _refreshClaimRelatedCells: function () {
            const table = this.byId("retTable");
            if (!table) {
                return;
            }

            table.getItems().forEach(oItem => {
              const oContext = oItem.getBindingContext("retentionList");
                if (!oContext) {
                    return;
                }
                const oRowData = oContext.getObject();
                const sInvoicenumber = oRowData.Invoicenumber;
                const sFinalStatus = oRowData.FinalStatus;

                const oStatusControl = oItem.getCells().find(
                    ctrl => ctrl.getMetadata().getName() === "sap.m.ObjectStatus"
                );
                if (oStatusControl) {
                    oStatusControl.setText(this.formatStatusText(sFinalStatus, sInvoicenumber));
                    oStatusControl.setState(this.formatStatusState(sFinalStatus, sInvoicenumber));
                }
                oItem.setType(this.formatRowSelectable(sFinalStatus, sInvoicenumber));

                const oLinkControl = oItem.getCells().find(
                    ctrl => ctrl.getMetadata().getName() === "sap.m.Link"
                );
                if (oLinkControl) {
                    oLinkControl.setText(this.formatClaimIdText(sInvoicenumber));
                    oLinkControl.setVisible(this.formatClaimIdVisible(sInvoicenumber));
                }
            });
        },

        // Builds this._oClaimMap: Invoicenumber -> the full
        // ClaimRecords row for that record (ClaimId, CreatedDate,
        // AttachmentsJson, etc.) - since ClaimRecords has ONE row per
        // record (not per claim), each Invoicenumber maps to at most
        // one row, even if that claim originally covered multiple
        // records together.
        _buildClaimMap: function (aClaimRows) {
            this._oClaimMap = {};
            aClaimRows.forEach(oRow => {
                this._oClaimMap[oRow.Invoicenumber] = oRow;
            });
        },

        // Rebuilds the "kpi" JSONModel from this._aAllResults,
        // accounting for any records that have a real, persisted
        // claim (this._oClaimMap, built from ClaimRecords).
        //
        // BUSINESS RULE (corrected 2026-06-25, after an earlier
        // version of this rule had it backwards): once a claim is
        // submitted for a "Due for Refund" record, it moves ENTIRELY
        // out of "Due for Refund" and into "Request In Progress" -
        // standard single-status behavior. The six status tile
        // counts always sum to AllCount, both before and after any
        // submissions - there is no dual-counting.
        //
        // CHANGED 2026-06-26: this._oClaimMap is now built from the
        // real, persisted ClaimRecords table (see _loadRetentionData
        // / _buildClaimMap) rather than in-memory-only session
        // tracking - this correctly reflects submitted claims even
        // after a page refresh or in a brand new browser session.
        _recomputeKpiCounts: function () {
            const results = this._aAllResults || [];
            const oClaimMap = this._oClaimMap || {};

            const aSubmittedRefundRecords = results.filter(
                r => r.FinalStatus === "Due for Refund" && oClaimMap[r.Invoicenumber]
            );

            const kpiModel = new JSONModel({
                AllCount: results.length,
                RetainedCount: results.filter(r => r.FinalStatus === "Retained").length,
                // "Due for Refund" count now EXCLUDES any record that
                // has a persisted claim - it has effectively moved to
                // "Request In Progress" instead.
                RefundCount: results.filter(
                    r => r.FinalStatus === "Due for Refund" && !oClaimMap[r.Invoicenumber]
                ).length,
                // "Request In Progress" count includes both records
                // whose FinalStatus genuinely is that already (from
                // the backend), AND any "Due for Refund" record that
                // has a persisted claim.
                ProgressCount: results.filter(r => r.FinalStatus === "Request In Progress").length
                    + aSubmittedRefundRecords.length,
                ApprovedCount: results.filter(r => r.FinalStatus === "Approved").length,
                RejectedCount: results.filter(r => r.FinalStatus === "Rejected").length,
                PaidCount: results.filter(r => r.FinalStatus === "Paid").length
            });
            this.getView().setModel(kpiModel, "kpi");
        },

        // ---------------------------------------------------------
        // KPI Tile Press -> Filter Table
        // ---------------------------------------------------------
       onTilePress: function (oEvent) {
            const tileHeader = oEvent.getSource().getHeader();
            const aAllResults = this._aAllResults || [];

            let aFiltered;

            switch (tileHeader) {
                case "Retained":
                    aFiltered = aAllResults.filter(r => r.FinalStatus === "Retained");
                    break;

                case "Due for Refund":
                    // FIXED 2026-06-29: excludes any record that has
                    // a persisted claim (oClaimMap) - those display
                    // as "Request In Progress" instead (see the case
                    // above), same exclusion already used in
                    // _recomputeKpiCounts's RefundCount calculation,
                    // so this tile's filtered table matches its own
                    // tile count exactly.
                    aFiltered = aAllResults.filter(
                        r => r.FinalStatus === "Due for Refund" && !(this._oClaimMap && this._oClaimMap[r.Invoicenumber])
                    );
                    break;

                case "Request In Progress":
                    // FIXED 2026-06-29: "Request In Progress" is a
                    // display-only override (see formatStatusText) -
                    // a record's REAL backend FinalStatus stays "Due
                    // for Refund" even after a claim is submitted for
                    // it (that status is purely date-driven and
                    // doesn't change on its own - confirmed business
                    // rule from earlier this session). Filtering on
                    // the raw FinalStatus value "Request In Progress"
                    // matched nothing, since no record's real
                    // FinalStatus is ever literally that string -
                    // this needs the exact same condition already
                    // used by _recomputeKpiCounts/formatStatusText:
                    // real status is "Due for Refund" AND the record
                    // has a persisted claim in this._oClaimMap.
                    aFiltered = aAllResults.filter(
                        r => r.FinalStatus === "Due for Refund" && this._oClaimMap && this._oClaimMap[r.Invoicenumber]
                    );
                    break;

                case "Approved":
                    aFiltered = aAllResults.filter(r => r.FinalStatus === "Approved");
                    break;

                case "Rejected":
                    aFiltered = aAllResults.filter(r => r.FinalStatus === "Rejected");
                    break;

                case "Paid":
                    aFiltered = aAllResults.filter(r => r.FinalStatus === "Paid");
                    break;

                case "All":
                default:
                    aFiltered = aAllResults;
            }

            this.getView().getModel("retentionList").setData({ records: aFiltered });
            this._refreshClaimRelatedCells();
           // MessageToast.show("Filtered by: " + tileHeader);
        },

        // ---------------------------------------------------------
        // Search Button (Supplier + Fiscal Year)
        // ---------------------------------------------------------
        onSearch: function () {
            const supplier = this.byId("supplier").getValue();
            const year = this.byId("year").getValue();

            const table = this.byId("retTable");
            const binding = table.getBinding("items");

            const filters = [];

            if (supplier) {
                filters.push(new Filter("Supplier", FilterOperator.EQ, supplier));
            }

            if (year) {
                filters.push(new Filter("Fiscalyear", FilterOperator.EQ, year));
            }

            binding.filter(filters);

            MessageToast.show("Search applied");
        },

        // ---------------------------------------------------------
        // Multi-Select Checkbox Handler - enforces "one PO at a
        // time" selection rule
        // ---------------------------------------------------------
        // Business rule (confirmed with user, 2026-06-23): a claim
        // can only be submitted for retentions belonging to ONE
        // Purchaseorder (PO Number) at a time. Unlike the earlier
        // version of this handler (which only tracked selection
        // passively, validating at Submit time), this now actively
        // BLOCKS the conflicting checkbox the moment it's checked:
        // if the user already has row(s) selected from PO "A" and
        // checks a row from PO "B", that new row is immediately
        // un-checked again and a message explains why.
        //
        // this._sLockedPO tracks which PO the current selection is
        // "locked" to. It resets to null automatically once the
        // selection becomes empty (all rows unchecked), so the user
        // is then free to start a new selection on any PO.
        onSelectionChange: function (oEvent) {
            const table = this.byId("retTable");
            const oChangedItem = oEvent.getParameter("listItem");
            const bSelected = oEvent.getParameter("selected");

            // "Select All" / "Clear All" can fire selectionChange
            // without a single listItem (oChangedItem undefined) -
            // re-validate the whole selection in that case rather
            // than assuming a single-row change.
            if (!oChangedItem) {
                this._enforceSinglePOAcrossSelection(table);
                return;
            }

           const oChangedRow = oChangedItem.getBindingContext("retentionList").getObject();
            const sChangedPO = oChangedRow.Purchaseorder;
            const sChangedInvoicenumber = oChangedRow.Invoicenumber;

            // ADDED 2026-06-27: a record that already has a real,
            // persisted claim (i.e. its displayed status is "Request
            // In Progress" via formatRowSelectable's exact same
            // condition) can't be selected for another submission.
            // Discovered that ColumnListItem's "type=Inactive" binding
            // does NOT disable the row's selection checkbox (confirmed
            // via DOM inspection - the class was correctly applied but
            // the checkbox remained checkable regardless) - type only
            // affects row press/navigation behavior, not the
            // MultiSelect checkbox itself. Blocking selection directly
            // here, the same proven pattern already used for the
            // cross-PO conflict below, is what actually works.
            if (bSelected && this.formatRowSelectable(oChangedRow.FinalStatus, sChangedInvoicenumber) === "Inactive") {
                table.setSelectedItem(oChangedItem, false);
                MessageToast.show("This record already has a claim in progress and cannot be selected.");
                return;
            }

            if (bSelected) {
                if (this._sLockedPO && sChangedPO !== this._sLockedPO) {
                    // Conflict: block this specific row, leave
                    // everything else untouched.
                    table.setSelectedItem(oChangedItem, false);
                    MessageToast.show("Please select one PO invoice at a time.");
                    return;
                }
                // First row selected, or matches the already-locked PO.
                this._sLockedPO = sChangedPO;
            }

            this._updateSelectionState(table);
        },

        // Re-checks the entire current selection (used after a
        // Select All / Clear All action) and trims it down to a
        // single PO if it somehow contains more than one - this is
        // a safety net; Select All on a table that already mixes
        // POs would otherwise bypass the per-row check above.
        _enforceSinglePOAcrossSelection: function (table) {
            const aSelectedItems = table.getSelectedItems();
            if (aSelectedItems.length === 0) {
                this._sLockedPO = null;
                this._aSelectedItems = [];
                return;
            }

            let bHadConflict = false;

            // ADDED 2026-06-27: Select All can select already-claimed
            // rows too, same gap as the single-row case above - strip
            // those out first, before even establishing sFirstPO, so
            // an all-claimed-rows edge case doesn't crash on an empty
            // array below.
            aSelectedItems.slice().forEach(item => {
                const oRow = item.getBindingContext("retentionList").getObject();
                if (this.formatRowSelectable(oRow.FinalStatus, oRow.Invoicenumber) === "Inactive") {
                    table.setSelectedItem(item, false);
                    bHadConflict = true;
                }
            });

            const aRemainingItems = table.getSelectedItems();
            if (aRemainingItems.length === 0) {
                this._sLockedPO = null;
                this._aSelectedItems = [];
                if (bHadConflict) {
                    MessageToast.show("Records already in progress cannot be selected.");
                }
                return;
            }

            const sFirstPO = aRemainingItems[0].getBindingContext().getObject().Purchaseorder;

            aRemainingItems.forEach(item => {
                const sPO = item.getBindingContext("retentionList").getObject().Purchaseorder;
                if (sPO !== sFirstPO) {
                    table.setSelectedItem(item, false);
                    bHadConflict = true;
                }
            });
            if (bHadConflict) {
                MessageToast.show("Please select one PO invoice at a time.");
            }

            this._sLockedPO = sFirstPO;
            this._updateSelectionState(table);
        },

        _updateSelectionState: function (table) {
  this._aSelectedItems = table.getSelectedItems()
    .filter(item => item.getBindingContext("retentionList") !== null)
    .map(item => item.getBindingContext("retentionList").getObject());
  
  if (this._aSelectedItems.length === 0) {
    this._sLockedPO = null;
  }
},

        // ---------------------------------------------------------
        // Submit Claim button handler
        // ---------------------------------------------------------
        // By the time this fires, onSelectionChange has already
        // guaranteed the selection is limited to a single PO (it's
        // not possible to reach this with a mixed-PO selection) -
        // this still re-checks defensively in case the selection
        // state was somehow manipulated outside the normal flow.
        //
        // CHANGED 2026-06-26: no longer opens the in-page Submit
        // Claim dialog. Instead, hands off the selected PO + records
        // to the Component (see Component.js -
        // setSelectedClaimRecords) and navigates to the new
        // ClaimDetail page, which now owns the entire
        // attachment-and-submit flow.
        //
        // FIXED 2026-06-26: the table's selection (checkboxes) was
        // staying checked when the user navigated back from the
        // Claim Detail page, reported by the user as a bug - since
        // there's no reason to keep the previous selection visually
        // active once the user has left this page to act on it,
        // removeSelections(true) clears it immediately before
        // navigating away, rather than leaving it for whenever (if
        // ever) the user happens to revisit this page later.
        onSubmitClaim: function () {
            const table = this.byId("retTable");
           const aSelected = table.getSelectedItems().map(item => item.getBindingContext("retentionList").getObject());

            if (aSelected.length === 0) {
                MessageToast.show("Please select at least one record to submit a claim.");
                return;
            }

            const aDistinctPOs = [...new Set(aSelected.map(row => row.Purchaseorder))];

            if (aDistinctPOs.length > 1) {
                // Should not be reachable given onSelectionChange's
                // enforcement, but kept as a defensive safety net.
                MessageToast.show("Please select one PO invoice at a time.");
                return;
            }

            this.getOwnerComponent().setSelectedClaimRecords(aDistinctPOs[0], aSelected);
            table.removeSelections(true);
            this._sLockedPO = null;
            this.getOwnerComponent().getRouter().navTo("RouteClaimDetail");
        },

        // ---------------------------------------------------------
        // Status Badge Formatters
        // ---------------------------------------------------------
        // Override the displayed Status text/state for any record
        // that has a real, persisted claim (this._oClaimMap, built
        // from ClaimRecords - CHANGED 2026-06-26 from in-memory-only
        // session tracking) - such a record shows "Request In
        // Progress" / Information state instead of its real backend
        // FinalStatus, per the business rule confirmed with the user:
        // submitting a claim moves the record's status to "Request In
        // Progress", consistent with the same change in
        // _recomputeKpiCounts's tile counts. Every other record's
        // text/state is unchanged from the original inline-expression
        // logic this replaced (kept identical, just moved into JS so
        // it can consult data the XML binding couldn't reach).
        formatStatusText: function (sFinalStatus, sInvoicenumber) {
            if (this._oClaimMap && this._oClaimMap[sInvoicenumber]) {
                return "Request In Progress";
            }
            return sFinalStatus;
        },

        formatStatusState: function (sFinalStatus, sInvoicenumber) {
            if (this._oClaimMap && this._oClaimMap[sInvoicenumber]) {
                return "Information";
            }
            switch (sFinalStatus) {
                case "Approved":
                case "Paid":
                case "Retained":
                    return "Success";
                case "Rejected":
                    return "Error";
                case "Due for Refund":
                    return "Warning";
                case "Request In Progress":
                    return "Information";
                default:
                    return "None";
            }
        },

        formatRowSelectable: function (sFinalStatus, sInvoicenumber) {
  // Retained status — not yet eligible for claim
  if (sFinalStatus === "Retained") {
    return "Inactive";
  }
  // Already claimed — prevent duplicate claim
  if (this._oClaimMap && this._oClaimMap[sInvoicenumber] && sFinalStatus === "Due for Refund") {
    return "Inactive";
  }
  return "Active";
},
formatDate: function (sDate) {
  if (!sDate) return "";
  const oDate = new Date(sDate);
  if (isNaN(oDate.getTime())) return sDate;
  const aMonths = ["Jan","Feb","Mar","Apr","May","Jun",
                   "Jul","Aug","Sep","Oct","Nov","Dec"];
  const sDay = oDate.getDate();
  const sMonth = aMonths[oDate.getMonth()];
  const sYear = oDate.getFullYear();
  return `${sDay} ${sMonth} ${sYear}`;
},

        // ---------------------------------------------------------
        // Claim ID Link Formatters + Press Handler
        // ---------------------------------------------------------
        // Added 2026-06-26. formatClaimIdText/formatClaimIdVisible
        // both read from this._oClaimMap (Invoicenumber -> that
        // record's ClaimRecords row) - blank/hidden for any record
        // with no persisted claim, the real ClaimId text otherwise.
        formatClaimIdText: function (sInvoicenumber) {
            const oClaim = this._oClaimMap && this._oClaimMap[sInvoicenumber];
            return oClaim ? oClaim.ClaimId : "";
        },

        formatClaimIdVisible: function (sInvoicenumber) {
            return !!(this._oClaimMap && this._oClaimMap[sInvoicenumber]);
        },

        // CHANGED 2026-06-27: per user requirement, clicking a Claim
        // ID link now navigates to the Claim Detail page in read-only
        // mode (showing ALL records that share this ClaimId, with no
        // submit button or upload control), instead of opening the
        // old MessageBox.information popup. Gathers every row from
        // this._aAllResults whose Invoicenumber maps to a ClaimRecords
        // entry with this exact ClaimId - a claim can cover multiple
        // records, but ClaimRecords has one row per record, so we
        // can't just look up "the claim" as a single object; we
        // reconstruct its full record list by filtering on ClaimId.
        onClaimIdPress: function (oEvent) {
            const sInvoicenumber = oEvent.getSource().getBindingContext("retentionList").getObject().Invoicenumber;
            const oClaim = this._oClaimMap && this._oClaimMap[sInvoicenumber];
            if (!oClaim) {
                return;
            }

            const sClaimId = oClaim.ClaimId;
            const oClaimMap = this._oClaimMap || {};
            const aClaimRecords = (this._aAllResults || [])
                .filter(r => oClaimMap[r.Invoicenumber] && oClaimMap[r.Invoicenumber].ClaimId === sClaimId)
                .map(r => ({
                    ...r,
                    AttachmentsJson: oClaimMap[r.Invoicenumber].AttachmentsJson,
                    ClaimId: oClaimMap[r.Invoicenumber].ClaimId
                }));

            this.getOwnerComponent().setViewClaimRecords(sClaimId, aClaimRecords);
            this.getOwnerComponent().getRouter().navTo("RouteClaimDetail", { query: { mode: "view", claimId: sClaimId } });
        },
        // ---------------------------------------------------------
        // Format a numeric amount with its currency code, e.g.
        // formatAmountWithCurrency(-27890, "AED") -> "-27,890.00 AED"
        //
        // FIXED 2026-06-22: S/4 sometimes sends negative amounts using
        // the ABAP/SAP convention of a TRAILING minus sign (e.g.
        // "27890.00-" instead of "-27890.00"). Number("27890.00-") is
        // NaN, which NumberFormat then renders as an empty string -
        // this was why Net Value showed blank (just the currency code
        // with nothing in front of it) for every negative row, while
        // Retention Amount (always 0.00 in this dataset, never
        // negative) looked fine. normalizeSapNumber() below detects
        // and corrects the trailing-minus format before parsing.
        // ---------------------------------------------------------
        formatAmountWithCurrency: function (amount, currency) {
            if (amount === undefined || amount === null || amount === "") {
                return "";
            }
            const numericValue = this._normalizeSapNumber(amount);
            if (isNaN(numericValue)) {
                return "";
            }
            const oNumberFormat = NumberFormat.getFloatInstance({
                minFractionDigits: 2,
                maxFractionDigits: 2,
                groupingEnabled: true
            });
            const formatted = oNumberFormat.format(numericValue);
            return currency ? `${formatted} ${currency}` : formatted;
        },

        // Converts SAP's trailing-minus negative number format
        // (e.g. "27890.00-") into a normal JS-parseable number.
        // Leaves already-normal values (numbers, "-27890.00",
        // "27890.00") untouched.
        _normalizeSapNumber: function (value) {
            if (typeof value === "number") {
                return value;
            }
            const str = String(value).trim();
            if (str.endsWith("-")) {
                return Number("-" + str.slice(0, -1));
            }
            return Number(str);
        }
    });
});