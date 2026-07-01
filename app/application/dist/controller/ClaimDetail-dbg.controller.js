sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/NumberFormat",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/HBox",
    "sap/m/VBox",
    "sap/m/Text",
    "sap/m/Column",
    "sap/m/ColumnListItem",
    "sap/ui/core/Icon",
    "sap/ui/unified/FileUploader"
], (Controller, JSONModel, NumberFormat, MessageToast, MessageBox, HBox, VBox, Text, Column, ColumnListItem, Icon, FileUploader) => {
    "use strict";

    return Controller.extend("application.controller.ClaimDetail", {
        onInit: function () {
            this.getOwnerComponent().getRouter()
                .getRoute("RouteClaimDetail")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        // ---------------------------------------------------------
        // Route Matched - read the selected records handed off by
        // the retention dashboard page via the Component (see
        // Component.js - setSelectedClaimRecords/
        // getSelectedClaimRecords), since route parameters in the
        // URL aren't practical for a full array of record objects.
        // ---------------------------------------------------------
        _onRouteMatched: function (oEvent) {
            const oArgs = oEvent.getParameter("arguments") || {};
            const oQuery = oArgs["?query"] || {};
            const bReadOnly = oQuery.mode === "view";
            this._oAttachments = {};

            if (bReadOnly) {
                const oData = this.getOwnerComponent().getViewClaimRecords();
                this._aRecords = oData.records;
                this._sPO = this._aRecords.length > 0 ? this._aRecords[0].Purchaseorder : "";

                if (this._aRecords.length === 0) {
                    MessageToast.show("No claim records to display. Returning to the dashboard.");
                    this.getOwnerComponent().getRouter().navTo("Routeretention");
                    return;
                }

                this.byId("_IDGenClaimHeaderTitle").setText(
                    "Claim " + oData.claimId + " - PO " + this._sPO
                );
            } else {
                const oData = this.getOwnerComponent().getSelectedClaimRecords();
                this._sPO = oData.po;
                this._aRecords = oData.records;

                if (!this._sPO || this._aRecords.length === 0) {
                    MessageToast.show("No claim records to display. Returning to the dashboard.");
                    this.getOwnerComponent().getRouter().navTo("Routeretention");
                    return;
                }

                this.byId("_IDGenClaimHeaderTitle").setText(
                    "Claiming Retention Against PO " + this._sPO
                );
            }

            const oModel = new JSONModel({ records: this._aRecords });
            this.getView().setModel(oModel, "claimRecords");

            const oReadOnlyModel = new JSONModel({ readOnly: bReadOnly });
            this.getView().setModel(oReadOnlyModel, "viewState");

            if (bReadOnly) {
                this._renderReadOnlyAttachments();
            } else {
                this._injectAttachmentCells();
            }
        },
        // ---------------------------------------------------------
        // Back Navigation
        // ---------------------------------------------------------
        onNavBack: function () {
            this.getOwnerComponent().getRouter().navTo("Routeretention");
        },

        // ---------------------------------------------------------
        // Inject per-row Attachment controls into the table
        // ---------------------------------------------------------
        // The table's rows are now created by the "claimRecords>"
        // model binding (one ColumnListItem per record, from the
        // static XML template), NOT built in JS like the dashboard's
        // table - but each row's LAST cell is a placeholder, empty
        // VBox (see the view), specifically so this method can find
        // it via oItem.getCells() and inject a FileUploader +
        // attached-files list into it, the same way the dashboard
        // injects attachment controls into its own table rows. This
        // mirrors retention.controller.js's _refreshViewAttachmentIcons
        // pattern (walk table.getItems(), match by Invoicenumber via
        // getBindingContext()) rather than relying on any static XML
        // id, since a templated row's id is NOT unique per clone -
        // only one instance would ever be found that way.
        //
        // FIXED 2026-06-26: this method could run more than once
        // against the SAME rendered row (e.g. if _onRouteMatched's
        // setModel() + this call happen to overlap with an earlier
        // call's setTimeout still pending), which was duplicating the
        // "Attach a file (optional)" link and file-list box in each
        // row - reported by the user as the link appearing twice per
        // record. Explicitly clearing oAttachmentBox's existing
        // content via destroyItems() before injecting makes this
        // method idempotent - safe to call multiple times against
        // the same row without piling up duplicate controls.
        _injectAttachmentCells: function () {
            const oTable = this.byId("_IDGenClaimRecordsTable");

            // Table rows render asynchronously after the model is
            // set - a short delay ensures getItems() actually returns
            // the real rows rather than an empty array from before
            // the binding has rendered.
            setTimeout(() => {
                oTable.getItems().forEach(oItem => {
                    const oContext = oItem.getBindingContext("claimRecords");
                    if (!oContext) {
                        return;
                    }
                    const record = oContext.getObject();
                    const sInvoicenumber = record.Invoicenumber;
                    const sRetentionId = sInvoicenumber + "-" + record.Invoiceyear + "-" + record.Companycode;

                    const oAttachmentBox = oItem.getCells().find(
                        ctrl => ctrl.getMetadata().getName() === "sap.m.VBox"
                    );
                    if (!oAttachmentBox) {
                        return;
                    }

                    // Clear any previously-injected content for this
                    // row before adding new controls - this is what
                    // makes repeated calls safe.
                    oAttachmentBox.destroyItems();

                    const oFileListBox = new VBox().addStyleClass("sapUiTinyMarginTop");

                    const oFileUploader = new FileUploader({
                        iconOnly: false,
                        buttonOnly: true,
                        buttonText: "Attach a file (optional)",
                        multiple: true,
                        fileType: ["pdf", "docx", "xlsx", "txt", "csv", "jpg", "jpeg", "png"],
                        tooltip: "Attach file(s) for " + sRetentionId,
                        style: "Transparent",
                        change: (oEvent) => this._onFileSelected(oEvent, sInvoicenumber, oFileListBox),
                        typeMissmatch: () => MessageToast.show("Unsupported file type")
                    }).addStyleClass("attachFileLinkStyle");

                    oAttachmentBox.addItem(oFileUploader);
                    oAttachmentBox.addItem(oFileListBox);
                });
            }, 0);
        },
        _renderReadOnlyAttachments: async function () {
    const oTable = this.byId("_IDGenClaimRecordsTable");
    const oModel = this.getOwnerComponent().getModel();

    setTimeout(async () => {
        for (const oItem of oTable.getItems()) {
            const oContext = oItem.getBindingContext("claimRecords");
            if (!oContext) continue;
            const record = oContext.getObject();

            const oAttachmentBox = oItem.getCells().find(
                ctrl => ctrl.getMetadata().getName() === "sap.m.VBox"
            );
            if (!oAttachmentBox) continue;
            oAttachmentBox.destroyItems();

            try {
                // Fetch actual attachments from HANA via OData
                const aContexts = await oModel
                    .bindList(`/ClaimRecords(ClaimId='${record.ClaimId}',Invoicenumber='${record.Invoicenumber}')/attachments`)
                    .requestContexts();

                const aAttachments = aContexts.map(ctx => ctx.getObject());

                if (aAttachments.length === 0) {
                    oAttachmentBox.addItem(new Text({ text: "None" }));
                    return;
                }

                aAttachments.forEach(oFile => {
                    oAttachmentBox.addItem(new Text({
                        text: oFile.filename || oFile.name || "",
                        tooltip: oFile.filename || oFile.name || "",
                        width: "9rem",
                        wrapping: false
                    }).addStyleClass("sapUiTinyMarginTop"));
                });
            } catch (e) {
                oAttachmentBox.addItem(new Text({ text: "Could not load attachments." }));
            }
        }
    }, 0);
},
        // ADDED 2026-06-27: restricts attachments to a fixed allowlist
        // of file extensions, per user requirement - reported issue
        // was that a .exe file could be attached, since the
        // FileUploader's "accept" XML property is only an HTML hint
        // (narrows what the OS file picker shows by default) and does
        // NOT actually block a user from selecting a different file
        // type anyway - genuine validation has to happen here, in
        // JS, checking each selected file's actual name before it's
        // ever added to this._oAttachments. Checked by extension
        // only (not MIME type) since a renamed/mislabeled file's
        // reported MIME type can't be trusted any more than its
        // extension can - this is a basic usability guard against
        // accidental wrong-file selection, not a security boundary
        // (a determined user could still rename a .exe to .pdf) -
        // genuine malicious-content scanning would need to happen
        // server-side, out of scope here.
       _onFileSelected: function (oEvent, sInvoicenumber, oFileListBox) {
            console.log("=== _onFileSelected fired ===", oEvent.getParameter("files"));
            const aNewFiles = Array.from(oEvent.getParameter("files") || []);
            if (aNewFiles.length === 0) {
                return;
            }

            const aAllowed = [];
            const aRejected = [];
            aNewFiles.forEach(oFile => {
                if (this._isAllowedAttachmentType(oFile)) {
                    aAllowed.push(oFile);
                } else {
                    aRejected.push(oFile.name);
                }
            });

            if (aRejected.length > 0) {
                MessageBox.error("Unsupported file type");
            }

            if (aAllowed.length === 0) {
                return;
            }

            const aExisting = this._oAttachments[sInvoicenumber] || [];
            this._oAttachments[sInvoicenumber] = aExisting.concat(aAllowed);

            this._renderFileList(sInvoicenumber, oFileListBox);
        },

        // Allowlist check by file extension - see _onFileSelected's
        // comment for why extension-only and why this isn't a
        // security boundary.
        _isAllowedAttachmentType: function (oFile) {
            const aAllowedExtensions = [".pdf", ".docx", ".xlsx", ".txt", ".csv", ".jpg", ".jpeg", ".png"];
            const sName = (oFile.name || "").toLowerCase();
            return aAllowedExtensions.some(sExt => sName.endsWith(sExt));
        },
        // Rebuilds oFileListBox's contents from scratch, showing one
        // row per file currently attached to sInvoicenumber: the
        // filename (FIXED 2026-06-26: now given a fixed width with
        // ellipsis truncation - text-overflow is handled natively by
        // sap.m.Text's maxLines/width combination - plus the full
        // name in a tooltip, since an unbounded-width Text control
        // was overlapping/crowding the view/download/remove icons
        // for long filenames, per user-reported issue), plus the
        // three action icons.
        _renderFileList: function (sInvoicenumber, oFileListBox) {
            oFileListBox.destroyItems();

            const aFiles = this._oAttachments[sInvoicenumber] || [];
            aFiles.forEach((oFile, iIndex) => {
                const oRemoveIcon = new Icon({
                    src: "sap-icon://decline",
                    color: "Critical",
                    tooltip: "Remove this file",
                    press: () => {
                        this._oAttachments[sInvoicenumber].splice(iIndex, 1);
                        this._renderFileList(sInvoicenumber, oFileListBox);
                    }
                }).addStyleClass("sapUiTinyMarginBegin");

                const oViewIcon = new Icon({
                    src: "sap-icon://show",
                    color: "Neutral",
                    tooltip: "View this file",
                    press: () => this._openFileForView(oFile)
                }).addStyleClass("sapUiTinyMarginBegin");

                const oDownloadIcon = new Icon({
                    src: "sap-icon://download",
                    color: "Neutral",
                    tooltip: "Download this file",
                    press: () => this._downloadFile(oFile)
                }).addStyleClass("sapUiTinyMarginBegin");

                const oFileNameText = new Text({
                    text: oFile.name,
                    tooltip: oFile.name,
                    width: "9rem",
                    wrapping: false
                });

                oFileListBox.addItem(new HBox({
                    alignItems: "Center",
                    items: [
                        oFileNameText,
                        oViewIcon,
                        oDownloadIcon,
                        oRemoveIcon
                    ]
                }).addStyleClass("sapUiTinyMarginTop"));
            });
        },

        // FIXED 2026-06-26: now routes .csv/.docx/.xlsx to real in-app
        // preview dialogs, same as the dashboard used to do before
        // its Attachment column was removed - reported by the user
        // as "View" downloading these files instead of previewing
        // them, since this page's earlier version only had the
        // browser-native window.open fallback. .pdf and .txt are
        // confirmed by the user to be fine with that native fallback
        // (browsers render both inline already), so only csv/docx/
        // xlsx needed dedicated handling, ported directly from
        // retention.controller.js's confirmed-working
        // _showCsvPreview/_showDocxPreview/_showXlsxPreview methods.
        _openFileForView: function (oFile) {
            if (this._isCsvFile(oFile)) {
                this._showCsvPreview(oFile);
                return;
            }
            if (this._isDocxFile(oFile)) {
                this._showDocxPreview(oFile);
                return;
            }
            if (this._isXlsxFile(oFile)) {
                this._showXlsxPreview(oFile);
                return;
            }
            const sUrl = URL.createObjectURL(oFile);
            window.open(sUrl, "_blank");
            // Deliberately not revoking the object URL immediately
            // (URL.revokeObjectURL) since the new tab needs it to
            // remain valid while it loads.
        },

        // Detects a CSV file by extension (".csv") or MIME type
        // ("text/csv") - browsers/OSes are inconsistent about which
        // one they actually set on a File object, so both are
        // checked rather than relying on just one.
        _isCsvFile: function (oFile) {
            const sName = (oFile.name || "").toLowerCase();
            const sType = (oFile.type || "").toLowerCase();
            return sName.endsWith(".csv") || sType === "text/csv";
        },

        // Detects a .docx file by extension or its standard MIME
        // type. Does NOT match legacy .doc (different binary format,
        // Mammoth.js only supports the newer .docx XML-based format).
        _isDocxFile: function (oFile) {
            const sName = (oFile.name || "").toLowerCase();
            const sType = (oFile.type || "").toLowerCase();
            return sName.endsWith(".docx") ||
                sType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        },

        // Detects a .xlsx file by extension or its standard MIME
        // type. Does NOT match legacy .xls (different binary format) -
        // SheetJS can actually read .xls too, but scope here is
        // limited to .xlsx per the agreed requirement.
        _isXlsxFile: function (oFile) {
            const sName = (oFile.name || "").toLowerCase();
            const sType = (oFile.type || "").toLowerCase();
            return sName.endsWith(".xlsx") ||
                sType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        },

        // Converts a .docx File to HTML via Mammoth.js (loaded as a
        // global from manifest.json's sap.ui5.resources.js - see
        // window.mammoth) and shows it in the shared HTML preview
        // dialog. Mammoth's browser API takes an ArrayBuffer, not
        // text, so this reads the file differently than the CSV path.
        _showDocxPreview: function (oFile) {
            if (!window.mammoth) {
                MessageToast.show("The document preview library did not load. Please check your connection and reload the page.");
                return;
            }
            const oReader = new FileReader();
            oReader.onload = () => {
                window.mammoth.convertToHtml({ arrayBuffer: oReader.result })
                    .then(oResult => {
                        this._renderHtmlPreview(oFile.name, "<div>" + oResult.value + "</div>");
                    })
                    .catch((oError) => {
                        console.error("Mammoth docx conversion error:", oError);
                        MessageToast.show("Could not convert this Word document for preview: " + (oError.message || oError));
                    });
            };
            oReader.onerror = () => {
                MessageToast.show("Could not read the Word document for preview.");
            };
            oReader.readAsArrayBuffer(oFile);
        },

        // Converts a .xlsx File to an HTML table via SheetJS (loaded
        // as a global from manifest.json's sap.ui5.resources.js - see
        // window.XLSX) and shows it in the shared HTML preview dialog.
        // Only the FIRST sheet of the workbook is shown - a multi-
        // sheet selector is out of scope for a simple attachment
        // preview.
        _showXlsxPreview: function (oFile) {
            if (!window.XLSX) {
                MessageToast.show("The spreadsheet preview library did not load. Please check your connection and reload the page.");
                return;
            }
            const oReader = new FileReader();
            oReader.onload = () => {
                try {
                    const oWorkbook = window.XLSX.read(oReader.result, { type: "array" });
                    const sFirstSheetName = oWorkbook.SheetNames[0];
                    const oSheet = oWorkbook.Sheets[sFirstSheetName];
                    const sHtmlTable = window.XLSX.utils.sheet_to_html(oSheet);
                    this._renderHtmlPreview(oFile.name, "<div>" + sHtmlTable + "</div>");
                } catch (oError) {
                    MessageToast.show("Could not read this Excel file for preview.");
                }
            };
            oReader.onerror = () => {
                MessageToast.show("Could not read the Excel file for preview.");
            };
            oReader.readAsArrayBuffer(oFile);
        },

        // Shared by _showDocxPreview/_showXlsxPreview - sets the HTML
        // preview dialog's title and content, then opens it. Toggles
        // the HTML control's visibility off/on around setContent(),
        // since setContent() alone doesn't reliably force a full
        // re-render between different previews in all browsers (a
        // documented SAPUI5 quirk, not specific to this app).
        _renderHtmlPreview: function (sFileName, sHtml) {
            const oHtmlControl = this.byId("_IDGenHtmlPreviewContent");
            oHtmlControl.setVisible(false);
            oHtmlControl.setContent(sHtml);
            oHtmlControl.setVisible(true);

            const oModel = new JSONModel({ fileName: sFileName });
            this.getView().setModel(oModel, "htmlPreview");

            this.byId("_IDGenHtmlPreviewDialog").open();
        },

        // Closes the HTML preview dialog (shared by docx/xlsx previews).
        onHtmlPreviewClose: function () {
            this.byId("_IDGenHtmlPreviewDialog").close();
        },

        // Reads a CSV File object's text content, parses it into
        // rows/columns, and opens the CSV preview dialog with a
        // dynamically-built table (built fresh each time, since
        // different CSVs can have different numbers of columns).
        _showCsvPreview: function (oFile) {
            const oReader = new FileReader();
            oReader.onload = () => {
                const aRows = this._parseCsv(oReader.result);
                this._renderCsvPreviewTable(oFile.name, aRows);
            };
            oReader.onerror = () => {
                MessageToast.show("Could not read the CSV file for preview.");
            };
            oReader.readAsText(oFile);
        },

        // Minimal CSV parser: splits on newlines, then on commas per
        // line. Does NOT handle quoted fields containing commas or
        // embedded newlines (a full RFC 4180 parser is out of scope
        // for a simple attachment preview) - this covers the common,
        // simple CSV case adequately. Returns an array of arrays of
        // strings, first row treated as the header.
        _parseCsv: function (sText) {
            return sText
                .split(/\r\n|\n|\r/)
                .filter(sLine => sLine.length > 0)
                .map(sLine => sLine.split(","));
        },

        // Builds the preview table's columns and rows dynamically
        // from the parsed CSV (since column count varies per file),
        // then opens the dialog. Replaces the table's columns/items
        // aggregations fresh each time rather than trying to reuse a
        // fixed, predeclared structure - this is the simplest correct
        // approach when the schema (number of columns) isn't known
        // ahead of time.
        _renderCsvPreviewTable: function (sFileName, aRows) {
            const oTable = this.byId("_IDGenCsvPreviewTable");
            oTable.destroyColumns();
            oTable.unbindItems();
            oTable.removeAllItems();

            if (aRows.length === 0) {
                MessageToast.show("This CSV file appears to be empty.");
                return;
            }

            const aHeader = aRows[0];
            const aDataRows = aRows.slice(1);

            aHeader.forEach(sColumnName => {
                oTable.addColumn(new Column({
                    header: new Text({ text: sColumnName || "" })
                }));
            });

            aDataRows.forEach(aRowValues => {
                const aCells = aHeader.map((_, iIndex) =>
                    new Text({ text: aRowValues[iIndex] !== undefined ? aRowValues[iIndex] : "" })
                );
                oTable.addItem(new ColumnListItem({ cells: aCells }));
            });

            const oCsvModel = new JSONModel({ fileName: sFileName });
            this.getView().setModel(oCsvModel, "csvPreview");

            this.byId("_IDGenCsvPreviewDialog").open();
        },

        // Closes the CSV preview dialog. The table's dynamically-built
        // columns/items are left in place until the next preview
        // (rebuilt fresh by _renderCsvPreviewTable each time), so
        // there's nothing else to clean up here.
        onCsvPreviewClose: function () {
            this.byId("_IDGenCsvPreviewDialog").close();
        },

        _downloadFile: function (oFile) {
            const sUrl = URL.createObjectURL(oFile);
            const oLink = document.createElement("a");
            oLink.href = sUrl;
            oLink.download = oFile.name;
            document.body.appendChild(oLink);
            oLink.click();
            document.body.removeChild(oLink);
            setTimeout(() => URL.revokeObjectURL(sUrl), 1000);
        },

        // ---------------------------------------------------------
        // Send to S4 button handler
        // ---------------------------------------------------------
        // Calls the combined submitClaimWithAttachments action (see
        // srv/retention-service.cds/.js), which does THREE things
        // together in one call: sends the records to CPI/S4, persists
        // one ClaimRecords row per record in HANA (all sharing one
        // generated ClaimId), and stores each record's attachment
        // file METADATA (name/size/type, not the file bytes - see the
        // ClaimRecords entity comment for why) alongside its row.
        onSendToS4: function () {
            const oPage = this.byId("claimDetailPage");
            oPage.setBusy(true);

            const oModel = this.getOwnerComponent().getModel();
            const oAction = oModel.bindContext("/submitClaimWithAttachments(...)");

           
           

            oAction.setParameter("records", this._aRecords.map(record => ({
                Invoicenumber: record.Invoicenumber,
                Invoiceyear: record.Invoiceyear,
                Companycode: record.Companycode,
                Accountingdocument: record.Accountingdocument,
                Fiscalyear: record.Fiscalyear,
                Purchaseorder: record.Purchaseorder
            })));
           

            console.log("=== onSendToS4: about to invoke action ===");
            oAction.invoke()
                .then(() => {
                    console.log("=== onSendToS4: invoke() resolved ===");
                    return oAction.getBoundContext().requestObject();
                })
               .then(async (oResult) => {
    console.log("=== onSendToS4: requestObject() resolved with:", JSON.stringify(oResult));
    await this._uploadAttachments(oResult.ClaimId);
    this._showResultsAndNavigateBack(oResult);

                })
                .catch((oError) => {
                    console.log("=== onSendToS4: caught error:", oError);
                    MessageBox.error(
                        "Could not reach the claim submission service: " +
                        (oError.message || "unknown error")
                    );
                })
                .finally(() => {
                    oPage.setBusy(false);
                });
        },

        _uploadAttachments: async function (sClaimId) {
    const sServiceUrl = this.getOwnerComponent().getModel().getServiceUrl();

    for (const [sInvoicenumber, aFiles] of Object.entries(this._oAttachments)) {
        for (const oFile of aFiles) {
            try {
                // Step 1: POST to create the attachment metadata entry
                const sPostUrl = `${sServiceUrl}ClaimRecords(ClaimId='${sClaimId}',Invoicenumber='${sInvoicenumber}')/attachments`;
                const oPostResponse = await fetch(sPostUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename: oFile.name, mimeType: oFile.type })
                });
                if (!oPostResponse.ok) {
                    console.error("Failed to create attachment entry for", oFile.name);
                    continue;
                }
                const oPostResult = await oPostResponse.json();
                const sAttachmentId = oPostResult.ID;

                // Step 2: PUT the actual file bytes
                const sPutUrl = `${sServiceUrl}ClaimRecords(ClaimId='${sClaimId}',Invoicenumber='${sInvoicenumber}')/attachments(ID=${sAttachmentId},up__ClaimId='${sClaimId}',up__Invoicenumber='${sInvoicenumber}')/content`;
                await fetch(sPutUrl, {
                    method: "PUT",
                    headers: { "Content-Type": oFile.type || "application/octet-stream" },
                    body: oFile
                });
            } catch (oError) {
                console.error("Error uploading attachment", oFile.name, oError);
                MessageToast.show("Warning: attachment " + oFile.name + " could not be uploaded.");
            }
        }
    }
},

        // FIXED 2026-06-26: switched from MessageToast to a modal
        // MessageBox. The toast WAS actually showing correctly (see
        // console diagnostics confirming requestObject() resolved
        // with the real result every time) - but the very next line
        // navigated away IMMEDIATELY, with no delay, so the page
        // transition was cutting the toast off before the user could
        // read it. A MessageBox is modal - it blocks until the user
        // clicks OK, and navigation now only happens in that OK
        // callback, guaranteeing the result is actually seen.
        _showResultsAndNavigateBack: function (oResult) {
            const aResults = oResult.results || [];
            const aSucceeded = aResults.filter(r => r.success);
            const aFailed = aResults.filter(r => !r.success);

            let sMessage = "Claim " + oResult.ClaimId + ": " +
                aSucceeded.length + " of " + aResults.length +
                " record(s) for PO " + this._sPO + " submitted successfully.";

            if (aFailed.length > 0) {
                const aFailureDetails = aFailed.map(
                    r => r.Invoicenumber + ": " + (r.message || "unknown error")
                );
                sMessage += "\n\nFailed (" + aFailed.length + "):\n" + aFailureDetails.join("\n");
            }

            const fnNavigateBack = () => {
                this.getOwnerComponent().getRouter().navTo("Routeretention");
            };

            if (aFailed.length === 0) {
                MessageBox.success(sMessage, { onClose: fnNavigateBack });
            } else if (aSucceeded.length === 0) {
                MessageBox.error(sMessage, { onClose: fnNavigateBack });
            } else {
                MessageBox.warning(sMessage, { onClose: fnNavigateBack });
            }
        },

        // Every record shown on this page (in read-only "view" mode)
        // already has a confirmed, persisted claim by construction -
        // this page only ever gets here via onClaimIdPress, which
        // only fires for records with a real ClaimId - so unlike the
        // dashboard's version of this formatter, no _oClaimMap lookup
        // is needed: if the real backend status is still "Due for
        // Refund" (date-driven, doesn't change on its own - see the
        // earlier confirmed business rule), show "Request In
        // Progress" instead, consistent with the dashboard. Any other
        // real status (e.g. "Approved") passes through unmodified,
        // same rule as the dashboard.
        formatStatusText: function (sFinalStatus) {
            if (sFinalStatus === "Due for Refund") {
                return "Request In Progress";
            }
            return sFinalStatus;
        },

        // ---------------------------------------------------------
        // Format a numeric amount with its currency code, e.g.
        // formatAmountWithCurrency(-27890, "AED") -> "-27,890.00 AED"
        // Reused as-is from retention.controller.js, since this
        // table shows the exact same Net Value / Retention Amount
        // fields with the same SAP trailing-minus formatting quirk.
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