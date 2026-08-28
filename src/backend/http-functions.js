/**
 * =============================================================================
 * MODULE: backend/http-functions.js
 * VERSION: v20.0.0-canonical-integration-contracts
 * RESPONSIBILITY: Public HTTP REST endpoints for external integrations (M365 / Power Automate).
 * HARDENED: Flexible query alias resolution (serviceId/slug/date/diaKey), surface-scoped rate limiting.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-canonical-integration-contracts: Resolves serviceId/slug and date query parameter aliases.
 * - v19.6.2-serviceid-linkfases-contract: Uses serviceId and derives F2 only from Import2.linkFases.
 * - v19.5.1-http-ssot-trace-sanitized: Uses SSOT integration settings and normalizes external trace identifiers.
 * - v19.4.4: Updated availability query contract to require serviceId.
 * - v18.3.4-strict-fine: Header standardized during V2 compliance review.
 * =============================================================================
 */

import wixData from 'wix-data';
import { ok, badRequest, serverError, forbidden } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    withTimeout,
} from "public/mmUtils";
import {
    COLLECTIONS,
    SDK_CONFIG,
} from "backend/internalConfig";
import { SECRETS } from 'backend/mmSecrets';
import { getCertifiedDualSlots, resolveServiceId } from 'backend/reservas.web';
import { logger, normalizeError } from 'backend/booking/bookingCore';
import { successResponse, errorResponse } from 'backend/responseUtils';
import { rateLimiter } from 'backend/security';
import { verifyHMAC, timingSafeEqual } from 'backend/securityEngine';

const log = logger;

const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;
const EXTERNAL_HTTP_CONFIG = SDK_CONFIG?.EXTERNAL_HTTP || {};
const RATE_LIMIT_MAX = Number(EXTERNAL_HTTP_CONFIG.RATE_LIMIT_MAX_REQUESTS) || 20;
const RATE_LIMIT_WINDOW_MS = Number(EXTERNAL_HTTP_CONFIG.RATE_LIMIT_WINDOW_MS) || 5000;
const HMAC_MAX_CLOCK_SKEW_SECONDS = Number(EXTERNAL_HTTP_CONFIG.HMAC_MAX_CLOCK_SKEW_SECONDS) || 60;
const ALLOWED_ORIGINS = Array.isArray(EXTERNAL_HTTP_CONFIG.CORS_ALLOWED_ORIGINS) ? EXTERNAL_HTTP_CONFIG.CORS_ALLOWED_ORIGINS : [];

function _handleError(error, context, traceId) {
    const normalized = normalizeError(error);
    log.error(`Error in ${context}`, { error: normalized.message, traceId });
    return { code: normalized.code, message: normalized.message };
}

function _getHeader(headers, name) {
    if (!headers) return undefined;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
}

function _safeTraceId(value, fallbackPrefix) {
    const raw = _safeTrim(value);
    if (!raw) return makeTraceId(fallbackPrefix);
    const normalized = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    return normalized || makeTraceId(fallbackPrefix);
}

function _extractClientIp(request) {
    const ipRaw =
        _getHeader(request && request.headers, 'x-forwarded-for') ||
        _getHeader(request && request.headers, 'x-real-ip') ||
        'unknown';
    return String(ipRaw).split(',')[0].trim() || 'unknown';
}

function _corsHeaders(request) {
    const origin = _getHeader(request && request.headers, 'origin');
    const isAllowed = origin && ALLOWED_ORIGINS.some((allowed) => String(origin).toLowerCase() === allowed.toLowerCase());
    return {
        ...(isAllowed ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {}),
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, X-Trace-Id, X-HMAC-Signature, X-Timestamp',
        'access-control-max-age': '86400'
    };
}

function _responseHeaders(request, traceId) {
    return {
        'Content-Type': 'application/json',
        Vary: 'Origin',
        'x-trace-id': traceId,
        ..._corsHeaders(request)
    };
}

function _toExternalScheduleItem(item) {
    return {
        resourceId: _safeTrim(item?.resourceId),
        resourceName: _safeTrim(item?.resourceName),
        tipoFichaje: _safeTrim(item?.tipoFichaje || item?.tipo),
        fechaHora: item?.fechaHora || null,
        diaKey: _safeTrim(item?.diaKey),
        mesKey: _safeTrim(item?.mesKey),
    };
}

function _toExternalMovement(item) {
    return {
        movementId: _safeTrim(item?._id),
        documentNumber: _safeTrim(item?.numTicketFactura),
        date: _safeTrim(item?.diaKey),
        createdAt: item?.fechaCreacion || item?._createdDate || null,
        movementType: _safeTrim(item?.tipoMovimiento),
        operationNature: _safeTrim(item?.naturalezaOperacion),
        taxTreatment: _safeTrim(item?.tratamientoIva),
        paymentMethod: _safeTrim(item?.formaPago),
        taxRate: Number(item?.tasaIva) || 0,
        taxableBase: Number(item?.baseImponible) || 0,
        taxAmount: Number(item?.cuotaIva) || 0,
        totalAmount: Number(item?.importeTotal ?? item?.importeContable) || 0,
        correctiveReference: _safeTrim(item?.referenciaRectificativa) || null,
    };
}

async function _logSyncEvent(endpoint, status, recordsCount, traceId) {
    try {
        await withTimeout(
            wixData.insert(
                COLLECTIONS.SYNC_LOG, {
                    _id: makeTraceId('sync'),
                    origen: String(endpoint),
                    destino: 'M365_SHAREPOINT_EXCEL',
                    estado: String(status),
                    cantidadRegistros: Number(recordsCount) || 0,
                    mensaje: String(traceId),
                    meta: { traceId },
                    tipo: 'SYNC_EXECUTION',
                    fechaSync: new Date()
                }, { suppressAuth: true }
            ),
            CMS_TIMEOUT_MS,
            'logSyncEvent'
        );
    } catch (err) {
        log.warn('HTTP: Failed to write to m365SyncLog', { error: err?.message, traceId });
    }
}

async function _authorizeRequest(request, _traceId) {
    const authHeader = _getHeader(request && request.headers, 'authorization');

    if (authHeader && String(authHeader).toLowerCase().startsWith('bearer ')) {
        const token = _safeTrim(String(authHeader).substring(7));
        const expectedToken = await getSecret(SECRETS.POWER_AUTOMATE).catch(() => null);
        if (expectedToken && timingSafeEqual(token, expectedToken)) return { allowed: true };
    }

    const signature = _getHeader(request && request.headers, 'x-hmac-signature');
    const tsHeader = _getHeader(request && request.headers, 'x-timestamp');

    if (signature) {
        const secretKey = await getSecret(SECRETS.POWER_AUTOMATE).catch(() => null);
        if (secretKey) {
            const method = request?.method || 'GET';
            const path = request?.path || '';
            const q = request?.query || {};
            const qs = Object.keys(q)
                .sort()
                .map((k) => `${k}=${encodeURIComponent(String(q[k]))}`)
                .join('&');

            const tsStr = tsHeader ? String(tsHeader).trim() : '';
            if (!tsStr) {
                return { allowed: false, error: 'X-Timestamp header is required for HMAC authentication.' };
            }

            const tsNum = Number(tsStr);
            const nowSec = Math.floor(Date.now() / 1000);
            if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > HMAC_MAX_CLOCK_SKEW_SECONDS) {
                return { allowed: false, error: 'Timestamp expired or clock skew too large.' };
            }

            const payload = `${method}|${path}|${qs}|${tsStr}`;
            if (verifyHMAC(secretKey, payload, signature)) return { allowed: true };
        }
    }

    return { allowed: false, error: 'Unauthorized access. Valid Bearer Token or HMAC signature required.' };
}

export async function options_getAvailability(request) {
    return ok({ headers: _responseHeaders(request, 'preflight') });
}
export async function options_getMovements(request) {
    return ok({ headers: _responseHeaders(request, 'preflight') });
}
export async function options_getZClosings(request) {
    return ok({ headers: _responseHeaders(request, 'preflight') });
}
export async function options_getSchedule(request) {
    return ok({ headers: _responseHeaders(request, 'preflight') });
}

export async function get_getAvailability(request) {
    const traceId = _safeTraceId(_getHeader(request && request.headers, 'x-trace-id'), 'http-avail');
    const ip = _extractClientIp(request);

    try {
        const rate = rateLimiter({ surface: 'http.getAvailability', key: ip }, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) {
            return badRequest({
                body: errorResponse('RATE_LIMIT_EXCEEDED', 'Too many requests', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const auth = await _authorizeRequest(request, traceId);
        if (!auth.allowed) {
            await _logSyncEvent('get_getAvailability', 'ERROR', 0, traceId);
            return forbidden({
                body: errorResponse('UNAUTHORIZED', auth.error, { traceId, meta: { reason: auth.error } }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const query = request?.query || {};
        const serviceIdRaw = _safeTrim(query.serviceId || query.serviceKey || query.slugUrl || query.slug || query.service_id);
        const resourceId = query.resourceId ? _safeTrim(query.resourceId) : null;
        const dateYMD = _safeTrim(query.dateYMD || query.date || query.diaKey);

        if (!serviceIdRaw || !dateYMD || !/^\d{4}-\d{2}-\d{2}$/.test(dateYMD)) {
            return badRequest({
                body: errorResponse('INVALID_PARAMS', 'Missing/invalid serviceId or dateYMD (YYYY-MM-DD)', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const resolvedRes = await resolveServiceId(serviceIdRaw);
        const serviceId = resolvedRes?.status === 'SUCCESS' ? _safeTrim(resolvedRes.data) : null;

        if (!serviceId || !_looksLikeGuid(serviceId)) {
            return badRequest({
                body: errorResponse('INVALID_SERVICE_ID', 'serviceId could not be resolved', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const result = await withTimeout(
            getCertifiedDualSlots(serviceId, resourceId, dateYMD),
            API_TIMEOUT_MS,
            'getCertifiedDualSlots'
        );

        if (!result || result.status === 'ERROR') {
            await _logSyncEvent('get_getAvailability', 'ERROR', 0, traceId);
            return badRequest({
                body: errorResponse(
                    result?.error?.code || 'SLOT_ERROR',
                    result?.error?.message || 'Error al obtener disponibilidad', { traceId }
                ),
                headers: _responseHeaders(request, traceId)
            });
        }

        await _logSyncEvent('get_getAvailability', 'SUCCESS', (result.data || []).length, traceId);

        return ok({
            body: successResponse(result.data || [], { traceId, serviceId, dateYMD }),
            headers: _responseHeaders(request, traceId)
        });
    } catch (error) {
        const normalized = _handleError(error, 'get_getAvailability', traceId);
        await _logSyncEvent('get_getAvailability', 'ERROR', 0, traceId);
        return serverError({
            body: errorResponse(normalized.code || 'INTERNAL_ERROR', normalized.message, { traceId }),
            headers: _responseHeaders(request, traceId)
        });
    }
}

export async function get_getMovements(request) {
    const traceId = _safeTraceId(_getHeader(request && request.headers, 'x-trace-id'), 'http-movs');
    const ip = _extractClientIp(request);

    try {
        const rate = rateLimiter({ surface: 'http.getMovements', key: ip }, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) {
            return badRequest({
                body: errorResponse('RATE_LIMIT_EXCEEDED', 'Too many requests', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const auth = await _authorizeRequest(request, traceId);
        if (!auth.allowed) {
            return forbidden({
                body: errorResponse('UNAUTHORIZED', auth.error, { traceId, meta: { reason: auth.error } }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const date = _safeTrim(request?.query?.date || request?.query?.dateYMD || request?.query?.diaKey);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return badRequest({
                body: errorResponse('INVALID_PARAMS', 'Parameter "date" (YYYY-MM-DD) is required', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const res = await withTimeout(
            wixData
            .query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq('diaKey', date)
            .ascending('fechaCreacion')
            .limit(1000)
            .find({ suppressAuth: true }),
            CMS_TIMEOUT_MS,
            'queryMovimientos'
        );

        const items = (res?.items || []).map(_toExternalMovement);
        await _logSyncEvent('get_getMovements', 'SUCCESS', items.length, traceId);

        return ok({
            body: successResponse(items, { traceId, date, count: items.length }),
            headers: _responseHeaders(request, traceId)
        });
    } catch (error) {
        const normalized = _handleError(error, 'get_getMovements', traceId);
        return serverError({
            body: errorResponse(normalized.code || 'INTERNAL_ERROR', normalized.message, { traceId }),
            headers: _responseHeaders(request, traceId)
        });
    }
}

export async function get_getZClosings(request) {
    const traceId = _safeTraceId(_getHeader(request && request.headers, 'x-trace-id'), 'http-zclos');
    const ip = _extractClientIp(request);

    try {
        const rate = rateLimiter({ surface: 'http.getZClosings', key: ip }, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) {
            return badRequest({
                body: errorResponse('RATE_LIMIT_EXCEEDED', 'Too many requests', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const auth = await _authorizeRequest(request, traceId);
        if (!auth.allowed) {
            return forbidden({
                body: errorResponse('UNAUTHORIZED', auth.error, { traceId, meta: { reason: auth.error } }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const date = _safeTrim(request?.query?.date || request?.query?.dateYMD || request?.query?.diaKey);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return badRequest({
                body: errorResponse('INVALID_PARAMS', 'Parameter "date" (YYYY-MM-DD) is required', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const res = await withTimeout(
            wixData.query(COLLECTIONS.HISTORICO_CIERRES_Z).eq('diaKey', date).limit(10).find({ suppressAuth: true }),
            API_TIMEOUT_MS,
            'queryCierresZ'
        );

        const items = res?.items || [];
        await _logSyncEvent('get_getZClosings', 'SUCCESS', items.length, traceId);

        return ok({
            body: successResponse(items, { traceId, date, count: items.length }),
            headers: _responseHeaders(request, traceId)
        });
    } catch (error) {
        const normalized = _handleError(error, 'get_getZClosings', traceId);
        return serverError({
            body: errorResponse(normalized.code || 'INTERNAL_ERROR', normalized.message, { traceId }),
            headers: _responseHeaders(request, traceId)
        });
    }
}

export async function get_getSchedule(request) {
    const traceId = _safeTraceId(_getHeader(request && request.headers, 'x-trace-id'), 'http-hours');
    const ip = _extractClientIp(request);

    try {
        const rate = rateLimiter({ surface: 'http.getSchedule', key: ip }, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) {
            return badRequest({
                body: errorResponse('RATE_LIMIT_EXCEEDED', 'Too many requests', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const auth = await _authorizeRequest(request, traceId);
        if (!auth.allowed) {
            return forbidden({
                body: errorResponse('UNAUTHORIZED', auth.error, { traceId, meta: { reason: auth.error } }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const date = _safeTrim(request?.query?.date || request?.query?.dateYMD || request?.query?.diaKey);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return badRequest({
                body: errorResponse('INVALID_PARAMS', 'Parameter "date" (YYYY-MM-DD) is required', { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const res = await withTimeout(
            wixData
            .query(COLLECTIONS.REGISTRO_HORARIO)
            .eq('diaKey', date)
            .ascending('fechaHora')
            .limit(1000)
            .find({ suppressAuth: true }),
            CMS_TIMEOUT_MS,
            'queryHorario'
        );

        const items = (res?.items || []).map(_toExternalScheduleItem);
        await _logSyncEvent('get_getSchedule', 'SUCCESS', items.length, traceId);

        return ok({
            body: successResponse(items, { traceId, date, count: items.length }),
            headers: _responseHeaders(request, traceId)
        });
    } catch (error) {
        const normalized = _handleError(error, 'get_getSchedule', traceId);
        return serverError({
            body: errorResponse(normalized.code || 'INTERNAL_ERROR', normalized.message, { traceId }),
            headers: _responseHeaders(request, traceId)
        });
    }
}

import { getQuarterlyTaxSummary } from "backend/fiscalAggregator.web";

export async function options_getTaxSummary(request) {
    return ok({ headers: _responseHeaders(request, "preflight") });
}

export async function get_getTaxSummary(request) {
    const traceId = _safeTraceId(_getHeader(request && request.headers, "x-trace-id"), "http-tax");
    const ip = _extractClientIp(request);

    try {
        const rate = rateLimiter({ surface: "http.getTaxSummary", key: ip }, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) {
            return badRequest({
                body: errorResponse("RATE_LIMIT_EXCEEDED", "Too many requests", { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const auth = await _authorizeRequest(request, traceId);
        if (!auth.allowed) {
            return forbidden({
                body: errorResponse("UNAUTHORIZED", auth.error, { traceId, meta: { reason: auth.error } }),
                headers: _responseHeaders(request, traceId)
            });
        }

        const year = Number(request?.query?.year) || new Date().getFullYear();
        const quarter = Number(request?.query?.quarter) || Math.floor((new Date().getMonth() + 3) / 3);

        const result = await getQuarterlyTaxSummary(year, quarter, { traceId });
        if (result.status === "ERROR") {
            return badRequest({
                body: errorResponse(result.error?.code || "TAX_ERROR", result.error?.message, { traceId }),
                headers: _responseHeaders(request, traceId)
            });
        }

        return ok({
            body: successResponse(result.data, { traceId, year, quarter }),
            headers: _responseHeaders(request, traceId)
        });
    } catch (error) {
        const normalized = _handleError(error, "get_getTaxSummary", traceId);
        return serverError({
            body: errorResponse(normalized.code || "INTERNAL_ERROR", normalized.message, { traceId }),
            headers: _responseHeaders(request, traceId)
        });
    }
}