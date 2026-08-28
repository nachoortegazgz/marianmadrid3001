/**
 * =============================================================================
 * MODULE: backend/m365GraphSync.js
 * RESPONSIBILITY: Durable, minimal-data projection of finalized ledger records
 *                 to one private Microsoft 365 SharePoint list through Graph.
 * SECURITY: App-only credentials stay in Wix Secrets Manager. Queue payloads
 *           never contain customer profile, contact, service description, or
 *           raw upstream errors.
 * STANDARDS: G10 ASCII Strict.
 * =============================================================================
 */

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import { makeTraceId, withTimeout } from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";
import { _lockSlotKeyOrFail, _unlockSlotKey, logger } from "backend/booking/bookingCore";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";

const log = logger;
const QUEUE_COL = COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
const SYNC_LOG_COL = COLLECTIONS.SYNC_LOG;
const TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;
const BATCH_SIZE = Math.max(1, Math.min(Number(SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BATCH_SIZE) || 20, 50));
const MAX_ATTEMPTS = Math.max(1, Math.min(Number(SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_MAX_ATTEMPTS) || 3, 5));
const BACKOFF_MS = Math.max(60000, Number(SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BACKOFF_MS) || 300000);
const LOCK_TTL_MS = 120000;
const PENDING_STATES = ["PENDING", "RETRY", "BLOCKED"];
const ALLOWED_EVENT_TYPES = new Set(["LEDGER_MOVEMENT", "Z_CLOSING"]);
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

function _isM365Enabled() {
    return SDK_CONFIG?.M365?.ENABLED === true;
}

function _cleanText(value, maxLength) {
    return String(value ?? "").trim().replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function _cleanTraceId(value) {
    const traceId = _cleanText(value, 120).replace(/[^A-Za-z0-9_-]/g, "_");
    return traceId || makeTraceId("m365-graph");
}

function _cleanIdentifier(value, maxLength) {
    const id = _cleanText(value, maxLength);
    if (!id || id.includes("/") || id.includes("\\") || /[\r\n]/.test(id)) return "";
    return id;
}

function _cleanAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || Math.abs(amount) > 1000000) throw new Error("M365_GRAPH_AMOUNT_INVALID");
    return Math.round(amount * 100) / 100;
}

function _toIsoDate(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) throw new Error("M365_GRAPH_DATE_INVALID");
    return date.toISOString();
}

function _stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(_stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function _queueId(payload) {
    return `m365-graph-${hashSHA256(_stableSerialize(payload)).slice(0, 56)}`;
}

function _buildExternalPayload(input) {
    const eventType = _cleanText(input?.eventType, 40).toUpperCase();
    if (!ALLOWED_EVENT_TYPES.has(eventType)) throw new Error("M365_GRAPH_EVENT_TYPE_INVALID");

    const correlationId = _cleanTraceId(input?.correlationId || input?.traceId);
    const transactionId = _cleanIdentifier(input?.transactionId, 120);
    const bookingReference = _cleanIdentifier(input?.bookingReference, 300);
    if (!transactionId && !bookingReference) throw new Error("M365_GRAPH_REFERENCE_REQUIRED");

    const amount = _cleanAmount(input?.amount);
    const occurredAt = _toIsoDate(input?.occurredAt);
    const currency = _cleanText(input?.currency || "EUR", 3).toUpperCase();
    if (currency !== "EUR") throw new Error("M365_GRAPH_CURRENCY_INVALID");

    const canonical = {
        eventType,
        correlationId,
        transactionId,
        bookingReference,
        amount,
        currency,
        occurredAt,
    };

    return {
        ...canonical,
        title: _cleanText(`${eventType} ${transactionId || bookingReference}`, 200),
        integrityHash: hashSHA256(_stableSerialize(canonical)),
    };
}

function _asLedgerPayload(movement, traceId) {
    return _buildExternalPayload({
        eventType: "LEDGER_MOVEMENT",
        correlationId: traceId || movement?.traceId,
        transactionId: movement?.transactionId,
        bookingReference: movement?.reservaIdVinculada || movement?._id,
        amount: movement?.importeContable,
        currency: "EUR",
        occurredAt: movement?.fechaCreacion || new Date(),
    });
}

async function _loadGraphConfig() {
    const [tenantId, clientId, clientSecret, siteId, listId] = await Promise.all([
        getSecret(SECRETS.M365_GRAPH_TENANT_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_CLIENT_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_CLIENT_SECRET).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_SITE_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_LIST_ID).catch(() => ""),
    ]);

    const config = {
        tenantId: _cleanIdentifier(tenantId, 255),
        clientId: _cleanIdentifier(clientId, 128),
        clientSecret: _cleanText(clientSecret, 2048),
        siteId: _cleanIdentifier(siteId, 300),
        listId: _cleanIdentifier(listId, 300),
    };

    if (!config.tenantId || !config.clientId || !config.clientSecret || !config.siteId || !config.listId) return null;
    return config;
}

async function _acquireGraphToken(config) {
    const body = [
        `client_id=${encodeURIComponent(config.clientId)}`,
        "scope=https%3A%2F%2Fgraph.microsoft.com%2F.default",
        `client_secret=${encodeURIComponent(config.clientSecret)}`,
        "grant_type=client_credentials",
    ].join("&");

    const response = await withTimeout(
        fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        }),
        TIMEOUT_MS,
        "m365GraphToken"
    );

    if (!response?.ok) throw new Error(`M365_GRAPH_TOKEN_${Number(response?.status) || 0}`);
    const data = await response.json().catch(() => null);
    const token = _cleanText(data?.access_token, 8192);
    if (!token) throw new Error("M365_GRAPH_TOKEN_INVALID");
    return token;
}

function _mapErrorCode(error) {
    const message = String(error?.message || "").toUpperCase();
    if (message.includes("AMOUNT") || message.includes("DATE") || message.includes("REFERENCE") || message.includes("EVENT_TYPE") || message.includes("CURRENCY")) return message.slice(0, 80);
    if (message.includes("TOKEN_401") || message.includes("TOKEN_403")) return "M365_GRAPH_AUTH_FAILED";
    if (message.includes("401") || message.includes("403")) return "M365_GRAPH_PERMISSION_DENIED";
    if (message.includes("404")) return "M365_GRAPH_TARGET_NOT_FOUND";
    if (message.includes("429") || message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504") || message.includes("TIMEOUT")) return "M365_GRAPH_TEMPORARY_FAILURE";
    if (message.includes("NOT_CONFIGURED")) return "M365_GRAPH_NOT_CONFIGURED";
    return "M365_GRAPH_SYNC_FAILED";
}

async function _writeSyncLog(status, count, traceId, errorCode = "") {
    const record = {
        _id: `m365-graph-log-${makeTraceId("sync")}`,
        origen: "WIX_LEDGER",
        destino: "M365_GRAPH_SHAREPOINT",
        estado: _cleanText(status, 32),
        cantidadRegistros: Number(count) || 0,
        mensaje: _cleanText(errorCode || traceId, 120),
        meta: { traceId: _cleanTraceId(traceId), errorCode: _cleanText(errorCode, 80) },
        tipo: "M365_GRAPH_SYNC",
        fechaSync: new Date(),
    };
    return wixData.insert(SYNC_LOG_COL, record, { suppressAuth: true });
}

async function _saveQueue(queue, patch) {
    return wixData.update(QUEUE_COL, { ...queue, ...patch, updatedAt: new Date() }, { suppressAuth: true });
}

async function _postListItem(config, token, payload) {
    const endpoint = `${GRAPH_BASE_URL}/sites/${encodeURIComponent(config.siteId)}/lists/${encodeURIComponent(config.listId)}/items`;
    const body = {
        fields: {
            Title: payload.title,
            CorrelationId: payload.correlationId,
            EventType: payload.eventType,
            OccurredAt: payload.occurredAt,
            BookingReference: payload.bookingReference,
            TransactionId: payload.transactionId,
            Amount: payload.amount,
            Currency: payload.currency,
            IntegrityHash: payload.integrityHash,
        },
    };

    const response = await withTimeout(
        fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        }),
        TIMEOUT_MS,
        "m365GraphListItem"
    );

    const status = Number(response?.status) || 0;
    if (status === 409) return { externalRecordId: "", duplicate: true };
    if (!response?.ok) throw new Error(`M365_GRAPH_POST_${status}`);
    const data = await response.json().catch(() => ({}));
    return { externalRecordId: _cleanIdentifier(data?.id, 120), duplicate: false };
}

export async function enqueueM365LedgerRecord(movement, traceId) {
    if (!_isM365Enabled()) {
        return { status: "PAUSED", traceId: _cleanTraceId(traceId), queueId: "" };
    }
    const payload = _asLedgerPayload(movement, traceId);
    const now = new Date();
    const queueId = _queueId(payload);
    const existing = await wixData.get(QUEUE_COL, queueId, { suppressAuth: true }).catch(() => null);
    if (existing) {
        return { status: String(existing.status || "PENDING"), traceId: payload.correlationId, queueId };
    }

    const queue = {
        _id: queueId,
        payload,
        payloadHash: payload.integrityHash,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: now,
        traceId: payload.correlationId,
        errorCode: "",
        externalRecordId: "",
        createdAt: now,
        updatedAt: now,
    };
    await wixData.insert(QUEUE_COL, queue, { suppressAuth: true });
    return { status: "PENDING", traceId: payload.correlationId, queueId };
}

async function _processQueueItem(queue, runTraceId) {
    const traceId = _cleanTraceId(queue?.traceId || runTraceId);
    const lockKey = `m365-graph-sync:${String(queue?._id || "")}`;
    const lockOwnerId = `${runTraceId}:${String(queue?._id || "")}`;
    const lock = await _lockSlotKeyOrFail(lockKey, lockOwnerId, LOCK_TTL_MS);
    if (!lock?.ok) return { status: "SKIPPED" };

    try {
        const payload = _buildExternalPayload(queue?.payload);
        const config = await _loadGraphConfig();
        if (!config) {
            await _saveQueue(queue, { status: "BLOCKED", errorCode: "M365_GRAPH_NOT_CONFIGURED", blockedAt: new Date() });
            await _writeSyncLog("BLOCKED", 0, traceId, "M365_GRAPH_NOT_CONFIGURED").catch(() => null);
            return { status: "BLOCKED" };
        }

        const token = await _acquireGraphToken(config);
        const postResult = await _postListItem(config, token, payload);
        await _saveQueue(queue, {
            status: "COMPLETED",
            errorCode: "",
            externalRecordId: postResult.externalRecordId,
            completedAt: new Date(),
        });
        await _writeSyncLog(postResult.duplicate ? "DUPLICATE" : "SUCCESS", 1, traceId).catch(() => null);
        return { status: "COMPLETED" };
    } catch (error) {
        const attempts = Number(queue?.attempts || 0) + 1;
        const errorCode = _mapErrorCode(error);
        const terminal = attempts >= MAX_ATTEMPTS || errorCode.startsWith("M365_GRAPH_AMOUNT_") || errorCode.startsWith("M365_GRAPH_DATE_") || errorCode === "M365_GRAPH_REFERENCE_REQUIRED" || errorCode === "M365_GRAPH_EVENT_TYPE_INVALID" || errorCode === "M365_GRAPH_CURRENCY_INVALID" || errorCode === "M365_GRAPH_PERMISSION_DENIED" || errorCode === "M365_GRAPH_TARGET_NOT_FOUND";
        await _saveQueue(queue, {
            status: terminal ? "FAILED" : "RETRY",
            attempts,
            errorCode,
            nextAttemptAt: new Date(Date.now() + BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1))),
            ...(terminal ? { failedAt: new Date() } : {}),
        });
        await _writeSyncLog(terminal ? "FAILED" : "RETRY", 0, traceId, errorCode).catch(() => null);
        log.warn("M365 Graph sync deferred or failed", { traceId, attempts, errorCode, terminal });
        return { status: terminal ? "FAILED" : "RETRY" };
    } finally {
        await _unlockSlotKey(lockKey, lockOwnerId).catch(() => null);
    }
}

export async function processM365GraphSyncQueue(options = {}) {
    const traceId = _cleanTraceId(options?.traceId || makeTraceId("cron-m365-graph"));
    if (!_isM365Enabled()) {
        return {
            status: "PAUSED",
            data: { scanned: 0, completed: 0, retried: 0, failed: 0, blocked: 0, skipped: 0 },
            error: null,
        };
    }
    const limit = Math.max(1, Math.min(Number(options?.limit) || BATCH_SIZE, BATCH_SIZE));
    const pending = await wixData.query(QUEUE_COL)
        .in("status", PENDING_STATES)
        .le("nextAttemptAt", new Date())
        .ascending("nextAttemptAt")
        .limit(limit)
        .find({ suppressAuth: true, consistentRead: true });

    const result = { scanned: 0, completed: 0, retried: 0, failed: 0, blocked: 0, skipped: 0 };
    for (const queue of pending?.items || []) {
        result.scanned++;
        const outcome = await _processQueueItem(queue, traceId);
        if (outcome.status === "COMPLETED") result.completed++;
        else if (outcome.status === "RETRY") result.retried++;
        else if (outcome.status === "FAILED") result.failed++;
        else if (outcome.status === "BLOCKED") result.blocked++;
        else result.skipped++;
    }
    return { status: result.failed ? "PARTIAL" : "SUCCESS", data: result, error: null };
}
