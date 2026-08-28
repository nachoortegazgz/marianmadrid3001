/**
 * =============================================================================
 * MODULE: pages/ONLY STAFF.mvf3f.js
 * VERSION: v20.0.0-command-dispatch
 * RESPONSIBILITY: Canonical Wix Editor page controller for staff operations.
 *                 Uses declarative command dispatch maps for staff and cashier actions.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-command-dispatch: Implements Command Pattern dispatch map to eliminate
 *   nested if-else chains, reuses shared validators from mmUtils.js.
 * =============================================================================
 */

import wixMembersFrontend from "wix-members-frontend";
import wixLocation from "wix-location";
import { checkStaffCollaboratorAccess } from "backend/security.web";
import {
    getMyStaffContext,
    getStaffOptionsForAdmin,
    registrarFichaje,
    getEstadoJornada,
    getHistorialFichajes,
    calcularHorasTrabajadas,
    registrarAjusteHorario,
} from "backend/horario.web";
import {
    registerManualTransaction,
    getCashierState,
    registerZClosing,
    registerXCount,
} from "backend/cajas.web";
import {
    getInventoryDashboard,
    registerInternalInventoryUse,
    registerInventoryReceipt,
    getInventoryReconciliationQueue,
    markInventoryReconciliationApplied,
} from "backend/inventario.web";
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

const WIDGET_ID = "#htmlOnlyStaff";
const CLOCK_TYPES = Object.freeze(["ENTRADA", "SALIDA", "PAUSA_INICIO", "PAUSA_FIN"]);
const CASHIER_METHODS = Object.freeze(["EFECTIVO", "TARJETA", "BIZUM"]);
const NAV_TARGETS = Object.freeze({ SERVICIOS: URLS.SERVICIOS });

function _postError(post, responseType, messageId, message, code = "INVALID_REQUEST") {
    post(responseType, {
        status: "ERROR",
        data: null,
        error: { code, message },
    }, messageId);
}

function _readInventoryLine(payload = {}) {
    const sku = _safeTrim(payload.sku);
    const quantity = Math.abs(Number(payload.quantity) || 0);
    if (!sku || !Number.isFinite(quantity) || quantity <= 0) return null;
    return {
        sku,
        quantity,
        note: _safeTrim(payload.note),
        referenceId: _safeTrim(payload.referenceId) || null,
    };
}

function _requiresCashier(post, responseType, messageId, access) {
    if (access.isAdmin || access.isCajero) return false;
    _postError(post, responseType, messageId, "Se requieren permisos de caja", "CASHIER_REQUIRED");
    return true;
}

function _requiresAdmin(post, responseType, messageId, access) {
    if (access.isAdmin) return false;
    _postError(post, responseType, messageId, "Se requieren permisos de administrador", "ADMIN_REQUIRED");
    return true;
}

const STAFF_ACTION_DISPATCH = Object.freeze({
    CLOCK: async ({ payload, employeeResourceId, traceId, post, messageId }) => {
        const tipoFichaje = _safeTrim(payload.tipoFichaje).toUpperCase();
        if (!CLOCK_TYPES.includes(tipoFichaje)) {
            _postError(post, "CLOCK_RES", messageId, "El tipo de fichaje no es valido", "INVALID_INPUT");
            return;
        }
        post("CLOCK_RES", await registrarFichaje({
            resourceId: employeeResourceId,
            tipoFichaje,
            traceId,
        }), messageId);
    },

    GET_STATE: async ({ employeeResourceId, traceId, post, messageId }) => {
        post("GET_STATE_RES", await getEstadoJornada(employeeResourceId, { traceId }), messageId);
    },

    GET_HISTORY: async ({ payload, employeeResourceId, traceId, post, messageId }) => {
        const startDateYMD = _readDate(payload.startDateYMD);
        const endDateYMD = _readDate(payload.endDateYMD);
        if ((payload.startDateYMD && !startDateYMD) || (payload.endDateYMD && !endDateYMD)) {
            _postError(post, "GET_HISTORY_RES", messageId, "El intervalo de fechas no es valido", "INVALID_INPUT");
            return;
        }
        post("GET_HISTORY_RES", await getHistorialFichajes(
            employeeResourceId,
            startDateYMD,
            endDateYMD, { traceId }
        ), messageId);
    },

    HOURS_CALC: async ({ payload, employeeResourceId, traceId, post, messageId }) => {
        const startDateYMD = _readDate(payload.startDateYMD);
        const endDateYMD = _readDate(payload.endDateYMD);
        if ((payload.startDateYMD && !startDateYMD) || (payload.endDateYMD && !endDateYMD)) {
            _postError(post, "HOURS_CALC_RES", messageId, "El intervalo de fechas no es valido", "INVALID_INPUT");
            return;
        }
        post("HOURS_CALC_RES", await calcularHorasTrabajadas(
            employeeResourceId,
            startDateYMD,
            endDateYMD, { traceId }
        ), messageId);
    },

    ADJUSTMENT: async ({ payload, access, traceId, post, messageId }) => {
        if (_requiresAdmin(post, "ADJUSTMENT_RES", messageId, access)) return;
        const targetResourceId = _safeTrim(payload.employeeId);
        const motivoAjuste = _safeTrim(payload.motivoAjuste);
        if (!targetResourceId || !motivoAjuste) {
            _postError(post, "ADJUSTMENT_RES", messageId, "Empleado y motivo del ajuste son obligatorios", "INVALID_INPUT");
            return;
        }
        post("ADJUSTMENT_RES", await registrarAjusteHorario({
            resourceId: targetResourceId,
            motivoAjuste,
            traceId,
        }), messageId);
    },

    TPV_TX: async ({ payload, access, employeeResourceId, traceId, post, messageId }) => {
        if (_requiresCashier(post, "TPV_TX_RES", messageId, access)) return;
        const amount = _readPositiveAmount(payload.amount);
        const paymentMethod = _safeTrim(payload.paymentMethod).toUpperCase();
        const transactionKind = _safeTrim(payload.transactionKind).toUpperCase() || "VENTA";
        const concept = _safeTrim(payload.concept);
        if (!amount || !CASHIER_METHODS.includes(paymentMethod) || !["VENTA", "PROPINA"].includes(transactionKind) || !concept) {
            _postError(post, "TPV_TX_RES", messageId, "Importe, forma de pago, naturaleza y concepto validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("TPV_TX_RES", await registerManualTransaction({
            amount,
            paymentMethod,
            tipoMovimiento: transactionKind === "PROPINA" ? "PROPINA" : "",
            concept,
            resourceId: employeeResourceId,
            traceId,
        }), messageId);
    },

    CASHIER_STATE: async ({ payload, access, traceId, post, messageId }) => {
        if (_requiresCashier(post, "CASHIER_STATE_RES", messageId, access)) return;
        post("CASHIER_STATE_RES", await getCashierState({
            traceId,
            diaKey: _readDate(payload.diaKey) || null,
        }), messageId);
    },

    X_COUNT: async ({ payload, access, traceId, post, messageId }) => {
        if (_requiresCashier(post, "X_COUNT_RES", messageId, access)) return;
        const diaKey = _readDate(payload.diaKey);
        const metalicoCaja = Number(payload.metalicoCaja);
        if (!diaKey || !Number.isFinite(metalicoCaja) || metalicoCaja < 0) {
            _postError(post, "X_COUNT_RES", messageId, "Fecha y efectivo contado validos son obligatorios", "INVALID_INPUT");
            return;
        }
        post("X_COUNT_RES", await registerXCount(diaKey, { metalicoCaja, traceId }), messageId);
    },

    Z_CLOSING: async ({ payload, access, traceId, post, messageId }) => {
        if (_requiresAdmin(post, "Z_CLOSING_RES", messageId, access)) return;
        const diaKey = _readDate(payload.diaKey);
        if (!diaKey) {
            _postError(post, "Z_CLOSING_RES", messageId, "La fecha de cierre es obligatoria", "INVALID_INPUT");
            return;
        }
        post("Z_CLOSING_RES", await registerZClosing(diaKey, { traceId }), messageId);
    },

    INVENTORY_DASH: async ({ post, messageId }) => {
        post("INVENTORY_DASH_RES", await getInventoryDashboard(), messageId);
    },

    INVENTORY_USE: async ({ payload, post, messageId }) => {
        const line = _readInventoryLine(payload);
        if (!line) {
            _postError(post, "INVENTORY_USE_RES", messageId, "SKU y cantidad positiva son obligatorios", "INVALID_INPUT");
            return;
        }
        const request = {
            batchToken: _safeTrim(payload.batchToken),
            lines: [line],
        };
        post("INVENTORY_USE_RES", await registerInternalInventoryUse(request), messageId);
    },

    INVENTORY_RECEIPT: async ({ payload, access, post, messageId }) => {
        if (_requiresCashier(post, "INVENTORY_RECEIPT_RES", messageId, access)) return;
        const line = _readInventoryLine(payload);
        if (!line) {
            _postError(post, "INVENTORY_RECEIPT_RES", messageId, "SKU y cantidad positiva son obligatorios", "INVALID_INPUT");
            return;
        }
        const request = {
            batchToken: _safeTrim(payload.batchToken),
            lines: [line],
        };
        post("INVENTORY_RECEIPT_RES", await registerInventoryReceipt(request), messageId);
    },

    INVENTORY_QUEUE: async ({ access, post, messageId }) => {
        if (_requiresCashier(post, "INVENTORY_QUEUE_RES", messageId, access)) return;
        post("INVENTORY_QUEUE_RES", await getInventoryReconciliationQueue(), messageId);
    },

    INVENTORY_APPLY: async ({ payload, access, post, messageId }) => {
        if (_requiresCashier(post, "INVENTORY_APPLY_RES", messageId, access)) return;
        const reconciliationId = _safeTrim(payload.reconciliationId);
        if (!reconciliationId) {
            _postError(post, "INVENTORY_APPLY_RES", messageId, "La conciliacion es obligatoria", "INVALID_INPUT");
            return;
        }
        post("INVENTORY_APPLY_RES", await markInventoryReconciliationApplied(
            reconciliationId,
            _safeTrim(payload.note)
        ), messageId);
    },

    NAV: async ({ payload, post, messageId }) => {
        const destination = NAV_TARGETS[_safeTrim(payload.target).toUpperCase()];
        if (!destination) {
            _postError(post, "NAV_RES", messageId, "Destino de navegacion no permitido", "INVALID_DESTINATION");
            return;
        }
        wixLocation.to(destination);
    },
});

$w.onReady(async function () {
    const traceId = makeTraceId("only-staff");
    const widget = $w(WIDGET_ID);
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

    if (!access || !staffContext?.resourceId) {
        wixLocation.to(URLS.SERVICIOS);
        return;
    }

    const employeeResourceId = staffContext.resourceId;
    const staffOptionsRes = access.isAdmin ?
        await getStaffOptionsForAdmin({ traceId }).catch(() => null) :
        null;
    const staffOptions = staffOptionsRes?.status === "SUCCESS" && Array.isArray(staffOptionsRes.data) ?
        staffOptionsRes.data :
        [];

    createWidgetBridge(widget, {
        slug: "only-staff",
        traceId,
        requiresServiceId: false,
        onContextReady: async () => {
            const [stateRes, cashierRes, inventoryRes, inventoryQueueRes] = await Promise.all([
                getEstadoJornada(employeeResourceId, { traceId }).catch(() => null),
                access.isAdmin || access.isCajero ?
                getCashierState({ traceId }).catch(() => null) :
                Promise.resolve(null),
                getInventoryDashboard().catch(() => null),
                access.isAdmin || access.isCajero ?
                getInventoryReconciliationQueue().catch(() => null) :
                Promise.resolve(null),
            ]);

            return {
                employeeResourceId,
                employeeName: staffContext.displayName || "EMPLEADO",
                memberName: staffContext.displayName || "EMPLEADO",
                isAdmin: access.isAdmin === true,
                isCajero: access.isCajero === true,
                isMarianManager: access.isMarianManager === true,
                roleLabel: access.isAdmin ? "ADMINISTRACION" : (access.isCajero ? "CAJA" : "EQUIPO"),
                timeZone: SDK_CONFIG.TZ,
                currencyCode: MONEY.DISPLAY_CURRENCY,
                access,
                staffOptions,
                estadoInicial: stateRes?.status === "SUCCESS" ? stateRes.data : null,
                cashierState: cashierRes?.status === "SUCCESS" ? cashierRes.data : null,
                inventory: inventoryRes?.status === "SUCCESS" ? inventoryRes.data : null,
                inventoryQueue: inventoryQueueRes?.status === "SUCCESS" ?
                    (inventoryQueueRes.data?.items || []) :
                    [],
            };
        },
        onWidgetMessage: async (message, post) => {
            const type = String(message?.type || "").toUpperCase();
            const payload = message?.payload || {};
            const messageId = message?.messageId || null;

            const handler = STAFF_ACTION_DISPATCH[type];
            if (!handler) {
                _postError(post, "ONLY_STAFF_ERROR", messageId, "Solicitud de personal no permitida", "UNKNOWN_ACTION");
                return;
            }

            try {
                await handler({ payload, access, employeeResourceId, traceId, post, messageId });
            } catch (error) {
                _postError(post, `${type}_RES`, messageId, error?.message || "Error al procesar la solicitud", error?.code || "ACTION_ERROR");
            }
        },
    });
});