sap.ui.define([
    "sap/ui/core/UIComponent",
    "application/model/models"
], (UIComponent, models) => {
    "use strict";

    return UIComponent.extend("application.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // enable routing
            this.getRouter().initialize();
        },

        // ---------------------------------------------------------
        // Selected Records Handoff (Component-level, not a route
        // parameter)
        // ---------------------------------------------------------
        // Added 2026-06-26 to support navigating from the retention
        // dashboard to the new Claim Detail page. Route parameters in
        // the URL aren't practical for passing a full array of
        // selected record objects (URL length limits, not meant for
        // structured data) - instead, the Component instance (which
        // persists across page navigation, unlike a controller
        // instance which is destroyed/recreated per view) holds this
        // data temporarily. The retention page's controller calls
        // setSelectedClaimRecords() right before navigating; the
        // Claim Detail page's controller calls
        // getSelectedClaimRecords() in its route-matched handler to
        // read it back.
        setSelectedClaimRecords: function (sPO, aRecords) {
            this._sSelectedClaimPO = sPO;
            this._aSelectedClaimRecords = aRecords;
        },

        getSelectedClaimRecords: function () {
            return {
                po: this._sSelectedClaimPO,
                records: this._aSelectedClaimRecords || []
            };
        },
        // ---------------------------------------------------------
        // View Claim Records Handoff (read-only mode)
        // ---------------------------------------------------------
        // Added 2026-06-27: separate from setSelectedClaimRecords
        // above, which is for the "about to submit a NEW claim" flow
        // - this is for "viewing an ALREADY-SUBMITTED claim's
        // details", triggered by clicking a Claim ID link on the
        // dashboard. Kept as a fully distinct pair of slots (not
        // reusing the existing one) so the two flows can never
        // accidentally interfere with each other.
        setViewClaimRecords: function (sClaimId, aRecords) {
            this._sViewClaimId = sClaimId;
            this._aViewClaimRecords = aRecords;
        },

        getViewClaimRecords: function () {
            return {
                claimId: this._sViewClaimId,
                records: this._aViewClaimRecords || []
            };
        }
    });
});