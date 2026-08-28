/**
 * =============================================================================
 * MODULE: backend/booking/bookingCore.js
 * VERSION: v20.0.0-resilient-transaction-retry
 * RESPONSIBILITY: Elevated proxies, slot sanitization, mutex locks, atomic
 * transactions, persistence, and error handling.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-resilient-transaction-retry: Allows safe retry of previously failed
 *   transactions on the same slot without artificial lockout, preserving mutex guards.
 * - v19.6.14-addon-contract-cleanup: Removes the unused legacy add-on normalizer that emitted id aliases.
 * - v19.6.8-current-bookings-sdk: Uses the current @wix/bookings SDK package for Writer V2 operations.
 * - v19.6.7-writer-slot-native-id: Emits Writer V2 resource and location identifiers as native _id fields.
 * - v19.6.6-transaction-observability: Logs best-effort transaction failure persistence errors with safe identifiers.
 * - v19.6.3-prioritized-reliability-refactor: Removes duplicated catalog and slot paths, restores Codegem fixes, and hardens persistence.
 * - v19.6.2-serviceid-linkfases-contract: Uses serviceId and derives F2 only from Import2.linkFases.
 * - v19.5.8-dual-cache-miss-query: Reads dual cache misses through a bounded query to avoid expected not-found noise.
 * - v19.5.5-native-slot-schedule-priority: Uses scheduleId from the exact Time Slots V2 response before controlled MAPA_STAFF fallback.
 * - v19.5.4-writer-location-context: Uses the Bookings Writer V2 location enum from the dedicated SSOT context.
 * - v19.5.3: Replaces fixed duplicate-transaction polling with bounded SSOT backoff and jitter.
 * - v19.4.4: Replaced the deprecated staff SDK lookup with MAPA_STAFF scheduleId SSOT and persisted serviceId.
 * - v19.2.0-concurrency-hardened: Uses insert-only lock acquisition, consistent reads, and payload-hash idempotency.
 * - v19.1.2-v2-contract-aligned: Removed duplicate payment-status metadata keys.
 * - v19.1.1-v2-contract-aligned: Normalized Slot V2 and checkout URL contracts.
 * =============================================================================
 */

import { bookings } from "@wix/bookings";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";
import {
    _safeTrim,
    _looksLikeGuid,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    makeTraceId,
    _toDateSafe,
} from "public/mmUtils";
import {
    COLLECTIONS,
    CONCURRENCY,
    SDK_CONFIG,
} from "backend/internalConfig";
import { createHash } from "crypto";

export const logger = {
    error: (msg, data) => console.error("[bookingCore] ERROR:", msg, data),
    warn: (msg, data) => console.warn("[bookingCore] WARN:", msg, data),
    info: (msg, data) => console.info("[bookingCore] INFO:", msg, data),
};

const log = logger;

// -----------------------------------------------------------------------------
// Error codes (exported; used by cajas.web.js and others)
// -----------------------------------------------------------------------------
export const ERROR_CODES = Object.freeze({
    INVALID_PAYLOAD: "INVALID_PAYLOAD",
    TOKEN_BUSY: "TOKEN_BUSY",
    FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
    FISCAL_VIOLATION: "FISCAL_VIOLATION",
    BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
    CHECKOUT_FAILED: "CHECKOUT_FAILED",
    INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    ACCESS_DENIED: "ACCESS_DENIED",
    INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
    RATE_LIMITED: "RATE_LIMITED",
});

// -----------------------------------------------------------------------------
// Elevated proxies (Bookings V2 + eCom backend)
// -----------------------------------------------------------------------------
export const createBookingElevated = elevate(bookings.createBooking);
export const cancelBookingElevated = elevate(bookings.cancelBooking);
export const confirmOrDeclineBookingElevated = elevate(bookings.confirmOrDeclineBooking);
export const rescheduleBookingElevated = elevate(bookings.rescheduleBooking);

export const createCheckoutElevated = elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = elevate(checkout.getCheckoutUrl);

// -----------------------------------------------------------------------------
// Writer V2 slot projection
// -----------------------------------------------------------------------------
function _toUtcDateFromAvailability(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const raw = _safeTrim(value);
    if (!raw) return null;
    if (raw.endsWith("Z")) {
        const utc = new Date(raw);
        return isNaN(utc.getTime()) ? null : utc;
    }
    return getUtcDateFromMadridLocal(raw);
}

/**
 * Projects the exact revalidated Time Slots V2 response into the Writer V2
 * appointment slot contract. It never derives duration, scheduleId, or location
 * from staff settings. The selected resource is the only explicit assignment.
 */
export function _projectWriterSlotFromAvailability(slot, resourceId, expectedServiceId) {
    const s = slot && typeof slot === "object" ? slot : null;
    if (!s) return null;

    const serviceId = _safeTrim(s.serviceId || expectedServiceId);
    const resourceIdClean = _safeTrim(resourceId || s.resource?._id || s.resource?.id || s.resourceId);
    const scheduleId = _safeTrim(s.scheduleId || s.slot?.scheduleId || s.schedule?.id || s.resource?.scheduleId);
    const startDate = _toUtcDateFromAvailability(s.startDate || s.localStartDate);
    const endDate = _toUtcDateFromAvailability(s.endDate || s.localEndDate);
    const location = s.location && typeof s.location === "object" ? s.location : null;
    const locationId = _safeTrim(location?._id || location?.id);

    if (
        !_looksLikeGuid(serviceId) ||
        !_looksLikeGuid(resourceIdClean) ||
        !_looksLikeGuid(scheduleId) ||
        !startDate ||
        !endDate ||
        endDate.getTime() <= startDate.getTime() ||
        !_looksLikeGuid(locationId)
    ) {
        return null;
    }

    return {
        ...s,
        serviceId,
        scheduleId,
        startDate,
        endDate,
        timezone: _safeTrim(s.timezone) || _safeTrim(SDK_CONFIG?.TZ),
        resource: { _id: resourceIdClean },
        location: {
            _id: locationId,
            locationType: _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER),
        },
    };
}

// -----------------------------------------------------------------------------
// Checkout URL helper (stable)
// -----------------------------------------------------------------------------
export function _extractCheckoutId(checkoutSession) {
    return checkoutSession?.checkout?._id || checkoutSession?._id || null;
}

export async function getCheckoutUrlSafe(checkoutSessionOrId) {
    const direct = checkoutSessionOrId?.checkoutUrl || checkoutSessionOrId?.checkout?.checkoutUrl || null;
    if (direct) return direct;

    const checkoutId =
        typeof checkoutSessionOrId === "string" ? checkoutSessionOrId : _extractCheckoutId(checkoutSessionOrId);

    if (!checkoutId) return null;

    try {
        const result = await getCheckoutUrlElevated(checkoutId, {});
        return result?.checkoutUrl || null;
    } catch (error) {
        log.warn("getCheckoutUrlSafe failed", { checkoutId, error: error?.message });
        return null;
    }
}

// -----------------------------------------------------------------------------
// Mutex locks (stable _id derived from slotKey)
// -----------------------------------------------------------------------------
const MUTEX_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 120000;
const LOCKS_COL = COLLECTIONS.LOCKS;

export function _safeLockId(key) {
    const k = String(key || "").trim();
    if (!k) return "";
    return `lk_${createHash("sha256").update(k).digest("hex")}`;
}

async function _getLock(slotKey) {
    const k = String(slotKey || "");
    if (!k) return null;

    const id = _safeLockId(k);
    const item = await wixData
        .get(LOCKS_COL, id, { suppressAuth: true, consistentRead: true })
        .catch(() => null);
    if (!item) return null;

    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    if (item.createdAt) item.createdAt = _toDateSafe(item.createdAt);
    if (item.updatedAt) item.updatedAt = _toDateSafe(item.updatedAt);

    return item;
}

function _isDuplicateItemError(error) {
    const message = String(error?.message || "");
    return message.includes("WDE0123") || message.includes("WD_ITEM_ALREADY_EXISTS") || message.includes("Duplicated");
}

function _buildLockDocument(slotKey, lockOwnerId, ttlMs, existing = null) {
    const now = new Date();
    const safeId = _safeLockId(slotKey);
    if (!safeId) throw new Error("LOCK_KEY_INVALID");

    return {
        ...(existing || {}),
        _id: safeId,
        slotKey: String(slotKey),
        traceId: String(lockOwnerId || makeTraceId("lock")),
        expiresAt: new Date(Date.now() + (Number(ttlMs) || MUTEX_TTL_MS)),
        createdAt: existing?.createdAt ? _toDateSafe(existing.createdAt) || now : now,
        updatedAt: now,
    };
}

async function _reclaimExpiredLock(slotKey, lockOwnerId, ttlMs, observed) {
    const observedExpiry = _toDateSafe(observed?.expiresAt);
    if (!observedExpiry || observedExpiry.getTime() >= Date.now()) {
        return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
    }

    // Re-read before removal so a renewed or replaced lease is never removed.
    const current = await _getLock(slotKey);
    const currentExpiry = _toDateSafe(current?.expiresAt);
    if (!current || current.traceId !== observed.traceId || !currentExpiry || currentExpiry.getTime() >= Date.now()) {
        return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
    }

    try {
        await wixData.remove(LOCKS_COL, current._id, { suppressAuth: true });
    } catch (error) {
        return { ok: false, message: "LOCK_RECLAIM_RACE" };
    }

    try {
        await wixData.insert(LOCKS_COL, _buildLockDocument(slotKey, lockOwnerId, ttlMs, current), { suppressAuth: true });
        return { ok: true, reclaimed: true };
    } catch (error) {
        if (_isDuplicateItemError(error)) return { ok: false, message: "LOCK_RECLAIM_RACE" };
        log.error("Expired lock reclaim failed", { slotKey, lockOwnerId, error: error?.message });
        return { ok: false, message: "LOCK_RECLAIM_FAILED" };
    }
}

export async function _lockSlotKeyOrFail(slotKey, lockOwnerId, ttlMs) {
    const k = String(slotKey || "");
    const owner = String(lockOwnerId || "").trim();
    if (!k || !owner) return { ok: false, message: "LOCK_KEY_OR_OWNER_INVALID" };

    try {
        const lockDocument = _buildLockDocument(k, owner, ttlMs);
        await wixData.insert(LOCKS_COL, lockDocument, { suppressAuth: true });
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotKey: k, lockOwnerId: owner, error: error?.message });
            return { ok: false, message: error?.message || "Lock acquisition failed" };
        }

        const existing = await _getLock(k);
        if (existing?.traceId === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok ? { ok: true, renewed: true } : { ok: false, message: "LOCK_RENEWAL_FAILED" };
        }

        const expiresAt = _toDateSafe(existing?.expiresAt);
        const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        if (expired) {
            const reclaimed = await _reclaimExpiredLock(k, owner, ttlMs, existing);
            if (reclaimed.ok) return reclaimed;
            return {
                ok: false,
                message: reclaimed.message || "LOCK_RECLAIM_RACE",
                retryAfterMs: Number(CONCURRENCY?.LOCK_CLEANUP_GRACE_MS) || 60000,
            };
        }
        return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER", retryAfterMs: 0 };
    }
}

export async function _unlockSlotKey(slotKey, lockOwnerId) {
    const owner = String(lockOwnerId || "").trim();
    const existing = await _getLock(slotKey);
    if (!existing) return { ok: true, missing: true };
    if (!owner || existing.traceId !== owner) return { ok: false, skipped: true };

    await wixData.remove(LOCKS_COL, existing._id, { suppressAuth: true });
    return { ok: true };
}

export async function _renewLock(slotKey, lockOwnerId, ttlMs) {
    try {
        const owner = String(lockOwnerId || "").trim();
        const existing = await _getLock(slotKey);
        if (!existing || !owner || existing.traceId !== owner) return { ok: false };
        const expiresAt = _toDateSafe(existing.expiresAt);
        if (!expiresAt || expiresAt.getTime() < Date.now()) return { ok: false, expired: true };

        const updated = _buildLockDocument(slotKey, owner, ttlMs, existing);
        await wixData.update(LOCKS_COL, updated, { suppressAuth: true });
        return { ok: true };
    } catch (error) {
        log.error("_renewLock failed", { slotKey, lockOwnerId, error: error?.message });
        return { ok: false };
    }
}

// -----------------------------------------------------------------------------
// Dual cache
// -----------------------------------------------------------------------------
const DUAL_CACHE_COL = COLLECTIONS.DUAL_CACHE;

export async function _getDualPairFromCache(pairToken, traceId) {
    const token = _safeTrim(pairToken);
    if (!token) return null;

    const result = await wixData
        .query(DUAL_CACHE_COL)
        .eq("_id", token)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(() => ({ items: [] }));

    const item = Array.isArray(result?.items) ? result.items[0] || null : null;
    if (!item) return null;

    const exp = _toDateSafe(item.expiresAt);
    if (exp && exp.getTime() < Date.now()) {
        await wixData.remove(DUAL_CACHE_COL, item._id, { suppressAuth: true }).catch((error) => {
            log.warn("Expired dual cache cleanup failed", { traceId, error: error?.message });
        });
        return null;
    }
    return item;
}

// -----------------------------------------------------------------------------
// Slot keys
// -----------------------------------------------------------------------------
export function _generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date ? startDate : getUtcDateFromMadridLocal(startDate);
    const endUtc = endDate instanceof Date ? endDate : getUtcDateFromMadridLocal(endDate);

    const startEpochMin = startUtc ? Math.floor(startUtc.getTime() / 60000) : 0;
    const endEpochMin = endUtc ? Math.floor(endUtc.getTime() / 60000) : 0;

    const raw = `${String(serviceId || "").trim()}|${String(resourceId || "").trim()}|${startEpochMin}|${endEpochMin}`;
    return `slot_${createHash("sha256").update(raw).digest("hex")}`;
}

export function _buildLockKeys(phases, resourceId) {
    const keys = (phases || []).map((p) => {
        const slot = p?.rawSlot || {};
        return _generateSlotKey(slot.serviceId, resourceId, p.localStart, p.localEnd);
    });
    return Array.from(new Set(keys)).sort();
}

// -----------------------------------------------------------------------------
// Transactions (idempotency)
// -----------------------------------------------------------------------------
export const TRANSACTIONS_COL = COLLECTIONS.TRANSACTIONS;
const TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY?.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY?.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    const id = String(pairToken || "");
    if (!id) return null;
    return await wixData.get(TRANSACTIONS_COL, id, { suppressAuth: true, consistentRead: true }).catch(() => null);
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = String(pairToken || "");
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    try {
        await wixData.insert(
            TRANSACTIONS_COL, {
                _id: id,
                pairToken: id,
                status: "PENDING",
                payloadHash,
                traceId,
                createdAt: new Date(),
                updatedAt: new Date(),
            }, { suppressAuth: true }
        );
        return { success: true, isNew: true };
    } catch (error) {
        if (_isDuplicateItemError(error)) {
            const startTime = Date.now();
            let pollAttempt = 0;

            while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
                const existing = await _getTransactionById(id);
                if (existing) {
                    if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                        return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                    }
                    if (existing.status === "COMPLETED") return { success: true, isNew: false, existing };
                    if (existing.status === "FAILED") {
                        const updatedDoc = {
                            ...existing,
                            status: "PENDING",
                            error: null,
                            traceId,
                            updatedAt: new Date(),
                        };
                        await wixData.update(TRANSACTIONS_COL, updatedDoc, { suppressAuth: true });
                        return { success: true, isNew: true, retriedFromFailed: true };
                    }
                }
                const elapsedMs = Date.now() - startTime;
                const remainingMs = TRANSACTION_MAX_WAIT_MS - elapsedMs;
                const exponentialDelayMs = TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3));
                const jitteredDelayMs = Math.floor(exponentialDelayMs * (0.5 + Math.random()));
                const waitMs = Math.max(0, Math.min(jitteredDelayMs, remainingMs));
                if (waitMs <= 0) break;
                pollAttempt++;
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }

            const existing = await _getTransactionById(id);
            if (existing) {
                if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                    return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                }
                if (existing.status === "FAILED") {
                    const updatedDoc = {
                        ...existing,
                        status: "PENDING",
                        error: null,
                        traceId,
                        updatedAt: new Date(),
                    };
                    await wixData.update(TRANSACTIONS_COL, updatedDoc, { suppressAuth: true });
                    return { success: true, isNew: true, retriedFromFailed: true };
                }
                return { success: true, isNew: false, existing, timeout: true };
            }
            return { success: false, error: "TRANSACTION_TIMEOUT" };
        }
        throw error;
    }
}

export async function _completeTransaction(pairToken, result) {
    const id = String(pairToken || "");
    if (!id) return;

    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;

    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "COMPLETED",
        result,
        updatedAt: new Date(),
        createdAt: existing?.createdAt || new Date(),
    };

    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true });
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true });
}

export async function _failTransaction(pairToken, errorMessage) {
    const id = String(pairToken || "");
    if (!id) return;

    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;

    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "FAILED",
        error: String(errorMessage || "UNKNOWN_ERROR"),
        updatedAt: new Date(),
        createdAt: existing?.createdAt || new Date(),
    };

    const action = existing ? "update" : "insert";
    const persist = existing ?
        wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true }) :
        wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true });

    await persist.catch((error) => {
        log.error("_failTransaction persistence failed", {
            pairToken: id,
            action,
            message: error?.message || "UNKNOWN_ERROR",
        });
    });
}

// -----------------------------------------------------------------------------
// Persist booking (CMS) - CitasF2 aligned fields
// -----------------------------------------------------------------------------
const CITAS_COL = COLLECTIONS.CITAS;
const CITA_STATUS_BY_PAYMENT = Object.freeze({
    UNPAID: "CONFIRMED",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "CONFIRMED",
    PAID: "CONFIRMED",
    REFUNDED: "CANCELED",
    PARTIALLY_REFUNDED: "CONFIRMED",
});

function _getCitaStatusFromPayment(statusPago) {
    const payment = String(statusPago || "").trim().toUpperCase();
    const status = CITA_STATUS_BY_PAYMENT[payment];
    if (!status) throw new Error(`Unsupported payment status: ${payment || "EMPTY"}`);
    return status;
}

export async function _persistBooking(params, traceId) {
    const {
        bookingId,
        revision,
        serviceId,
        scheduleId,
        resourceId,
        startDate,
        endDate,
        contactDetails,
        tipo,
        meta,
    } = params || {};

    if (!bookingId || !serviceId || !resourceId || !startDate || !endDate) {
        throw new Error("Missing required fields for persistBooking");
    }

    const startDateObj = startDate instanceof Date ? startDate : new Date(startDate);
    const endDateObj = endDate instanceof Date ? endDate : new Date(endDate);

    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
        throw new Error("Invalid startDate/endDate for persistBooking");
    }

    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const endLocal = getMadridLocalStringNoZ(endDateObj);
    const fechaYmdMadrid = startLocal ? startLocal.slice(0, 10) : "";
    const now = new Date();

    const metaPago = String(meta?.statusPago || "UNPAID").trim().toUpperCase();
    const statusCita = _getCitaStatusFromPayment(metaPago);
    const citaId = `booking_${String(bookingId).trim()}`;

    const doc = {
        _id: citaId,
        bookingId: String(bookingId),
        pairToken: String(meta?.pairToken || meta?.uiPairToken || ""),
        uiPairToken: String(meta?.uiPairToken || meta?.pairToken || ""),
        revision: Number(revision) || 1,
        serviceId: String(serviceId),
        scheduleId: scheduleId ? String(scheduleId) : null,
        resourceId: String(resourceId),
        startDate: startDateObj,
        endDate: endDateObj,
        startDateLocal: startLocal,
        endDateLocal: endLocal,
        fechaYmdMadrid,
        tipo: tipo || "simple",

        // CitasF2 fields
        status: statusCita,
        statusPago: metaPago,

        // Keep meta for saga/debug + compatibility inside meta only
        meta: {
            ...(meta || {}),
            status: statusCita,
            estado: statusCita,
            statusPago: metaPago,
        },

        contactDetails: contactDetails || {},
        traceId: String(traceId || ""),
        fechaCreacion: now,
        fechaActualizacion: now,
    };

    if (!doc.pairToken) throw new Error("Missing pairToken for persistBooking");

    try {
        const item = await wixData.insert(CITAS_COL, doc, { suppressAuth: true, suppressHooks: true });
        return { created: true, item };
    } catch (error) {
        if (!_isDuplicateItemError(error)) throw error;
        const existing = await wixData.get(CITAS_COL, citaId, { suppressAuth: true, consistentRead: true }).catch(() => null);
        if (!existing || String(existing.bookingId || "") !== String(bookingId) || String(existing.pairToken || "") !== doc.pairToken) {
            throw new Error("CITAS_IDEMPOTENCY_CONFLICT");
        }
        return { created: false, item: existing };
    }
}

export function _sumAddons(addons) {
    if (!Array.isArray(addons)) return 0;
    return addons.reduce((acc, a) => acc + Number(a.precio || a.price || 0), 0);
}

// -----------------------------------------------------------------------------
// Errors + PII sanitization
// -----------------------------------------------------------------------------
export class BookingError extends Error {
    constructor(code, message, details = {}) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || "UNKNOWN_ERROR");
        this.details = details && typeof details === "object" ? details : { details };
        this.timestamp = new Date().toISOString();
        if (Error.captureStackTrace) Error.captureStackTrace(this, BookingError);
    }
}

export function createBookingError(code, message, details) {
    return new BookingError(code, message, details);
}

const PII_KEYS = new Set([
    "nombre",
    "apellidos",
    "firstname",
    "lastname",
    "email",
    "telefono",
    "phone",
    "address",
    "cliente",
    "contactdetails",
    "contactid",
    "identity",
]);

function _isPiiKey(key) {
    const normalized = String(key || "").toLowerCase().replace(/[\s_-]/g, "");
    if (PII_KEYS.has(normalized)) return true;
    return /(?:email|mail|telefono|phone|movil|mobile|address|direccion|dni|nif|nombre|name|apellido|surname|contact)$/i.test(normalized);
}

function _sanitizeDetails(details) {
    if (!details) return details;
    if (Array.isArray(details)) return details.map((v) => _sanitizeDetails(v));
    if (typeof details !== "object") return details;

    const sanitized = {};
    for (const [key, value] of Object.entries(details)) {
        if (_isPiiKey(key)) sanitized[key] = "[REDACTED]";
        else if (typeof value === "object" && value !== null) sanitized[key] = _sanitizeDetails(value);
        else sanitized[key] = value;
    }
    return sanitized;
}

export function normalizeError(err) {
    if (err && typeof err === "object" && err.name === "BookingError") {
        return {
            code: String(err.code || "UNKNOWN_ERROR"),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details || {},
        };
    }

    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || "UNKNOWN_ERROR"),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details && typeof err.details === "object" ? err.details : {},
            statusCode: err.statusCode || err.status || null,
        };
    }

    if (typeof err === "string") return { code: "UNKNOWN_ERROR", message: err, stack: null, details: {} };
    if (!err) return { code: "UNKNOWN_ERROR", message: "Unknown error", stack: null, details: {} };

    if (typeof err === "object") {
        const code = err.code || err.errorCode || err.name || "UNKNOWN_ERROR";
        const message = err.message || err.error || err.description || JSON.stringify(err);
        const details = err.details && typeof err.details === "object" ? err.details : {};
        return {
            code: String(code),
            message: String(message),
            stack: err.stack || null,
            details,
            statusCode: err.statusCode || err.status || null,
        };
    }

    return { code: "UNKNOWN_ERROR", message: String(err), stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    const sanitizedDetails = _sanitizeDetails(norm.details || {});

    loggerInstance.error(`[${context}] ${norm.code}: ${norm.message}`, { traceId, details: sanitizedDetails });

    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || "UNKNOWN_ERROR",
            message: norm.message || "Unknown error",
            ...(Object.keys(sanitizedDetails).length ? { details: sanitizedDetails } : {}),
        },
    };
}