/**
 * =============================================================================
 * FILE: src/pages/administracion.js
 * VERSION: v20.0.0-canonical-admin-page
 * RESPONSIBILITY: Canonical Wix Editor page controller for Marian Administration.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * CHANGELOG:
 * - v20.0.0-canonical-admin-page: Connects to #htmlAdmin with zero-flash rendering.
 * =============================================================================
 */

import $w from "wix-window-frontend";
import { initMarianAdministration } from "public/marianAdministrationController";

$w.onReady(async function () {
    const widget = $w("#htmlAdmin");
    await initMarianAdministration(widget, "administracion");
});