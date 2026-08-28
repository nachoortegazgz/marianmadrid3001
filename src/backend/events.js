/**
 * =============================================================================
 * MODULE: backend/events.js
 * VERSION: v20.0.0-universal-ecom-settlement
 * RESPONSIBILITY: Server-to-server native webhooks for Wix Bookings V2 and
 * Wix eCommerce V2. Universal payment settlement for bookings, store products,
 * and mixed orders into the immutable cashbox ledger.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-universal-ecom-settlement: Fixes P0 flaw for pure Wix Stores orders;
 *   ensures universal ledger settlement under ORDER-${orderId}, handles mixed orders,
 *   preserves inventory mirroring, and standardizes refund traceability.
 * - v19.6.3-prioritized-reliability-refactor: Removes duplicated catalog and slot paths, restores Codegem fixes, and hardens persistence.
 * - v19.5.3-fiscal-ordering-hardening: Holds CitasF2 in PENDING_LEDGER until the online payment ledger is durable or queued for recovery.
 * - v19.5.1-ecom-events-ssot: Uses SSOT webhook timing and removes the deprecated paid-event alias.
 * - v19.4.4: Handles each refund by stable refund ID, queues fiscal failures, and distinguishes partial/full refund payment state.
 * - v19.3.0-inventory-order-mirror: Mirrors paid Wix Stores orders without duplicating native stock decrement.
 * - v19.2.0-state-ssot-hardened: Canonical CitasF2 state writes and durable fiscal recovery queue.
 * =============================================================================
 */

import wixData from "wix-data";
import {
    makeTraceId,
    _executeWithRetry,
    _normalizeIdPart,
    withTimeout,
} from "public/mmUtils";
import {
    COLLECTIONS,
    APP_IDS,
    TIPO_MOVIMIENTO,
    FORMA_PAGO,
    ESTADO_CITA,
    ESTADO_PAGO,
    CITA_FIELDS,
    SDK_CONFIG,
} from "backend/internalConfig";
import { logger, normalizeError } from "backend/booking/bookingCore";
import { registerBookingPayment, queueFiscalRecovery } from "backend/cajas.web";
import {
    recordOnlineInventoryOrderInternal,
    recordOnlineInventoryRefundInternal,
} from "backend/inventario.web";

const log = logger;
const WEBHOOK_RETRIES = Number(SDK_CONFIG?.EVENTS?.RETRY_ATTEMPTS) || 3;
const WEBHOOK_RETRY_DELAY_MS = Number(SDK_CONFIG?.EVENTS?.RETRY_BASE_BACKOFF_MS) || 1000;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

function _handleError(error, context, traceId) {
    const normalized = normalizeError(error);
    log.error(`Error in ${context}`, { error: normalized.message, traceId });
    return { code: normalized.code, message: normalized.message };
}

async function _logAuditEvent(tipoEvento, level, message, data = {}, traceId, entityId = "system") {
    try {
        const safeEntity = _normalizeIdPart(entityId, 40);
        const safeTrace = _normalizeIdPart(traceId, 40);
        const logId = `AUDIT_${_normalizeIdPart(tipoEvento, 30)}_${safeEntity}_${safeTrace}`;
        await withTimeout(
            wixData.insert(
                COLLECTIONS.AUDIT_LOG, {
                    _id: logId,
                    tipoEvento,
                    level,
                    message,
                    data,
                    resourceId: "SYSTEM",
                    source: "backend/events.js",
                    fechaLog: new Date(),
                    traceId,
                }, { suppressAuth: true }
            ).catch(() => null),
            API_TIMEOUT_MS,
            "logAuditEvent"
        );
    } catch (err) {
        log.error("Failed to write to AUDIT_LOG", { error: err?.message || String(err), traceId });
    }
}

async function _updateCitaEstado(bookingId, nuevoEstado, traceId) {
    if (!bookingId || bookingId === "unknown") return;
    try {
        const citaRes = await withTimeout(
            wixData.query(COLLECTIONS.CITAS).eq("bookingId", bookingId).limit(1).find({ suppressAuth: true }),
            API_TIMEOUT_MS,
            "queryCitaEstado"
        );
        if (citaRes.items?.length > 0) {
            const cita = citaRes.items[0];
            if (String(cita[CITA_FIELDS.STATUS] || "").toUpperCase() !== String(nuevoEstado || "").toUpperCase()) {
                const { _createdDate, _updatedDate, _owner, ...safeCita } = cita;
                const updatedCita = {
                    ...safeCita,
                    [CITA_FIELDS.STATUS]: String(nuevoEstado || ESTADO_CITA.CONFIRMED).toUpperCase(),
                    fechaActualizacion: new Date(),
                };
                await withTimeout(
                    wixData.update(COLLECTIONS.CITAS, updatedCita, { suppressAuth: true }),
                    API_TIMEOUT_MS,
                    "updateCitaEstado"
                );
            }
        }
    } catch (err) {
        log.warn("Failed to update CITAS state", { bookingId, error: err?.message, traceId });
    }
}

async function _markCitasRefundedByBookingIds(bookingIds, orderId, refundId, fullyRefunded, traceId) {
    const ids = Array.isArray(bookingIds) ? bookingIds.map(String).filter(Boolean) : [];
    for (const bookingId of ids) {
        try {
            const res = await withTimeout(
                wixData.query(COLLECTIONS.CITAS).eq("bookingId", bookingId).limit(1).find({ suppressAuth: true }),
                API_TIMEOUT_MS,
                "queryCitaForRefund"
            );
            const cita = res?.items?.[0];
            if (!cita) continue;
            const meta = cita.meta || {};
            const { _createdDate, _updatedDate, _owner, ...safeCita } = cita;
            const paymentState = fullyRefunded ? ESTADO_PAGO.REFUNDED : ESTADO_PAGO.PARTIALLY_REFUNDED;
            const updated = {
                ...safeCita,
                ...(fullyRefunded ? {
                    [CITA_FIELDS.STATUS]: ESTADO_CITA.REFUNDED } : {}),
                [CITA_FIELDS.STATUS_PAGO]: paymentState,
                fechaActualizacion: new Date(),
                meta: {
                    ...meta,
                    [CITA_FIELDS.STATUS_PAGO]: paymentState,
                    orderId: orderId || null,
                    refundId: refundId || null,
                    fechaReembolso: new Date(),
                },
            };
            await withTimeout(
                wixData.update(COLLECTIONS.CITAS, updated, { suppressAuth: true }),
                API_TIMEOUT_MS,
                "updateCitaRefund"
            );
        } catch (e) {
            log.warn("Failed to mark cita as refunded", { bookingId, traceId, error: e?.message });
        }
    }
}

async function _markCitasPaidByBookingIds(bookingIds, orderId, traceId) {
    const ids = Array.from(new Set(Array.isArray(bookingIds) ? bookingIds.map(String).filter(Boolean) : []));
    if (!ids.length) return;

    let citas = [];
    try {
        const res = await withTimeout(
            wixData.query(COLLECTIONS.CITAS).in("bookingId", ids).limit(1000).find({ suppressAuth: true }),
            API_TIMEOUT_MS,
            "queryCitasForPaid"
        );
        citas = res?.items || [];
    } catch (error) {
        log.warn("Failed to query CITAS for payment update", { bookingIds: ids, traceId, error: error?.message });
        return;
    }

    const citasByBookingId = new Map(citas.map((cita) => [String(cita?.bookingId || ""), cita]));
    for (const bookingId of ids) {
        const cita = citasByBookingId.get(bookingId);
        if (!cita) continue;
        try {
            const meta = cita.meta || {};
            const alreadyPaid = String(meta.statusPago || cita.statusPago || "").toUpperCase() === ESTADO_PAGO.PAID;
            if (alreadyPaid) continue;

            const { _createdDate, _updatedDate, _owner, ...safeCita } = cita;
            const updated = {
                ...safeCita,
                [CITA_FIELDS.STATUS]: ESTADO_CITA.CONFIRMED,
                [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
                fechaActualizacion: new Date(),
                meta: {
                    ...meta,
                    [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
                    orderId: orderId || null,
                    fechaConfirmacionPago: new Date(),
                },
            };
            await withTimeout(
                wixData.update(COLLECTIONS.CITAS, updated, { suppressAuth: true }),
                API_TIMEOUT_MS,
                "updateCitaPaid"
            );
        } catch (error) {
            log.warn("Failed to mark cita as PAID", { bookingId, traceId, error: error?.message });
        }
    }
}

async function _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId) {
    const ids = Array.isArray(bookingIds) ? bookingIds.map(String).filter(Boolean) : [];
    for (const bookingId of ids) {
        try {
            const res = await withTimeout(
                wixData.query(COLLECTIONS.CITAS).eq("bookingId", bookingId).limit(1).find({ suppressAuth: true }),
                API_TIMEOUT_MS,
                "queryCitaForPendingLedger"
            );
            const cita = res?.items?.[0];
            if (!cita) continue;
            const meta = cita.meta || {};
            const currentPaymentState = String(meta.statusPago || cita.statusPago || "").toUpperCase();
            if (currentPaymentState === ESTADO_PAGO.PAID) continue;

            const { _createdDate, _updatedDate, _owner, ...safeCita } = cita;
            const updated = {
                ...safeCita,
                [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PENDING_LEDGER,
                fechaActualizacion: new Date(),
                meta: {
                    ...meta,
                    [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PENDING_LEDGER,
                    orderId: orderId || null,
                    fechaPagoRecibido: new Date(),
                },
            };
            await withTimeout(
                wixData.update(COLLECTIONS.CITAS, updated, { suppressAuth: true }),
                API_TIMEOUT_MS,
                "updateCitaPendingLedger"
            );
        } catch (error) {
            log.warn("Failed to mark cita as PENDING_LEDGER", { bookingId, traceId, error: error?.message });
        }
    }
}

export async function wixBookingsV2_onBookingConfirmed(event) {
    const traceId = makeTraceId("whook-conf");
    try {
        const booking = event?.booking || event?.entity || {};
        const bookingId = booking?.id || booking?._id || "unknown";
        await _updateCitaEstado(bookingId, ESTADO_CITA.CONFIRMED, traceId);
        return { status: "OK" };
    } catch (error) {
        _handleError(error, "wixBookingsV2_onBookingConfirmed", traceId);
        return { status: "OK" };
    }
}

export async function wixBookingsV2_onBookingCanceled(event) {
    const traceId = makeTraceId("whook-cancel");
    try {
        const booking = event?.booking || event?.entity || {};
        const bookingId = booking?.id || booking?._id || "unknown";
        await _updateCitaEstado(bookingId, ESTADO_CITA.CANCELED, traceId);
        return { status: "OK" };
    } catch (error) {
        _handleError(error, "wixBookingsV2_onBookingCanceled", traceId);
        return { status: "OK" };
    }
}

export async function wixEcom_onOrderPaymentStatusUpdated(event) {
    const traceId = makeTraceId("whook-pay-status");
    try {
        const order = event?.order || event?.data?.order || event?.entity || event || {};
        const orderId = String(order?._id || order?.id || "").trim();
        if (!orderId || orderId === "unknown") return { status: "OK" };

        const paymentStatusRaw = order.paymentStatus || "";
        const paymentStatus = String(paymentStatusRaw).toUpperCase();
        const isPaidStatus = ["PAID", "FULLY_PAID", "PAID_FULL"].includes(paymentStatus);
        if (!isPaidStatus) return { status: "OK" };

        const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

        // 1. Mirror inventory for physical items (safe, best-effort)
        await recordOnlineInventoryOrderInternal(order, traceId).catch((inventoryError) => {
            log.error("Online inventory mirror failed", {
                orderId,
                traceId,
                error: inventoryError?.message || String(inventoryError),
            });
        });

        // 2. Extract linked bookings
        const bookingsAppId = APP_IDS.BOOKINGS;
        const bookingLineItems = lineItems.filter((item) => item?.catalogReference?.appId === bookingsAppId);
        const bookingIds = bookingLineItems.map((item) => String(item?.catalogReference?.catalogItemId || "").trim()).filter(Boolean);
        const linkedBookingIds = bookingIds.join(",");

        // 3. Consolidated amount calculation
        const orderTotal = Number(order?.priceSummary?.total?.amount ?? order?.totals?.total?.amount ?? 0) || 0;
        const lineItemsTotal = lineItems.reduce((sum, item) => {
            const itemPrice = Number(item?.price?.amount ?? item?.price ?? item?.totalPrice?.amount ?? 0) || 0;
            return sum + (itemPrice * (Number(item?.quantity) || 1));
        }, 0);
        const finalLedgerAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;
        const transactionId = `ORDER-${orderId}`;

        // 4. Preflight idempotency check on ledger
        const existingLedgerRes = await withTimeout(
            wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", transactionId).limit(1).find({ suppressAuth: true }),
            API_TIMEOUT_MS,
            "checkExistingLedgerPreflight"
        ).catch(() => ({ items: [] }));

        if (existingLedgerRes?.items?.length > 0) {
            if (bookingIds.length) {
                await _executeWithRetry(async () => {
                    await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
                }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
            }
            return { status: "OK" };
        }

        // 5. Put citations into PENDING_LEDGER before ledger write
        if (bookingIds.length) {
            await _executeWithRetry(async () => {
                await _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId);
            }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
        }

        if (finalLedgerAmount <= 0) {
            if (bookingIds.length) {
                await _executeWithRetry(async () => {
                    await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
                }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
            }
            return { status: "OK" };
        }

        // 6. Descriptive concept based on order composition
        const orderConcept = bookingIds.length > 0 ?
            (lineItems.length > bookingIds.length ? `Pedido Mixto Cita + Tienda ${orderId}` : `Reserva Online ${orderId}`) :
            `Venta Online Tienda ${orderId}`;

        // 7. Universal ledger settlement in movimientoCaja
        const ledgerRes = await registerBookingPayment(
            linkedBookingIds || null,
            finalLedgerAmount,
            FORMA_PAGO.ONLINE, {
                concept: orderConcept,
                resourceId: "online",
                traceId,
                transactionId,
                orderId,
                origen: "WIX_ECOM_PAYMENT_WEBHOOK",
                tipoMovimiento: TIPO_MOVIMIENTO.VENTA_ONLINE,
            }
        );

        if (ledgerRes?.status === "SUCCESS") {
            if (bookingIds.length) {
                await _executeWithRetry(async () => {
                    await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
                }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
            }
            return { status: "OK" };
        }

        // 8. Queue fiscal recovery on failure
        await queueFiscalRecovery({
            bookingIds: linkedBookingIds,
            amount: finalLedgerAmount,
            paymentMethod: FORMA_PAGO.ONLINE,
            transactionId,
            orderId,
            origin: "WIX_ECOM_PAYMENT_WEBHOOK",
            concept: orderConcept,
            resourceId: "online",
            tipoMovimiento: TIPO_MOVIMIENTO.VENTA_ONLINE,
            traceId,
            lastError: ledgerRes?.error?.message || "LEDGER_REGISTRATION_FAILED",
        });

        await _logAuditEvent(
            "LEDGER_REGISTRATION_FAILED",
            "ERROR",
            `Ledger registration queued for order ${orderId}`, { orderId, bookingIds, ledgerError: ledgerRes?.error || "Unknown error", traceId },
            traceId,
            orderId
        );

        return { status: "OK" };
    } catch (error) {
        const normalized = _handleError(error, "wixEcom_onOrderPaymentStatusUpdated", traceId);
        await _logAuditEvent(
            "WEBHOOK_CRITICAL_ERROR",
            "ERROR",
            `Critical error in webhook: ${normalized.message}`, { error: normalized.message, traceId },
            traceId
        );
        return { status: "OK" };
    }
}

export async function wixEcom_onOrderRefunded(event) {
    const traceId = makeTraceId("whook-refund");
    try {
        const orderId = String(event?.orderId || event?.order?._id || "").trim() || "unknown";
        const refundObj = event?.refund || event?.data?.refund || null;
        if (!refundObj || orderId === "unknown") return { status: "OK" };

        const rawAmount = typeof refundObj?.amount === "object" && refundObj?.amount !== null ?
            refundObj.amount.amount :
            refundObj?.amount ?? 0;
        const refundAmount = Number(rawAmount) || 0;
        if (refundAmount <= 0) return { status: "OK" };

        const refundId = String(refundObj?._id || refundObj?.id || "").trim();
        if (!refundId) {
            await _logAuditEvent(
                "REFUND_ID_MISSING",
                "ERROR",
                `Refund without stable identifier for order ${orderId}`, { orderId, traceId },
                traceId,
                orderId
            );
            return { status: "OK" };
        }

        const transactionId = `REFUND-${orderId}-${refundId}`;
        const originalTransactionId = `ORDER-${orderId}`;
        const originalMovementRes = await withTimeout(
            wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", originalTransactionId).limit(1).find({ suppressAuth: true }),
            API_TIMEOUT_MS,
            "queryOriginalMovement"
        ).catch(() => ({ items: [] }));

        const originalMovement = originalMovementRes.items?.[0];
        if (!originalMovement) {
            await queueFiscalRecovery({
                bookingIds: "",
                amount: -refundAmount,
                paymentMethod: FORMA_PAGO.ONLINE,
                transactionId,
                orderId,
                refundId,
                origin: "WIX_ECOM_REFUND_WEBHOOK",
                concept: `Refund - Order ${orderId}`,
                resourceId: "online",
                tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
                phase: "WAIT_FOR_ORIGINAL_ORDER_LEDGER",
                traceId,
                lastError: "ORIGINAL_ORDER_LEDGER_MISSING",
            });
            await _logAuditEvent(
                "REFUND_WAITING_FOR_ORIGINAL_LEDGER",
                "ERROR",
                `Refund queued before original ledger for order ${orderId}`, { orderId, refundId, traceId },
                traceId,
                orderId
            );
            return { status: "OK" };
        }

        const originalAmount = Number(originalMovement.importeTotal || 0);
        const linkedBookingIds = originalMovement.reservaIdVinculada ?
            String(originalMovement.reservaIdVinculada).split(",").filter(Boolean) :
            [];
        const refundRestockInfo = event?.sideEffects?.restockInfo ||
            event?.data?.sideEffects?.restockInfo ||
            refundObj?.sideEffects?.restockInfo ||
            null;
        const refundOrder = event?.order ||
            event?.data?.order || { _id: orderId, lineItems: event?.lineItems || event?.data?.lineItems || [] };

        try {
            const inventoryRefund = await recordOnlineInventoryRefundInternal(refundOrder, refundObj, refundRestockInfo, traceId);
            if (inventoryRefund?.status === "SKIPPED" && inventoryRefund?.reason !== "NO_CONFIRMED_RESTOCK") {
                await _logAuditEvent(
                    "REFUND_INVENTORY_TRACE_SKIPPED",
                    "WARN",
                    `Inventory trace skipped for refund ${refundId}`, { orderId, refundId, reason: inventoryRefund.reason, traceId },
                    traceId,
                    orderId
                );
            }
        } catch (inventoryRefundError) {
            await _logAuditEvent(
                "REFUND_INVENTORY_TRACE_FAILED",
                "ERROR",
                `Inventory trace failed for refund ${refundId}`, { orderId, refundId, error: inventoryRefundError?.message || String(inventoryRefundError), traceId },
                traceId,
                orderId
            );
        }

        const ledgerRes = await registerBookingPayment(
            linkedBookingIds.join(",") || null,
            -refundAmount,
            FORMA_PAGO.ONLINE, {
                concept: `Refund - Order ${orderId}`,
                resourceId: "online",
                traceId,
                transactionId,
                orderId,
                refundId,
                origen: "WIX_ECOM_REFUND_WEBHOOK",
                tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
            }
        );

        if (ledgerRes?.status !== "SUCCESS") {
            await queueFiscalRecovery({
                bookingIds: linkedBookingIds.join(","),
                amount: -refundAmount,
                paymentMethod: FORMA_PAGO.ONLINE,
                transactionId,
                orderId,
                refundId,
                origin: "WIX_ECOM_REFUND_WEBHOOK",
                concept: `Refund - Order ${orderId}`,
                resourceId: "online",
                tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
                traceId,
                lastError: ledgerRes?.error?.message || "REFUND_LEDGER_REGISTRATION_FAILED",
            });
            await _logAuditEvent(
                "REFUND_LEDGER_REGISTRATION_FAILED",
                "ERROR",
                `Refund ledger queued for order ${orderId}`, { orderId, refundId, traceId },
                traceId,
                orderId
            );
            return { status: "OK" };
        }

        const refundsRes = await withTimeout(
            wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).startsWith("transactionId", `REFUND-${orderId}-`).limit(1000).find({ suppressAuth: true }),
            API_TIMEOUT_MS,
            "queryRefundsForOrder"
        );
        const refundedTotal = (refundsRes?.items || []).reduce(
            (sum, movement) => sum + Math.abs(Number(movement?.importeContable || movement?.importeTotal || 0)),
            0
        );
        const fullyRefunded = originalAmount > 0 && refundedTotal >= originalAmount;
        await _markCitasRefundedByBookingIds(linkedBookingIds, orderId, refundId, fullyRefunded, traceId);
        return { status: "OK" };
    } catch (error) {
        _handleError(error, "wixEcom_onOrderRefunded", traceId);
        return { status: "OK" };
    }
}

export async function wixEcom_onOrderCanceled(event) {
    const traceId = makeTraceId("whook-order-cancel");
    try {
        const order = event?.order || event?.data?.order || event || {};
        const orderId = String(order?._id || order?.id || "").trim() || "unknown";
        if (orderId !== "unknown") {
            const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
            const bookingsAppId = APP_IDS.BOOKINGS;
            const bookingIds = lineItems
                .filter((item) => item?.catalogReference?.appId === bookingsAppId)
                .map((item) => item?.catalogReference?.catalogItemId)
                .filter(Boolean);
            for (const bId of bookingIds) {
                await _updateCitaEstado(bId, ESTADO_CITA.CANCELED, traceId);
            }
        }
        return { status: "OK" };
    } catch (error) {
        _handleError(error, "wixEcom_onOrderCanceled", traceId);
        return { status: "OK" };
    }
}