/**
 * =============================================================================
 * FILE: backend/mmSecrets.js
 * VERSION: v19.6.16-canonical-ssot
 * RESPONSIBILITY: Private catalog of Wix Secrets Manager key names.
 * STANDARDS: Velo V3, SDK V2, G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

export const SECRETS = Object.freeze({
    FISCAL_KEY: "SECRET_FISCALKEY",
    FISCAL_NIF_EMISOR: "FISCAL_NIF_EMISOR",
    AUTH_JWT_KEY: "SECRET_AUTH_JWT_KEY",
    ADMIN_EMAILS: "ADMIN_EMAILS",
    CAJERO_EMAILS: "CAJERO_EMAILS",
    POWER_AUTOMATE: "POWER_AUTOMATE_TOKEN",
    SENDGRID_KEY: "SENDGRID_API_KEY",
    WIX_APP_KEY: "APP_KEY",
    BOOKINGS_TOKEN: "BOOKINGS_API_TOKEN",
    MARIAN_ASSISTANT_OPENAI_KEY: "MARIAN_ASSISTANT_OPENAI_KEY",
    M365_GRAPH_TENANT_ID: "M365_GRAPH_TENANT_ID",
    M365_GRAPH_CLIENT_ID: "M365_GRAPH_CLIENT_ID",
    M365_GRAPH_CLIENT_SECRET: "M365_GRAPH_CLIENT_SECRET",
    M365_GRAPH_SITE_ID: "M365_GRAPH_SITE_ID",
    M365_GRAPH_LIST_ID: "M365_GRAPH_LIST_ID",
    RESEND_API_KEY: "RESEND_API_KEY",
    RESEND_FROM_EMAIL: "RESEND_FROM_EMAIL",
});
