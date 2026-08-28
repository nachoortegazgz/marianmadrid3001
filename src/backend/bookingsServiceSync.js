/**
 * =============================================================================
 * MODULE: backend/bookingsServiceSync.js
 * VERSION: v20.0.0-canonical-guid-boundary
 * RESPONSIBILITY: Queue-driven one-way projection from SERVICIOS_CITA to Wix
 *                 Bookings Services V2. The CMS record owns selected commercial
 *                 fields; native bookings, schedules, forms, and history remain
 *                 owned by Wix.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters). No customer data or raw upstream errors in logs.
 * HISTORIAL:
 * - v20.0.0-canonical-guid-boundary: Strictly separates CMS item _id from native Bookings serviceId GUID.
 * =============================================================================
 */

import wixData from "wix-data";
import { elevate } from "wix-auth";
import { services } from "wix-bookings.v2";
import { makeTraceId, _looksLikeGuid } from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";
import { _lockSlotKeyOrFail, _unlockSlotKey, logger } from "backend/booking/bookingCore";
import { resolveStaffResourceIds } from "backend/staff";
import { COLLECTIONS, SDK_CONFIG, SERVICE_CATALOG } from "backend/internalConfig";

const log = logger;
const QUEUE_COL = COLLECTIONS.BOOKINGS_SERVICE_SYNC_QUEUE;
const SERVICES_COL = COLLECTIONS.SERVICIOS_CITA;
const MAX_ATTEMPTS = SDK_CONFIG.JOBS.BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS;
const BATCH_SIZE = SDK_CONFIG.JOBS.BOOKINGS_SERVICE_SYNC_BATCH_SIZE;
const BACKOFF_MS = SDK_CONFIG.JOBS.BOOKINGS_SERVICE_SYNC_BACKOFF_MS;
const LOCK_TTL_MS = 120000;
const ACTIVE_STATE = "ACTIVO";
const APPOINTMENT_TYPE = "APPOINTMENT";
const VALID_STATUS = new Set(["PENDING", "RETRY"]);

const getServiceElevated = elevate(services.getService);
const updateServiceElevated = elevate(services.updateService);

function _cleanText(value, maxLength) {
    const text = String(value ?? "").trim();
    if (text.length > maxLength) throw new Error("SYNC_TEXT_TOO_LONG");
    return text;
}

function _referenceId(value) {
    const candidate = value && typeof value === "object" ? (value._id || value.id) : value;
    return String(candidate || "").trim().toUpperCase();
}

function _readBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}

function _cleanGuid(value, errorCode) {
    const guid = String(value || "").trim();
    if (!_looksLikeGuid(guid)) throw new Error(errorCode);
    return guid;
}

function _cleanGuidList(value) {
    if (!Array.isArray(value)) throw new Error("SYNC_STAFF_REQUIRED");
    const ids = Array.from(new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean)));
    if (!ids.length || ids.some((id) => !_looksLikeGuid(id))) throw new Error("SYNC_STAFF_INVALID");
    return ids;
}

function _mediaIdentity(value) {
    const raw = String(value || "").trim();
    const match = /^wix:image:\/\/v1\/([^/?=]+)/.exec(raw);
    return match ? match[1] : raw;
}

function _stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(_stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function _buildPayment(source) {
    const price = Number(source?.precio);
    const online = _readBoolean(source?.pagoOnline, false);
    const inPerson = _readBoolean(source?.pagoPresencial, false);
    if (!online && !inPerson) throw new Error("SYNC_PAYMENT_CHANNEL_REQUIRED");

    const currency = _referenceId(source?.monedaCatalogo || source?.moneda) || SERVICE_CATALOG.CURRENCY;
    if (currency !== SERVICE_CATALOG.CURRENCY) throw new Error("SYNC_CURRENCY_INVALID");
    if (!Number.isFinite(price) || price < 0) throw new Error("SYNC_PRICE_INVALID");
    if (price === 0) {
        return {
            rateType: "NO_FEE",
            options: { online, inPerson, deposit: false, pricingPlan: false },
        };
    }
    return {
        rateType: "FIXED",
        fixed: { price: { value: String(Math.round(price * 100) / 100), currency } },
        options: { online, inPerson, deposit: false, pricingPlan: false },
    };
}

function _buildMedia(source) {
    const raw = source?.bookingsMedia;
    if (!raw) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("SYNC_MEDIA_INVALID");
    const image = _cleanText(raw.mainImage || raw.image || "", 2048);
    if (!image.startsWith("wix:image://")) throw new Error("SYNC_MEDIA_INVALID");
    const altText = _cleanText(raw.altText || "", 120);
    return { mainMedia: { image, ...(altText ? { altText } : {}) } };
}

async function _buildDesiredProjection(source) {
    const serviceId = _cleanGuid(source?.serviceId, "SYNC_SERVICE_ID_INVALID");
    if (source?.bookingsSyncEnabled !== true) throw new Error("SYNC_DISABLED");

    const categoryId = _cleanGuid(source?.bookingsCategoryId, "SYNC_CATEGORY_REQUIRED");
    const type = _cleanText(source?.bookingsTipo || APPOINTMENT_TYPE, 24).toUpperCase();
    if (type !== APPOINTMENT_TYPE) throw new Error("SYNC_SERVICE_TYPE_UNSUPPORTED");

    const state = _referenceId(source?.estado);
    const hiddenByState = Boolean(state && state !== ACTIVE_STATE);
    const onlineEnabled = _readBoolean(source?.bookingsOnlineEnabled, !hiddenByState && source?.oculto !== true);
    const requireManualApproval = _readBoolean(source?.bookingsRequiereAprobacion, false);
    const allowMultipleRequests = _readBoolean(source?.bookingsPermiteSolicitudesMultiples, false);
    const media = _buildMedia(source);
    const personalDisponible = Array.isArray(source?.personalDisponible) ?
        source.personalDisponible :
        source?.bookingsStaffResourceIds;
    const staffMemberIds = await resolveStaffResourceIds(personalDisponible);

    const desired = {
        type,
        name: _cleanText(source?.tituloServicio, SERVICE_CATALOG.MAX_TITLE_LENGTH),
        description: _cleanText(source?.descripcionLarga, SERVICE_CATALOG.MAX_DESCRIPTION_LENGTH),
        tagLine: _cleanText(source?.resumenCorto, SERVICE_CATALOG.MAX_SUMMARY_LENGTH),
        hidden: hiddenByState || source?.oculto === true,
        category: { _id: categoryId },
        defaultCapacity: 1,
        payment: _buildPayment(source),
        onlineBooking: {
            enabled: onlineEnabled,
            requireManualApproval,
            allowMultipleRequests,
        },
        staffMemberIds,
    };
    if (!desired.name) throw new Error("SYNC_NAME_REQUIRED");
    if (media) desired.media = media;
    return { serviceId, desired };
}

function _queueId(sourceItemId) {
    const id = String(sourceItemId || "").trim();
    if (!id) throw new Error("SYNC_SOURCE_ID_MISSING");
    return `bookings-service-sync-${id}`;
}

function _errorCode(error) {
    const message = String(error?.message || "").toUpperCase();
    if (message.includes("REVISION")) return "REVISION_CONFLICT";
    if (message.includes("PERMISSION") || message.includes("UNAUTHORIZED") || message.includes("FORBIDDEN")) return "BOOKINGS_PERMISSION_DENIED";
    if (message.includes("NOT_FOUND")) return "BOOKINGS_SERVICE_NOT_FOUND";
    if (message.includes("TIMEOUT") || message.includes("429") || message.includes("503") || message.includes("504")) return "BOOKINGS_TEMPORARY_FAILURE";
    if (message.startsWith("SYNC_")) return message.slice(0, 80);
    return "BOOKINGS_SYNC_FAILED";
}

function _matchesProjection(native, desired) {
    const current = {
        type: String(native?.type || "").toUpperCase(),
        name: String(native?.name || "").trim(),
        description: String(native?.description || "").trim(),
        tagLine: String(native?.tagLine || "").trim(),
        hidden: native?.hidden === true,
        category: { _id: String(native?.category?._id || native?.category?.id || "").trim() },
        defaultCapacity: Number(native?.defaultCapacity || 0),
        payment: native?.payment ? {
            rateType: String(native.payment.rateType || "").toUpperCase(),
            fixed: native.payment.fixed ? {
                price: {
                    value: String(native.payment.fixed?.price?.value || ""),
                    currency: String(native.payment.fixed?.price?.currency || "").toUpperCase(),
                },
            } : undefined,
            options: {
                online: native.payment.options?.online === true,
                inPerson: native.payment.options?.inPerson === true,
                deposit: native.payment.options?.deposit === true,
                pricingPlan: native.payment.options?.pricingPlan === true,
            },
        } : null,
        onlineBooking: {
            enabled: native?.onlineBooking?.enabled === true,
            requireManualApproval: native?.onlineBooking?.requireManualApproval === true,
            allowMultipleRequests: native?.onlineBooking?.allowMultipleRequests === true,
        },
        staffMemberIds: Array.isArray(native?.staffMemberIds) ? [...native.staffMemberIds].map(String).sort() : [],
    };
    const expected = { ...desired, staffMemberIds: [...desired.staffMemberIds].sort() };
    const expectedImage = _mediaIdentity(expected?.media?.mainMedia?.image);
    if (expectedImage) {
        const currentImage = _mediaIdentity(native?.media?.mainMedia?.image);
        if (!currentImage || currentImage !== expectedImage) return false;
    }
    delete expected.media;
    return _stableSerialize(current) === _stableSerialize(expected);
}

async function _saveQueue(queue, patch) {
    return wixData.update(QUEUE_COL, { ...queue, ...patch, updatedAt: new Date() }, { suppressAuth: true });
}

export async function enqueueBookingsServiceSync(sourceItem) {
    if (!sourceItem || typeof sourceItem !== "object" || sourceItem.bookingsSyncEnabled !== true) return null;
    const sourceItemId = String(sourceItem._id || "").trim();
    if (!sourceItemId) return null;

    const now = new Date();
    const traceId = makeTraceId("bookings-service-sync");
    let projection;
    let errorCode = "";
    try {
        projection = await _buildDesiredProjection(sourceItem);
    } catch (error) {
        errorCode = _errorCode(error);
    }

    const serviceId = String(sourceItem.serviceId || "").trim();

    const queue = {
        _id: _queueId(sourceItemId),
        serviceId: serviceId,
        sourceItemId: sourceItemId,
        desiredHash: projection ? hashSHA256(_stableSerialize(projection.desired)) : "",
        status: projection ? "PENDING" : "BLOCKED",
        attempts: 0,
        nextAttemptAt: now,
        traceId,
        errorCode,
        createdAt: now,
        updatedAt: now,
    };
    await wixData.save(QUEUE_COL, queue, { suppressAuth: true });
    return { status: queue.status, traceId, errorCode: queue.errorCode || null };
}

async function _processQueueItem(queue, traceId) {
    const serviceId = _cleanGuid(queue?.serviceId, "SYNC_SERVICE_ID_INVALID");
    const sourceItemId = String(queue?.sourceItemId || "").trim();
    const lockKey = `bookings-service-sync:${serviceId}`;
    const lock = await _lockSlotKeyOrFail(lockKey, `${traceId}:${String(queue?._id || serviceId)}`, LOCK_TTL_MS);
    if (!lock?.ok) return { status: "SKIPPED", errorCode: "SYNC_LOCKED" };

    try {
        const source = await wixData.get(SERVICES_COL, sourceItemId, { suppressAuth: true });
        const projection = await _buildDesiredProjection(source);
        if (projection.serviceId !== serviceId) throw new Error("SYNC_SERVICE_ID_MISMATCH");
        const native = await getServiceElevated(serviceId);
        if (!native || String(native?._id || native?.id || "").trim() !== serviceId) {
            throw new Error("BOOKINGS_SERVICE_NOT_FOUND");
        }

        const desiredHash = hashSHA256(_stableSerialize(projection.desired));
        if (_matchesProjection(native, projection.desired)) {
            await _saveQueue(queue, {
                desiredHash,
                status: "COMPLETED",
                errorCode: "",
                completedAt: new Date(),
            });
            return { status: "COMPLETED", errorCode: null };
        }

        const revision = String(native?.revision || "").trim();
        if (!revision) throw new Error("SYNC_NATIVE_REVISION_MISSING");
        const updated = await updateServiceElevated(serviceId, { ...projection.desired, revision });
        const updatedId = String(updated?._id || updated?.id || "").trim();
        if (updatedId && updatedId !== serviceId) throw new Error("SYNC_UPDATED_ID_MISMATCH");

        await _saveQueue(queue, {
            desiredHash,
            status: "COMPLETED",
            errorCode: "",
            completedAt: new Date(),
        });
        return { status: "COMPLETED", errorCode: null };
    } catch (error) {
        const attempts = Number(queue?.attempts || 0) + 1;
        const errorCode = _errorCode(error);
        const terminal = attempts >= MAX_ATTEMPTS || errorCode.startsWith("SYNC_") || errorCode === "BOOKINGS_PERMISSION_DENIED";
        await _saveQueue(queue, {
            status: terminal ? "FAILED" : "RETRY",
            attempts,
            errorCode,
            nextAttemptAt: new Date(Date.now() + BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1))),
            ...(terminal ? { failedAt: new Date() } : {}),
        });
        log.warn("Bookings service sync deferred or failed", { serviceId, traceId, attempts, errorCode, terminal });
        return { status: terminal ? "FAILED" : "RETRY", errorCode };
    } finally {
        await _unlockSlotKey(lockKey, `${traceId}:${String(queue?._id || serviceId)}`).catch(() => null);
    }
}

export async function processBookingsServiceSyncQueue(options = {}) {
    const traceId = options.traceId || makeTraceId("cron-bookings-service-sync");
    const limit = Math.max(1, Math.min(Number(options.limit) || BATCH_SIZE, BATCH_SIZE));
    const now = new Date();
    const result = { scanned: 0, completed: 0, retried: 0, failed: 0, skipped: 0 };
    const pending = await wixData.query(QUEUE_COL)
        .in("status", [...VALID_STATUS])
        .le("nextAttemptAt", now)
        .ascending("nextAttemptAt")
        .limit(limit)
        .find({ suppressAuth: true, consistentRead: true });

    for (const queue of pending?.items || []) {
        result.scanned++;
        const itemResult = await _processQueueItem(queue, traceId);
        if (itemResult.status === "COMPLETED") result.completed++;
        else if (itemResult.status === "RETRY") result.retried++;
        else if (itemResult.status === "FAILED") result.failed++;
        else result.skipped++;
    }
    return { status: result.failed ? "PARTIAL" : "SUCCESS", data: result, error: null };
}