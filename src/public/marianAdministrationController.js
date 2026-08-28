/**
 * =============================================================================
 * MODULE: public/marianAdministrationController.js
 * VERSION: v20.0.0-command-dispatch
 * RESPONSIBILITY: Shared frontend controller for Marian-only administration pages.
 *                 Uses declarative command dispatch maps for widget actions.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-command-dispatch: Implements Command Pattern dispatch map to replace
 *   large if-else chains, reuses shared kernel validators from mmUtils.js.
 * =============================================================================
 */

import wixMembersFrontend from "wix-members-frontend";
import wixLocation from "wix-location";
import { checkStaffCollaboratorAccess } from "backend/security.web";
import { getMyStaffContext } from "backend/horario.web";
import {
    getCashierState,
    registerManualTransaction,
    registerXCount,
    registerZClosing,
} from "backend/cajas.web";
import {
    getInventoryDashboard,
    getInventoryReconciliationQueue,
} from "backend/inventario.web";
import {
    getQuarterlyTaxSummary,
    getLibroRegistroFacturasExpedidas,
} from "backend/fiscalAggregator.web";
import { askMarianAssistant } from "backend/marianAssistant.web";
import {
    previewManagerPackage,
    createManagerPackageVersion,
    downloadManagerPackageVersion,
    getManagerPackageHistory,
    getPreparedManagerPackages,
    emailManagerPackageVersion,
} from "backend/fiscalDocuments.web";
import {
    URLS,
    SDK_CONFIG,
    MONEY,
    makeTraceId,
    _safeTrim,
    _readPositiveAmount,
    _readDate,
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

function _postError(post, responseType, messageId, message, code = "ACCESS_DENIED") {
    post(responseType, {
        status: "ERROR",
        data: null,
        error: { code, message },
    }, messageId);
}

function _readYear(value) {
    const year = Number(value);
    return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : null;
}

function _readQuarter(value) {
    const quarter = Number(value);
    return [1, 2, 3, 4].includes(quarter) ? quarter : null;
}

function _readEmail(value) {
    const email = _safeTrim(value).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

function _readDocumentId(value) {
    const id = _safeTrim(value);
    return /^DOC_GESTORIA_(20\d{2}|21\d{2})_(T[1-4]|M(0[1-9]|1[0-2]))_PAQUETE_GESTORIA_V\d{4}$/.test(id) ? id : null;
}

function _readPeriodParams(payload) {
    const year = _readYear(payload?.year);
    const quarter = _readQuarter(payload?.quarter);
    if (!year || !quarter) return null;
    return { year, quarter };
}

const ADMIN_ACTION_DISPATCH = Object.freeze({
    AI_CHAT: async ({ payload, traceId, post, messageId }) => {
        const messageText = _safeTrim(payload.message);
        const history = Array.isArray(payload.history) ? payload.history : [];
        if (!messageText) {
            _postError(post, "AI_CHAT_RES", messageId, "Escribe una consulta para el asistente", "INVALID_INPUT");
            return;
        }
        post("AI_CHAT_RES", await askMarianAssistant({ message: messageText, history, traceId }), messageId);
    },

    CASHIER_STATE: async ({ payload, traceId, post, messageId }) => {
        const diaKey = _readDate(payload.diaKey) || null;
        post("CASHIER_STATE_RES", await getCashierState({ traceId, diaKey }), messageId);
    },

    INVENTORY_DASH: async ({ post, messageId }) => {
        post("INVENTORY_DASH_RES", await getInventoryDashboard(), messageId);
    },

    INVENTORY_QUEUE: async ({ post, messageId }) => {
        post("INVENTORY_QUEUE_RES", await getInventoryReconciliationQueue(), messageId);
    },

    TPV_TX: async ({ payload, staffContext, traceId, post, messageId }) => {
        const amount = _readPositiveAmount(payload.amount);
        const paymentMethod = _safeTrim(payload.paymentMethod).toUpperCase();
        const transactionKind = _safeTrim(payload.transactionKind).toUpperCase() || "VENTA";
        const concept = _safeTrim(payload.concept);
        if (!amount || !["EFECTIVO", "TARJETA", "BIZUM"].includes(paymentMethod) || !["VENTA", "PROPINA"].includes(transactionKind) || !concept) {
            _postError(post, "TPV_TX_RES", messageId, "Importe, forma de pago, naturaleza y concepto validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("TPV_TX_RES", await registerManualTransaction({
            amount,
            paymentMethod,
            tipoMovimiento: transactionKind === "PROPINA" ? "PROPINA" : "",
            concept,
            resourceId: staffContext?.resourceId || null,
            traceId,
        }), messageId);
    },

    X_COUNT: async ({ payload, traceId, post, messageId }) => {
        const diaKey = _readDate(payload.diaKey);
        const metalicoCaja = Number(payload.metalicoCaja);
        if (!diaKey || !Number.isFinite(metalicoCaja) || metalicoCaja < 0) {
            _postError(post, "X_COUNT_RES", messageId, "Fecha y efectivo contado validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("X_COUNT_RES", await registerXCount(diaKey, { metalicoCaja, traceId }), messageId);
    },

    Z_CLOSING: async ({ payload, traceId, post, messageId }) => {
        const diaKey = _readDate(payload.diaKey);
        if (!diaKey) {
            _postError(post, "Z_CLOSING_RES", messageId, "La fecha de cierre es obligatoria", "INVALID_INPUT");
            return;
        }
        post("Z_CLOSING_RES", await registerZClosing(diaKey, { traceId }), messageId);
    },

    DOCUMENT_PREVIEW: async ({ payload, post, messageId }) => {
        const period = _readPeriodParams(payload);
        if (!period) {
            _postError(post, "DOCUMENT_PREVIEW_RES", messageId, "Ejercicio y trimestre validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("DOCUMENT_PREVIEW_RES", await previewManagerPackage(period), messageId);
    },

    DOCUMENT_CREATE: async ({ payload, post, messageId }) => {
        const period = _readPeriodParams(payload);
        if (!period) {
            _postError(post, "DOCUMENT_CREATE_RES", messageId, "Ejercicio y trimestre validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("DOCUMENT_CREATE_RES", await createManagerPackageVersion(period), messageId);
    },

    DOCUMENT_HISTORY: async ({ payload, post, messageId }) => {
        const period = _readPeriodParams(payload);
        if (!period) {
            _postError(post, "DOCUMENT_HISTORY_RES", messageId, "Ejercicio y trimestre validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("DOCUMENT_HISTORY_RES", await getManagerPackageHistory(period), messageId);
    },

    DOCUMENT_PREPARED: async ({ post, messageId }) => {
        post("DOCUMENT_PREPARED_RES", await getPreparedManagerPackages(), messageId);
    },

    DOCUMENT_DOWNLOAD: async ({ payload, post, messageId }) => {
        const documentId = _readDocumentId(payload.documentId);
        if (!documentId) {
            _postError(post, "DOCUMENT_DOWNLOAD_RES", messageId, "La version documental no es valida", "INVALID_INPUT");
            return;
        }
        post("DOCUMENT_DOWNLOAD_RES", await downloadManagerPackageVersion({ documentId }), messageId);
    },

    DOCUMENT_EMAIL: async ({ payload, post, messageId }) => {
        const documentId = _readDocumentId(payload.documentId);
        const recipient = _readEmail(payload.recipient);
        if (!documentId || !recipient) {
            _postError(post, "DOCUMENT_EMAIL_RES", messageId, "La version y el email de gestoria deben ser validos", "INVALID_INPUT");
            return;
        }
        if (payload.confirmed !== true) {
            _postError(post, "DOCUMENT_EMAIL_RES", messageId, "Confirma expresamente el envio antes de continuar", "CONFIRMATION_REQUIRED");
            return;
        }
        post("DOCUMENT_EMAIL_RES", await emailManagerPackageVersion({
            documentId,
            recipient,
            confirmed: true,
        }), messageId);
    },

    FISCAL_SUMMARY: async ({ payload, traceId, post, messageId }) => {
        const period = _readPeriodParams(payload);
        if (!period) {
            _postError(post, "FISCAL_SUMMARY_RES", messageId, "Ejercicio y trimestre validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("FISCAL_SUMMARY_RES", await getQuarterlyTaxSummary(period.year, period.quarter, { traceId }), messageId);
    },

    FISCAL_BOOK: async ({ payload, traceId, post, messageId }) => {
        const period = _readPeriodParams(payload);
        if (!period) {
            _postError(post, "FISCAL_BOOK_RES", messageId, "Ejercicio y trimestre validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("FISCAL_BOOK_RES", await getLibroRegistroFacturasExpedidas(period.year, period.quarter, { traceId }), messageId);
    },
});

export async function initMarianAdministration(widget, slug = "administracion") {
    const traceId = makeTraceId("marian-admin");
    if (!widget || typeof widget.postMessage !== "function") return;

    const member = await wixMembersFrontend.currentMember.getMember().catch(() => null);
    if (!member) {
        await wixMembersFrontend.authentication.promptLogin();
        return;
    }

    const [accessRes, staffContextRes] = await Promise.all([
        checkStaffCollaboratorAccess(traceId).catch(() => null),
        getMyStaffContext({ traceId }).catch(() => null),
    ]);

    const access = accessRes?.status === "SUCCESS" ? accessRes.data : null;
    const staffContext = staffContextRes?.status === "SUCCESS" ? staffContextRes.data : null;
    const isMarianManager = access?.isMarianManager === true;

    if (!isMarianManager) {
        wixLocation.to(URLS.SERVICIOS);
        return;
    }

    async function loadContext() {
        const [cashierRes, inventoryRes, queueRes] = await Promise.all([
            getCashierState({ traceId }).catch(() => null),
            getInventoryDashboard().catch(() => null),
            getInventoryReconciliationQueue().catch(() => null),
        ]);

        const today = new Date().toLocaleDateString("sv-SE", {
            timeZone: SDK_CONFIG.TZ,
        });

        return {
            isMarianManager: true,
            memberName: staffContext?.displayName || "Marian",
            timeZone: SDK_CONFIG.TZ,
            currencyCode: MONEY.DISPLAY_CURRENCY,
            today,
            cashierState: cashierRes?.status === "SUCCESS" ? cashierRes.data : null,
            inventory: inventoryRes?.status === "SUCCESS" ? inventoryRes.data : null,
            inventoryQueue: queueRes?.status === "SUCCESS" ? (queueRes.data?.items || []) : [],
        };
    }

    createWidgetBridge(widget, {
        slug,
        traceId,
        requiresServiceId: false,
        onContextReady: loadContext,
        onWidgetMessage: async (message, post) => {
            const type = String(message?.type || "").toUpperCase();
            const payload = message?.payload || {};
            const messageId = message?.messageId || null;

            if (!isMarianManager) {
                _postError(post, "ADMIN_ERROR", messageId, "Acceso exclusivo de Marian requerido");
                return;
            }

            const handler = ADMIN_ACTION_DISPATCH[type];
            if (!handler) {
                _postError(post, "ADMIN_ERROR", messageId, "Solicitud de gestion no permitida", "UNKNOWN_ACTION");
                return;
            }

            try {
                await handler({ payload, staffContext, traceId, post, messageId });
            } catch (error) {
                _postError(post, `${type}_RES`, messageId, error?.message || "Error al procesar la solicitud", error?.code || "ACTION_ERROR");
            }
        },
    });
}