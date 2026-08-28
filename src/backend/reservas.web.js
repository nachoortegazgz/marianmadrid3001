/**
 * =============================================================================
 * MODULE: backend/reservas.web.js
 * VERSION: v20.0.0-canonical-service-id-cache-alignment
 * RESPONSIBILITY: Availability engine, dual slots with gap, dual pairing with
 * same staff, workload-balanced staff allocation (minutes/day),
 * cache management, and service resolution.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * NOTES:
 * - No dependency on STAFF/findStaff from public code.
 * - Wix Bookings slot resources are authoritative for runtime staff availability.
 * - Staff display names resolved from backend MAPA_STAFF with bounded cache only after selection.
 * - Gap is MIN (>=) using Import2.tiempoExposicion (minutes).
 * HISTORIAL:
 * - v20.0.0-canonical-service-id-cache-alignment: Populates both serviceId and phaseOneServiceId
 *   in DualSlotCache to prevent alias query misses, and hardens slugOrId extraction.
 * - v20.0.0-optimized-batch-addons: Optimizes addon resolution with batch query (hasSome)
 *   to eliminate N+1 latency, and reuses shared utilities from mmUtils.js and responseUtils.js.
 * - v19.6.15-sdk-mutable-location-payload: Creates a fresh mutable location
 *   object for every Time Slots V2 request; SDK request mappers may normalize IDs.
 * - v19.6.14-editorial-reference-resolution: Resolves partial Wix Data references by option _id before validating native add-on bindings.
 * - v19.6.13-editorial-addon-options: Resolves selectable add-ons from ServiciosOpcionesAddon; Import2 no longer carries add-on objects.
 * - v19.6.12-dual-same-visit-hardening: Rejects dual pairs that cross the Madrid day boundary and requires staff resolution to preserve the exact certified F2 start.
 * - v19.6.10-native-addon-guid-contract: Restores strict support for native add-on GUID strings found in the live Import2 contract.
 * - v19.6.9-canonical-import2-contract: Removes legacy CSV aliases and requires camelCase Import2 fields plus native add-on objects.
 * - v19.6.8-current-bookings-sdk: Uses the current @wix/bookings SDK package for Time Slots V2 operations.
 * - v19.6.4-addon-id-contract: Preserves Import2 native addon GUID strings for Time Slots V2 rechecks.
 * - v19.6.3-prioritized-reliability-refactor: Removes duplicated catalog and slot paths, restores Codegem fixes, and hardens persistence.
 * - v19.6.2-serviceid-linkfases-contract: Uses serviceId and derives F2 only from Import2.linkFases.
 * - v19.6.1-same-day-dual-pairing: Limits all dual F2 searches to the requested Madrid day and removes the unused public next-slot wrapper.
 * - v19.5.9-native-addon-recheck: Uses List Availability Time Slots for native add-on rechecks and keeps Get Availability Time Slot free of unsupported customerChoices.
 * - v19.5.8-revalidation-diagnostics: Logs protected Time Slots V2 rejection context with traceId, location, local bounds, and no client PII.
 * - v19.5.7-clean-resource-contract: Removes inert F1 resolver parameters, bounds the staff display cache, and filters balancing reads by candidate resource IDs.
 * - v19.5.6-native-resource-decoupling: Removes Secrets-based resourceId resolution from Import2 mapping; native slots remain operational authority.
 * - v19.5.5-native-slot-resource-authority: Derives candidate resourceIds from revalidated Time Slots V2 data and always requests staff resource details.
 * - v19.5.4-time-slots-location-context: Uses the Time Slots V2 BUSINESS enum from the SSOT location context.
 * - v19.5.1-staff-presentation-audit: Returns backend-resolved staff display labels with authorized service resource IDs.
 * - v19.5.0-dual-route-and-balance: Enforces Import2 dual routing and tests ranked eligible staff before rejecting a dual pair.
 * - v19.4.9: Projects Import2 service presentation through camelCase metadata for Service 2 and Calendar 2.
 * - v19.4.7: Rejects malformed Madrid day values before constructing Time Slots V2 local bounds.
 * - v19.4.6: Resolves opt-in native add-ons from Import2 and uses their IDs in Time Slots V2 availability.
 * - v19.4.5: Removes the unused public staff catalog web method with an undefined internal dependency.
 * - v19.4.4: Import2 mapping supports canonical field IDs and verified CSV headings; removed the deprecated staff SDK dependency.
 * - v19.3.1: Replaced remaining Madrid timezone literals with SDK_CONFIG.TZ SSOT.
 * - v19.3.0: Added exact Time Slots V2 recheck and SSOT timezone.
 * - v19.2.2-v3-v2-sdk2-dual-gap-balance-hours: Corrected status list filtering for workload balance.
 * - v19.2.1-v3-v2-sdk2-dual-gap-balance-hours: Header standardized during V2 compliance review.
 * =============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { availabilityTimeSlots } from "@wix/bookings";

import {
    BOOKINGS_ADDON_CONFIG,
    STAFF_DEFAULT_NAME,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _executeWithRetry,
    _hashKey,
    _generateUUID,
    _normalizeSlotShape,
    withTimeout,
} from "public/mmUtils";
import {
    COLLECTIONS,
    SDK_CONFIG,
    RATE_LIMIT,
    SLOT_SEARCH,
    API,
    SERVICE_CATALOG,
} from "backend/internalConfig";

import { logger } from "backend/booking/bookingCore";
import { _toPublicError } from "backend/responseUtils";
import { findStaff } from "backend/staff";
import { requireAdmin, rateLimiter } from "backend/security";

const log = logger;

const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CITA;
const EXTRAS_CATALOGO_COL = COLLECTIONS.EXTRAS_CATALOGO;
const DUAL_CACHE_COL = COLLECTIONS.DUAL_CACHE;
const DAYS_CACHE_COL = COLLECTIONS.DAYS_CACHE;
const CITAS_COL = COLLECTIONS.CITAS;

const WATCHDOG_TIMEOUT_MS = SDK_CONFIG.TIMEOUTS.WATCHDOG_MS;

const SERVICE_CACHE_TTL_MS = SDK_CONFIG.CACHE.SERVICES_TTL_MS;
const SLOTS_CACHE_TTL_MS = SDK_CONFIG.CACHE.SLOTS_CACHE_TTL_MS;
const DUAL_CACHE_TTL_MS = SDK_CONFIG.CACHE.DUAL_CACHE_TTL_MS;

const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const DIAS_LIMITE = SLOT_SEARCH.DIAS_LIMITE;

const CACHE_MAX_SIZE = SDK_CONFIG.CACHE.MAX_ENTRIES;
const DAYS_CACHE_VERSION = SDK_CONFIG.CACHE.DAYS_CACHE_VERSION;

function _newTimeSlotsLocation() {
    return {
        id: SDK_CONFIG.LOCATION_ID,
        locationType: SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS,
    };
}

// In-memory caches
const availabilityCache = new Map(); // cacheKey -> { data, timestamp }
const inflightRequests = new Map(); // cacheKey -> Promise
const serviceCatalogRAM = new Map(); // key -> { data, timestamp }
const serviceAddonOptionsRAM = new Map(); // optionId -> { data, timestamp }

// -----------------------------------------------------------------------------
// Staff display cache (backend only, no emails)
// -----------------------------------------------------------------------------
const STAFF_CACHE_TTL_MS = SDK_CONFIG.CACHE.STAFF_TTL_MS;
const STAFF_DISPLAY_CACHE_MAX_ENTRIES = SDK_CONFIG.CACHE.MAX_ENTRIES;
const staffDisplayCache = new Map(); // rid -> { name, ts }

async function _getStaffDisplayName(resourceId) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return "";

    const cached = staffDisplayCache.get(resourceIdClean);
    if (cached && Date.now() - cached.ts < STAFF_CACHE_TTL_MS) return cached.name || "";

    const staff = await findStaff(resourceIdClean).catch(() => null);
    const name = _safeTrim(staff?.displayName || staff?.name || "");

    _cacheSetBounded(staffDisplayCache, resourceIdClean, { name, ts: Date.now() }, STAFF_DISPLAY_CACHE_MAX_ENTRIES);
    return name;
}

// -----------------------------------------------------------------------------
// Bounded cache eviction (LRU-ish)
// -----------------------------------------------------------------------------
function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= maxSize) return;
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error("RATE_LIMITED");
        e.code = "RATE_LIMITED";
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

function _availabilityRequesterKey(requesterId, resourceKey) {
    const cleanRequester = _safeTrim(requesterId).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96);
    return cleanRequester.length >= 12 ? `requester:${cleanRequester}` : `resource:${resourceKey}`;
}

function _rateLimitPublicAvailability(surface, requesterId, resourceKey, traceId) {
    const windowMs = Number(RATE_LIMIT?.AVAILABILITY_WINDOW_MS) || 5000;
    const requesterLimit = Number(RATE_LIMIT?.AVAILABILITY_REQUESTER_MAX_REQUESTS) || 12;
    const globalLimit = Number(RATE_LIMIT?.AVAILABILITY_GLOBAL_MAX_REQUESTS) || 120;
    const global = rateLimiter({ surface: `${surface}:global`, key: "all" }, globalLimit, windowMs);
    if (!global.allowed) {
        const error = new Error("RATE_LIMITED");
        error.code = "RATE_LIMITED";
        error.meta = { retryAfter: global.retryAfter, surface, traceId };
        throw error;
    }

    const requester = rateLimiter({ surface: `${surface}:requester`, key: _availabilityRequesterKey(requesterId, resourceKey) },
        requesterLimit,
        windowMs
    );
    if (!requester.allowed) {
        const error = new Error("RATE_LIMITED");
        error.code = "RATE_LIMITED";
        error.meta = { retryAfter: requester.retryAfter, surface, traceId };
        throw error;
    }
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const s = _normalizeSlotShape(slot);
    if (!s) return null;

    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", { traceId, ctx, serviceId });
        return null;
    }

    return {
        ...s,
        serviceId,
        ...(s.slot && typeof s.slot === "object" ? { slot: { ...s.slot, serviceId } } : {}),
    };
}

function _isValidMadridYmd(value) {
    const ymd = _safeTrim(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function _addDaysYMD(ymd, days) {
    if (!_isValidMadridYmd(ymd)) return "";
    const parts = String(ymd).split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
}

function _filterDaysByLimit(daysArray) {
    if (!Array.isArray(daysArray) || daysArray.length === 0) return [];
    const tz = SDK_CONFIG.TZ;
    const now = new Date();
    const todayStr = now.toLocaleDateString("sv-SE", { timeZone: tz });
    const tomorrowStr = _addDaysYMD(todayStr, 1);
    const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
    if (!tomorrowStr || !maxDateStr) return [];
    return daysArray.filter((date) => date >= tomorrowStr && date <= maxDateStr);
}

// Wix Bookings owns runtime resource availability. Import2 never authorizes a resourceId.
function _normalizeResourceIds(resourceId, traceId) {
    if (!resourceId) return [];

    const normalized = _safeTrim(resourceId);
    if (!normalized || ["all", "any"].includes(normalized.toLowerCase())) return [];
    if (_looksLikeGuid(normalized)) return [normalized];

    log.warn("_normalizeResourceIds: non-guid identifier not supported; treating as ANY", { resourceId: normalized, traceId });
    return [];
}

function _getResourceIdsFromSlot(slot) {
    const s = _normalizeSlotShape(slot);
    if (!s || typeof s !== "object") return [];

    let groups = [];
    if (Array.isArray(s.availableResources)) groups = s.availableResources;
    else if (s.slot && typeof s.slot === "object" && Array.isArray(s.slot.availableResources)) groups = s.slot.availableResources;
    else if (s.resourceId) return _looksLikeGuid(String(s.resourceId)) ? [String(s.resourceId)] : [];
    else if (s.resource?.id) return _looksLikeGuid(String(s.resource.id)) ? [String(s.resource.id)] : [];

    const staffGroup = groups.find((g) => String(g.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID));
    if (!staffGroup) return [];

    return Array.from(new Set(
        (staffGroup.resources || [])
        .map((resource) => _safeTrim(resource?.id || resource?._id))
        .filter((resourceId) => _looksLikeGuid(resourceId))
    ));
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    const ms = b.getTime() - a.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.round(ms / 60000);
}

// =============================================================================
// SERVICE MAPPING (Import2 -> UX)
// =============================================================================
function _readImport2Field(service, fieldId) {
    if (!service || typeof service !== "object") return undefined;
    return service[fieldId];
}

function _readCatalogReferenceId(value) {
    const candidate = value && typeof value === "object" ? (value._id || value.id) : value;
    return _safeTrim(candidate).toUpperCase();
}

function _formatEditorialAddonItem(option) {
    if (!option || typeof option !== "object") return null;
    const addonId = _safeTrim(option.bookingsAddonId);
    const groupId = _safeTrim(option.bookingsAddonGroupId);
    if (!_looksLikeGuid(addonId) || !_looksLikeGuid(groupId) || option.activo !== true) return null;

    const precioAddon = Number(option.precioAddon);
    const cantidadMaximaAddon = Number(option.cantidadMaximaAddon);
    return {
        addonId,
        nombre: _safeTrim(option.tituloAddon) || "Complemento",
        precio: Number.isFinite(precioAddon) && precioAddon >= 0 ? precioAddon : 0,
        bookingsAddonId: addonId,
        bookingsAddonGroupId: groupId,
        cantidadMaximaAddon: Number.isInteger(cantidadMaximaAddon) && cantidadMaximaAddon > 0 ? cantidadMaximaAddon : 1,
    };
}

async function _resolveEditorialAddons(rawOptions, traceId) {
    const refs = Array.isArray(rawOptions) ? rawOptions : [];
    if (!refs.length) return [];

    const resolved = [];
    const missingIds = [];
    const now = Date.now();

    for (const optionRef of refs) {
        const optionId = _safeTrim(typeof optionRef === "object" ? optionRef?._id : optionRef);
        if (!optionId) continue;

        const cached = serviceAddonOptionsRAM.get(optionId);
        if (cached && now - cached.timestamp < SERVICE_CACHE_TTL_MS) {
            if (cached.data) resolved.push(cached.data);
            continue;
        }

        const hasNativeBinding = optionRef && typeof optionRef === "object" &&
            (_safeTrim(optionRef.bookingsAddonId) || _safeTrim(optionRef.bookingsAddonGroupId));
        if (hasNativeBinding) {
            const formatted = _formatEditorialAddonItem(optionRef);
            if (formatted) {
                _cacheSetBounded(serviceAddonOptionsRAM, optionId, { data: formatted, timestamp: now }, CACHE_MAX_SIZE);
                resolved.push(formatted);
            }
            continue;
        }

        missingIds.push(optionId);
    }

    if (missingIds.length > 0) {
        const uniqueMissing = Array.from(new Set(missingIds));
        try {
            const batchRes = await withTimeout(
                wixData.query(EXTRAS_CATALOGO_COL).hasSome("_id", uniqueMissing).limit(100).find({ suppressAuth: true }),
                WATCHDOG_TIMEOUT_MS,
                "resolveEditorialAddons:batch"
            );

            const itemsMap = new Map((batchRes?.items || []).map((it) => [String(it._id), it]));

            for (const optionId of uniqueMissing) {
                const item = itemsMap.get(optionId);
                const formatted = item ? _formatEditorialAddonItem(item) : null;
                _cacheSetBounded(serviceAddonOptionsRAM, optionId, { data: formatted, timestamp: now }, CACHE_MAX_SIZE);
                if (formatted) resolved.push(formatted);
                else log.warn("Editorial addon option is not natively bookable", { optionId, traceId });
            }
        } catch (err) {
            log.error("Batch query for addons failed", { traceId, message: err?.message });
        }
    }

    return resolved;
}

function _resolveAddonContext(service, requestedAddonIds) {
    const requestedIds = Array.from(new Set(
        (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
        .map((id) => _safeTrim(id))
        .filter(Boolean)
    ));

    if (requestedIds.length > BOOKINGS_ADDON_CONFIG.MAX_PER_BOOKING) {
        throw new Error("ADDON_LIMIT_EXCEEDED");
    }

    const catalog = Array.isArray(service?.metadata?.addons) ? service.metadata.addons : [];
    const catalogById = new Map(catalog.map((addon) => [_safeTrim(addon?.addonId), addon]).filter(([addonId]) => Boolean(addonId)));
    const unknownAddonId = requestedIds.find((addonId) => !catalogById.has(addonId));
    if (unknownAddonId) throw new Error("ADDON_INVALID");

    const selectedAddons = requestedIds.map((addonId) => catalogById.get(addonId));
    const nativeAddonIds = [];

    for (const addon of selectedAddons) {
        const nativeId = _safeTrim(addon?.bookingsAddonId);
        if (!nativeId) continue;
        if (!_looksLikeGuid(nativeId)) throw new Error("NATIVE_ADDON_INVALID");
        nativeAddonIds.push(nativeId);
    }

    return {
        selectedAddons,
        nativeAddonIds: Array.from(new Set(nativeAddonIds)).sort(),
    };
}

async function _mapServiceImport2ToUX(service, traceId) {
    const serviceId = _safeTrim(_readImport2Field(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("Import2 invalid: serviceId missing or not a GUID");
    }

    const rawOculto = _readImport2Field(service, "oculto");
    const estado = _readCatalogReferenceId(_readImport2Field(service, "estado"));
    if (estado && estado !== "ACTIVO") {
        throw new Error("Service is not available for public booking.");
    }
    const categoria = _readCatalogReferenceId(_readImport2Field(service, "categoria"));
    const monedaCatalogo = _readCatalogReferenceId(
        _readImport2Field(service, "monedaCatalogo") || _readImport2Field(service, "moneda")
    );
    const moneda = monedaCatalogo || SERVICE_CATALOG.CURRENCY;
    const isHiddenF2 = rawOculto === true;
    const rawPermitir = _readImport2Field(service, "permitirCombinar");
    const permitirCombinar = !isHiddenF2 && rawPermitir === true;
    const linkFases = _safeTrim(_readImport2Field(service, "linkFases"));

    if (permitirCombinar && !_looksLikeGuid(linkFases)) {
        throw new Error("Import2 invalid: linkFases missing or not a GUID for dual service");
    }

    const tiempoFase1 = Number(_readImport2Field(service, "tiempoFase1")) || 0;
    const tiempoExposicion = Number(_readImport2Field(service, "tiempoExposicion")) || 0;
    const tiempoFase2 = Number(_readImport2Field(service, "tiempoFase2")) || 0;
    const duracionTotal = Number(_readImport2Field(service, "duracionTotal")) || 0;

    const tituloServicio = _safeTrim(_readImport2Field(service, "tituloServicio")) || "Servicio";
    const precio = Number(_readImport2Field(service, "precio")) || 0;
    const slugUrl = _safeTrim(_readImport2Field(service, "slugUrl")) || null;
    const imageUrl = _safeTrim(_readImport2Field(service, "imagenPrincipal")) || "";
    const localizacion = _safeTrim(_readImport2Field(service, "localizacion")) || null;
    const resumenCorto = _safeTrim(_readImport2Field(service, "resumenCorto")) || null;
    const descripcionLarga = _safeTrim(_readImport2Field(service, "descripcionLarga")) || null;
    const recomendacionProductoRef = _safeTrim(_readImport2Field(service, "recomendacionProductoRef")) || null;
    const recomendacionProductoRef2 = _safeTrim(_readImport2Field(service, "recomendacionProductoRef2")) || null;

    const estimatedTotal =
        duracionTotal ||
        (permitirCombinar ? tiempoFase1 + tiempoExposicion + tiempoFase2 : tiempoFase1) ||
        30;

    // Import2 staff fields are optional UI hints only. Runtime availability comes from Wix Bookings slots.
    const staffDisponible = [];
    const staffOptions = [];
    const rawAddonRefs = _readImport2Field(service, "addonsOptions") || _readImport2Field(service, "addonOptions") || [];
    const addons = await _resolveEditorialAddons(rawAddonRefs, traceId);

    return {
        slugUrl,
        serviceId,
        linkFases: permitirCombinar ? linkFases : null,
        permitirCombinar,
        tiempoFase1,
        tiempoExposicion,
        tiempoFase2,
        duracionTotal,
        staffDisponible,
        staffOptions,
        metadata: {
            titulo: tituloServicio,
            tituloServicio,
            precio,
            moneda,
            categoria: SERVICE_CATALOG.CATEGORIES.includes(categoria) ? categoria : null,
            duracionTotal: estimatedTotal,
            localizacion,
            resumenCorto,
            descripcionLarga,
            recomendacionProductoRef,
            recomendacionProductoRef2,
            addons,
            addonsPrecio: addons.map((addon) => Number(addon?.precio || 0)),
            imageUrl,
            pricing: { base: precio, currency: moneda },
            timing: { estimatedTotal, totalDuration: estimatedTotal },
        },
    };
}

// =============================================================================
// INTERNAL SERVICE RESOLVER
// =============================================================================
function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    const { linkFases, ...publicService } = service;
    return publicService;
}

async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
    const traceId = externalTraceId || makeTraceId("service");

    const rawCandidate = typeof slugOrId === "object" && slugOrId !== null ?
        (slugOrId.serviceId || slugOrId.slugUrl || slugOrId.slug || slugOrId.id || "") :
        slugOrId;
    const raw = _safeTrim(rawCandidate);
    const isGuid = _looksLikeGuid(raw);
    const clean = isGuid ? raw : _safeSlugOrId(raw);

    if (!clean) {
        return { status: "ERROR", data: null, error: { code: "SLUG_MISSING", message: "Slug o ID de servicio requerido." } };
    }

    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
        return { status: "SUCCESS", data: cached.data, error: null };
    }

    try {
        let service = null;

        if (isGuid) {
            const result = await withTimeout(
                wixData.query(SERVICIOS_COL).limit(1).eq("serviceId", clean).find({ suppressAuth: true }),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:serviceId"
            );
            service = result?.items?.[0] || null;
        } else {
            const result = await withTimeout(
                wixData.query(SERVICIOS_COL).limit(1).eq("slugUrl", clean).find({ suppressAuth: true }),
                WATCHDOG_TIMEOUT_MS,
                "getServiceBySlugOrId:slugUrl"
            );
            service = result?.items?.[0] || null;
        }

        if (!service) {
            log.error("Service not found in Import2", { key: clean, traceId });
            return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: `Servicio "${slugOrId}" no encontrado.` } };
        }

        const mapped = await _mapServiceImport2ToUX(service, traceId);

        _cacheSetBounded(serviceCatalogRAM, clean, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
        if (mapped.serviceId) _cacheSetBounded(serviceCatalogRAM, mapped.serviceId, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
        if (mapped.slugUrl) _cacheSetBounded(serviceCatalogRAM, mapped.slugUrl, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);

        return { status: "SUCCESS", data: mapped, error: null };
    } catch (e) {
        log.error("Error in getServiceBySlugOrId", { error: e?.message, traceId });
        return { status: "ERROR", data: null, error: { code: "DATABASE_ERROR", message: e?.message || "Error al consultar la base de datos." } };
    }
}

async function _resolveServiceIdInternal(serviceIdReq) {
    const raw = _safeTrim(serviceIdReq);
    if (!raw) return null;
    if (_looksLikeGuid(raw)) return raw;

    const normalized = _safeSlugOrId(raw);
    if (!normalized) return null;

    const res = await _getServiceBySlugOrIdInternal(normalized);
    if (res?.status === "SUCCESS" && res?.data?.serviceId) {
        const sid = _safeTrim(res.data.serviceId);
        if (sid && _looksLikeGuid(sid)) return sid;
    }

    return null;
}

// =============================================================================
// BOOKINGS V2: EXACT SLOT RECHECK
// =============================================================================
export async function revalidateExactAvailabilitySlot({ serviceId, localStartDate, localEndDate, resourceId, nativeAddonIds = [], traceId }) {
    const activeTraceId = traceId || makeTraceId("exact-slot");
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    const start = _normalizeLocalIsoStr(localStartDate);
    const end = _normalizeLocalIsoStr(localEndDate);
    const requiredResourceId = _safeTrim(resourceId);

    if (!resolvedServiceId || !start || !end) {
        return { status: "ERROR", data: null, error: { code: "INVALID_SLOT_RECHECK", message: "Selected slot data is invalid." } };
    }

    try {
        const normalizedNativeAddonIds = Array.from(new Set(
            (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
            .map((id) => _safeTrim(id))
            .filter((id) => _looksLikeGuid(id))
        )).sort();
        let rawSlot = null;

        if (normalizedNativeAddonIds.length > 0) {
            const listPayload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: start,
                toLocalDate: end,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_newTimeSlotsLocation()],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
                customerChoices: { addOnIds: normalizedNativeAddonIds },
            };

            if (requiredResourceId) {
                listPayload.resourceTypes = [{
                    resourceTypeId: STAFF_RESOURCE_TYPE_ID,
                    resourceIds: [requiredResourceId],
                }];
            }

            const listed = await _executeWithRetry(
                () => withTimeout(
                    availabilityTimeSlots.listAvailabilityTimeSlots(listPayload),
                    WATCHDOG_TIMEOUT_MS,
                    "listAvailabilityTimeSlots:addonRecheck"
                ),
                2,
                300
            );

            rawSlot = (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find((slot) =>
                _normalizeLocalIsoStr(slot?.localStartDate || slot?.startDate) === start &&
                _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate) === end &&
                slot?.bookable === true
            ) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: _newTimeSlotsLocation(),
                timeZone: SDK_CONFIG.TZ,
            };

            if (requiredResourceId) {
                getPayload.resourceTypes = [{
                    resourceTypeId: STAFF_RESOURCE_TYPE_ID,
                    resourceIds: [requiredResourceId],
                }];
            }

            const result = await _executeWithRetry(
                () => withTimeout(
                    availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
                    WATCHDOG_TIMEOUT_MS,
                    "getAvailabilityTimeSlot"
                ),
                2,
                300
            );
            rawSlot = result?.timeSlot || null;
        }
        const normalized = _attachServiceId(rawSlot, resolvedServiceId, activeTraceId, "revalidateExactAvailabilitySlot");
        const availableResourceIds = _getResourceIdsFromSlot(normalized);

        if (!normalized || normalized.bookable !== true) {
            return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "Selected slot is no longer available." } };
        }

        if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
            return { status: "ERROR", data: null, error: { code: "STAFF_UNAVAILABLE", message: "Selected staff is no longer available for this slot." } };
        }

        return {
            status: "SUCCESS",
            data: {
                slot: {
                    ...normalized,
                    localStartDate: start,
                    localEndDate: end,
                },
                resourceId: requiredResourceId || (availableResourceIds.length === 1 ? availableResourceIds[0] : null),
                candidateResourceIds: availableResourceIds,
            },
            error: null,
        };
    } catch (error) {
        const httpStatus = Number(error?.httpStatus || error?.statusCode || error?.response?.status || 0) || null;
        const wixErrorCode = _safeTrim(error?.code || error?.details?.applicationError?.code) || "UNKNOWN";
        const requestedAddonCount = Array.isArray(nativeAddonIds) ? nativeAddonIds.length : 0;

        log.warn("Exact slot recheck failed", {
            traceId: activeTraceId,
            wixErrorCode,
            httpStatus,
            message: error?.message || String(error),
            serviceId: String(resolvedServiceId),
            localStartDate: start,
            localEndDate: end,
            locationId: SDK_CONFIG.LOCATION_ID,
            locationType: SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS,
            requestedAddonCount,
            hasRequiredResource: Boolean(requiredResourceId),
        });

        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SLOT_UNAVAILABLE",
                message: "Selected slot could not be revalidated.",
                traceId: activeTraceId,
            },
        };
    }
}

// =============================================================================
// BOOKINGS V2: LIST TIME SLOTS
// =============================================================================
async function _listTimeSlotsV2({ serviceId, fromLocalDate, toLocalDate, resourceIds, nativeAddonIds = [] }, options = {}) {
    const { skipCache = false, timeSlotsPerDay } = options;

    const traceId = makeTraceId("slots");
    const fromKey = _normalizeLocalIsoStr(fromLocalDate);
    const toKey = _normalizeLocalIsoStr(toLocalDate);
    if (!fromKey || !toKey) return [];

    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) return [];

    const normalizedResourceIds = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
    const normalizedNativeAddonIds = Array.from(new Set(
        (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
        .map((id) => _safeTrim(id))
        .filter((id) => _looksLikeGuid(id))
    )).sort();
    const resourceKey = normalizedResourceIds.slice().sort().join(",");
    const addonKey = normalizedNativeAddonIds.join(",");

    const cacheKey = `${String(resolvedServiceId)}__${resourceKey}__${addonKey}__${fromKey}__${toKey}__ts:${timeSlotsPerDay || 0}`;

    if (!skipCache) {
        const cached = availabilityCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < SLOTS_CACHE_TTL_MS) return cached.data;

        const inflight = inflightRequests.get(cacheKey);
        if (inflight) return inflight;
    }

    const p = (async () => {
        try {
            const resourceTypes = normalizedResourceIds.length ? [{ resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: normalizedResourceIds }] : [];

            const payload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: String(fromKey),
                toLocalDate: String(toKey),
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_newTimeSlotsLocation()],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
            };

            if (resourceTypes.length) payload.resourceTypes = resourceTypes;
            if (normalizedNativeAddonIds.length > 0) payload.customerChoices = { addOnIds: normalizedNativeAddonIds };
            if (Number.isFinite(timeSlotsPerDay) && Number(timeSlotsPerDay) > 0) payload.timeSlotsPerDay = Number(timeSlotsPerDay);

            const data = await _executeWithRetry(
                () =>
                withTimeout(
                    availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                    WATCHDOG_TIMEOUT_MS,
                    "listAvailabilityTimeSlots"
                ),
                3,
                500
            );

            const rawSlots = Array.isArray(data?.timeSlots) ? data.timeSlots : [];

            const slots = rawSlots
                .map((s) => {
                    if (!s) return null;
                    const start = s.localStartDate || s.startDate || "";
                    const end = s.localEndDate || s.endDate || "";
                    const fixed = _attachServiceId(s, resolvedServiceId, traceId, "_listTimeSlotsV2");
                    if (!fixed) return null;
                    return { ...fixed, localStartDate: String(start), localEndDate: String(end) };
                })
                .filter((s) => s && s.localStartDate);

            if (!skipCache) _cacheSetBounded(availabilityCache, cacheKey, { data: slots, timestamp: Date.now() }, CACHE_MAX_SIZE);
            return slots;
        } catch (e) {
            log.error("_listTimeSlotsV2 failed", { traceId, message: e?.message });
            return [];
        }
    })();

    if (!skipCache) {
        inflightRequests.set(cacheKey, p);
        try {
            return await p;
        } finally {
            inflightRequests.delete(cacheKey);
        }
    }

    return await p;
}

// =============================================================================
// BALANCING: least minutes booked today (CitasF2) for candidate staff
// =============================================================================
async function _getBookedMinutesByResourceForDay(dateYMD, resourceIds, _traceId) {
    const ymd = String(dateYMD || "").slice(0, 10);
    const ids = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
    if (!ymd || ids.length === 0) return {};

    const q = wixData
        .query(CITAS_COL)
        .eq("fechaYmdMadrid", ymd)
        .in("status", ["CONFIRMED", "PENDING_PAYMENT"])
        .in("resourceId", ids)
        .limit(1000);

    const res = await withTimeout(q.find({ suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "balance:queryCitas").catch(() => null);
    const items = Array.isArray(res?.items) ? res.items : [];

    const minutes = {};
    ids.forEach((rid) => (minutes[rid] = 0));

    for (const it of items) {
        const rid = String(it?.resourceId || "").trim();
        if (!rid || minutes[rid] === undefined) continue;

        const start = it?.startDate ? new Date(it.startDate) : null;
        const end = it?.endDate ? new Date(it.endDate) : null;
        if (!(start instanceof Date) || isNaN(start.getTime())) continue;
        if (!(end instanceof Date) || isNaN(end.getTime())) continue;

        minutes[rid] += _minutesBetweenUtcDates(start, end);
    }

    return minutes;
}

async function _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId) {
    const ids = Array.from(new Set(
        Array.isArray(candidateResourceIds) ? candidateResourceIds.map(String).filter(Boolean) : []
    ));
    if (ids.length <= 1) return ids;

    const minutesMap = await _getBookedMinutesByResourceForDay(dateYMD, ids, traceId).catch(() => ({}));

    const names = {};
    await Promise.allSettled(
        ids.map(async (rid) => {
            names[rid] = (await _getStaffDisplayName(rid).catch(() => "")) || "";
        })
    );

    return ids.sort((a, b) => {
        const ma = Number(minutesMap[a] || 0);
        const mb = Number(minutesMap[b] || 0);
        if (ma !== mb) return ma - mb;
        const na = String(names[a] || a);
        const nb = String(names[b] || b);
        return na.localeCompare(nb);
    });
}

async function _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) {
    const ranked = await _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId);
    return ranked[0] || null;
}

// =============================================================================
// NEXT SLOT: first slot >= fromLocalDateTime (optionally require staff)
// =============================================================================
async function _findNextSlotForServiceInternal(serviceId, fromLocalDateTime, requiredResourceId, traceId, sameDayOnly = false) {
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };

    const fromLocal = _normalizeLocalIsoStr(fromLocalDateTime);
    if (!fromLocal) return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "fromLocalDateTime invalid" } };

    const startYMD = fromLocal.slice(0, 10);

    const mustHaveStaff = _looksLikeGuid(requiredResourceId);
    const resourceIds = mustHaveStaff ? _normalizeResourceIds(requiredResourceId, traceId) : [];

    const maxDayOffset = sameDayOnly ? 0 : DIAS_LIMITE;
    for (let i = 0; i <= maxDayOffset; i++) {
        const ymd = _addDaysYMD(startYMD, i);
        const dayFrom = i === 0 ? fromLocal : `${ymd}T00:00:00`;
        const dayTo = `${ymd}T23:59:59`;

        const slots = await _listTimeSlotsV2({ serviceId: resolvedServiceId, fromLocalDate: dayFrom, toLocalDate: dayTo, resourceIds }, { skipCache: true });

        const normFrom = _normalizeLocalIsoStr(dayFrom);

        const candidates = (slots || [])
            .filter((s) => _normalizeLocalIsoStr(s.localStartDate) >= normFrom)
            .sort((a, b) => String(a.localStartDate).localeCompare(String(b.localStartDate)));

        if (!candidates.length) continue;

        if (mustHaveStaff) {
            const required = String(requiredResourceId);
            const match = candidates.find((s) => _getResourceIdsFromSlot(s).includes(required));
            if (match) return { status: "SUCCESS", data: { slot: match, dayYMD: ymd }, error: null };
            continue;
        }

        return { status: "SUCCESS", data: { slot: candidates[0], dayYMD: ymd }, error: null };
    }

    return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "No available slot found in search window." } };
}

// =============================================================================
// DUAL SLOTS: pairing with gap + same staff + balance by booked minutes
// =============================================================================
export async function _cleanExpiredDualSlotsInternal({ limit = 100, traceId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const now = new Date();
    const result = await withTimeout(
        wixData.query(DUAL_CACHE_COL).lt('expiresAt', now).limit(safeLimit).find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        'cleanExpiredDualSlotsQuery'
    );
    let removed = 0;
    for (const item of result?.items || []) {
        await withTimeout(
            wixData.remove(DUAL_CACHE_COL, item._id, { suppressAuth: true }),
            WATCHDOG_TIMEOUT_MS,
            'cleanExpiredDualSlotsRemove'
        );
        removed += 1;
    }
    log.info('Expired dual cache entries cleaned', { removed, traceId });
    return { status: 'SUCCESS', data: { removed }, error: null };
}

export async function _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, requestedAddonIds = []) {
    const traceId = makeTraceId("dual");

    if (!serviceId || !_isValidMadridYmd(dateYMD)) {
        return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "serviceId and valid Madrid dateYMD are required" } };
    }

    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) {
        return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };
    }

    const serviceRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, traceId);
    if (!serviceRes || serviceRes.status !== "SUCCESS" || !serviceRes.data) {
        return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service catalog missing" } };
    }

    const service = serviceRes.data;
    const addonContext = _resolveAddonContext(service, requestedAddonIds);

    const linkedServiceId = service.linkFases || null;
    const isDual = service.permitirCombinar && !!linkedServiceId;

    const resourceIdsFilter = _normalizeResourceIds(resourceId, traceId);
    const rankedCandidateCache = new Map();

    async function _rankCandidates(candidateResourceIds) {
        const normalized = Array.from(new Set((candidateResourceIds || []).map(String).filter(Boolean)));
        const key = normalized.slice().sort().join("|");
        if (!key) return [];
        if (rankedCandidateCache.has(key)) return rankedCandidateCache.get(key);
        const ranked = await _rankResourcesByLoad(normalized, dateYMD, traceId);
        rankedCandidateCache.set(key, ranked);
        return ranked;
    }

    const fromLocalDate = `${dateYMD}T00:00:00`;
    const toLocalDate = `${dateYMD}T23:59:59`;

    const slotsF1 = await _listTimeSlotsV2({
        serviceId: resolvedServiceId,
        fromLocalDate,
        toLocalDate,
        resourceIds: resourceIdsFilter,
        nativeAddonIds: addonContext.nativeAddonIds,
    }, { skipCache: true });

    if (!isDual) {
        const out = [];
        for (const s1 of slotsF1 || []) {
            const candidateResourceIds = _getResourceIdsFromSlot(s1);

            const rankedCandidates = await _rankCandidates(candidateResourceIds);
            const chosen = rankedCandidates[0] || null;
            const pairToken = _generateUUID();
            const forcedSlot = _attachServiceId({ ...s1 }, resolvedServiceId, traceId, "single");
            if (!forcedSlot) continue;

            out.push({
                fase1: { slotRef: forcedSlot, resourceId: chosen || null },
                fase2: null,
                uiPairToken: pairToken,
                pairToken,
                candidateResourceIds,
                serviceId: resolvedServiceId,
                dateYMD,
            });
        }
        return { status: "SUCCESS", data: out, error: null };
    }

    const exposureMs = Math.max(0, Number(service.tiempoExposicion || 0)) * 60 * 1000;

    const pairs = [];

    for (const s1 of slotsF1 || []) {
        const s1EndLocal = _normalizeLocalIsoStr(s1.localEndDate);
        if (!s1EndLocal) continue;

        const s1EndUtc = getUtcDateFromMadridLocal(s1EndLocal);
        if (!s1EndUtc) continue;

        const earliestF2Utc = new Date(s1EndUtc.getTime() + exposureMs);
        const earliestF2Local = getMadridLocalStringNoZ(earliestF2Utc);
        if (earliestF2Local.slice(0, 10) !== dateYMD) continue;

        const candidateResourceIds = _getResourceIdsFromSlot(s1);

        if (!candidateResourceIds.length) continue;

        const rankedCandidates = await _rankCandidates(candidateResourceIds);
        let chosenResourceId = null;
        let s2 = null;

        for (const candidateResourceId of rankedCandidates) {
            const nextF2 = await _findNextSlotForServiceInternal(
                linkedServiceId,
                earliestF2Local,
                candidateResourceId,
                traceId,
                true
            );
            if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot || nextF2.data.dayYMD !== dateYMD) continue;

            const candidateF2 = nextF2.data.slot;
            const s2Staff = _getResourceIdsFromSlot(candidateF2);
            if (s2Staff.length > 0 && !s2Staff.includes(String(candidateResourceId))) continue;

            chosenResourceId = candidateResourceId;
            s2 = candidateF2;
            break;
        }

        if (!chosenResourceId || !s2) continue;

        const pairToken = _generateUUID();

        const forcedF1 = _attachServiceId({ ...s1 }, resolvedServiceId, traceId, "dual:F1");
        const forcedF2 = _attachServiceId({ ...s2 }, linkedServiceId, traceId, "dual:F2");
        if (!forcedF1 || !forcedF2) continue;

        pairs.push({
            fase1: { slotRef: forcedF1, resourceId: chosenResourceId },
            fase2: { slotRef: forcedF2, resourceId: chosenResourceId },
            uiPairToken: pairToken,
            pairToken,
            candidateResourceIds,
            serviceId: resolvedServiceId,
            dateYMD,
            earliestF2Local,
        });
    }

    // Cache dual tokens (best-effort)
    if (pairs.length > 0) {
        const cachePromises = pairs.map((slotPair) => {
            const pairToken = slotPair.uiPairToken;
            const expiresAt = new Date(Date.now() + DUAL_CACHE_TTL_MS);

            const record = {
                _id: pairToken,
                pairToken,
                serviceId: String(slotPair.serviceId),
                slotF1: slotPair.fase1?.slotRef || null,
                slotF2: slotPair.fase2?.slotRef || null,
                resourceId: slotPair.fase1?.resourceId || null,
                candidateResourceIds: slotPair.candidateResourceIds || [],
                phaseOneServiceId: String(slotPair.serviceId),
                phaseTwoServiceId: String(linkedServiceId),
                dateYMD: String(dateYMD),
                expiresAt,
                createdAt: new Date(),
                status: "ACTIVE",
            };

            return wixData.save(DUAL_CACHE_COL, record, { suppressAuth: true }).catch(() => null);
        });

        await Promise.allSettled(cachePromises);
    }

    return { status: "SUCCESS", data: pairs, error: null };
}

// =============================================================================
// CACHE INVALIDATION (INTERNAL + ADMIN WEB METHOD)
// =============================================================================
export async function _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId = null) {
    const tId = traceId || makeTraceId("invalidate");

    const resolvedServiceId = (await _resolveServiceIdInternal(serviceId)) || _safeTrim(serviceId);
    const ymd = _safeTrim(dateYMD);
    if (!resolvedServiceId || !_isValidMadridYmd(ymd)) return { ok: true, traceId: tId, skipped: true };

    const prefix = `${String(resolvedServiceId)}__`;
    for (const k of availabilityCache.keys()) {
        if (String(k).startsWith(prefix)) availabilityCache.delete(k);
    }

    const yearMonth = String(ymd).slice(0, 7);
    const resourceIds = _normalizeResourceIds(resourceId, tId).sort().join(",");
    const daysCacheId = `${DAYS_CACHE_VERSION}__${String(resolvedServiceId)}__${_hashKey(resourceIds)}__${String(yearMonth)}`;

    try {
        await withTimeout(
            wixData.remove(DAYS_CACHE_COL, daysCacheId, { suppressAuth: true }),
            WATCHDOG_TIMEOUT_MS,
            "invalidateDaysCache"
        );
    } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.includes("WDE0073") && !msg.includes("does not exist") && !msg.includes("WD_ITEM_DOES_NOT_EXIST")) {
            throw e;
        }
    }

    try {
        const res = await withTimeout(
            wixData.query(DUAL_CACHE_COL).eq("phaseOneServiceId", String(resolvedServiceId)).eq("dateYMD", String(ymd)).limit(100).find({ suppressAuth: true }),
            WATCHDOG_TIMEOUT_MS,
            "invalidateDualCacheQuery"
        );

        await Promise.allSettled(
            (res?.items || []).map((it) => wixData.remove(DUAL_CACHE_COL, it._id, { suppressAuth: true }).catch(() => null))
        );
    } catch (e) {
        log.warn("_invalidateCachesInternal: dual cache cleanup failed (best-effort)", { traceId: tId, message: e?.message });
    }

    return { ok: true, traceId: tId };
}

export const invalidateCachesInternal = webMethod(Permissions.Admin, async (serviceId, dateYMD, resourceId) => {
    const traceId = makeTraceId("wm-invalidate-internal");
    try {
        _rateLimitOrThrow("reservas.invalidateCachesInternal", "admin", traceId);
        await requireAdmin(traceId);
        const res = await _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId);
        return { status: "SUCCESS", data: res, error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "INVALIDATE_FAILED") };
    }
});

// =============================================================================
// PUBLIC WEB METHODS
// =============================================================================
export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return await _getServiceBySlugOrIdInternal(serviceId, traceId || makeTraceId("service-internal"));
}

export const getServiceBySlugOrId = webMethod(Permissions.Anyone, async (slugOrId) => {
    const traceId = makeTraceId("wm-svc");
    try {
        _rateLimitOrThrow("reservas.getServiceBySlugOrId", _safeTrim(slugOrId) || "anon", traceId);
        const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
        return result?.status === "SUCCESS" ? { status: "SUCCESS", data: _toPublicService(result.data), error: null } :
            result;
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "SERVICE_LOOKUP_FAILED") };
    }
});

export const resolveServiceId = webMethod(Permissions.Anyone, async (serviceIdReq) => {
    const traceId = makeTraceId("wm-svc-resolve");
    try {
        _rateLimitOrThrow("reservas.resolveServiceId", _safeTrim(serviceIdReq) || "anon", traceId);
        const resolved = await _resolveServiceIdInternal(serviceIdReq);
        if (!resolved) {
            return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Identificador de servicio no encontrado." } };
        }
        return { status: "SUCCESS", data: String(resolved), error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "SERVICE_RESOLVE_FAILED") };
    }
});

export const getAvailableDays = webMethod(Permissions.Anyone, async (serviceId, resourceId, year, month, addonIds = [], requesterId = "") => {
    const traceId = makeTraceId("wm-days");
    try {
        _rateLimitPublicAvailability(
            "reservas.getAvailableDays",
            requesterId,
            `${_safeTrim(serviceId)}|${String(year)}|${String(month)}`,
            traceId
        );

        const resolved = await _resolveServiceIdInternal(serviceId);
        if (!resolved) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };

        const svcRes = await _getServiceBySlugOrIdInternal(resolved, traceId);
        const service = svcRes?.data;
        if (!service) return { status: "ERROR", data: null, error: { code: "SERVICE_CONFIG_MISSING", message: "Service configuration missing" } };
        const addonContext = _resolveAddonContext(service, addonIds);
        const resourceIds = _normalizeResourceIds(resourceId, traceId);

        const y = Number(year);
        const m = Number(month);
        if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Invalid year/month" } };
        }

        const yearMonth = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;

        const tz = SDK_CONFIG.TZ;
        const now = new Date();
        const todayStr = now.toLocaleDateString("sv-SE", { timeZone: tz });

        const tomorrowStr = _addDaysYMD(todayStr, 1);
        const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);

        const firstDay = `${yearMonth}-01`;
        const lastDayNum = new Date(y, m, 0).getDate();
        const lastDay = `${yearMonth}-${String(lastDayNum).padStart(2, "0")}`;

        const fromLocal = tomorrowStr > firstDay ? tomorrowStr : firstDay;
        const toLocal = maxDateStr < lastDay ? maxDateStr : lastDay;

        if (fromLocal > toLocal) return { status: "SUCCESS", data: [], error: null };

        const slots = await _listTimeSlotsV2({
            serviceId: resolved,
            fromLocalDate: `${fromLocal}T00:00:00`,
            toLocalDate: `${toLocal}T23:59:59`,
            resourceIds,
            nativeAddonIds: addonContext.nativeAddonIds,
        }, { skipCache: true, timeSlotsPerDay: 1 });

        const dateSet = new Set();
        slots.forEach((s) => {
            if (s.localStartDate) dateSet.add(String(s.localStartDate).slice(0, 10));
        });

        return { status: "SUCCESS", data: _filterDaysByLimit(Array.from(dateSet).sort()), error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "DAYS_QUERY_FAILED") };
    }
});

export const getCertifiedDualSlots = webMethod(Permissions.Anyone, async (serviceId, resourceId, dateYMD, addonIds = [], requesterId = "") => {
    const traceId = makeTraceId("wm-dual");
    try {
        _rateLimitPublicAvailability(
            "reservas.getCertifiedDualSlots",
            requesterId,
            `${_safeTrim(serviceId)}|${_safeTrim(dateYMD)}`,
            traceId
        );
        return await _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, addonIds);
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "DUAL_SLOTS_FAILED") };
    }
});

export const resolveStaffForSlot = webMethod(Permissions.Anyone, async (serviceId, start1, rId, addonIds = [], dualContext = null) => {
    const traceId = makeTraceId("wm-staff");
    try {
        _rateLimitOrThrow("reservas.resolveStaffForSlot", `${_safeTrim(serviceId)}|${_safeTrim(start1)}`, traceId);

        const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
        if (!resolvedServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };

        const svcRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, traceId);
        const serviceCfg = svcRes?.data;
        if (!serviceCfg) return { status: "ERROR", data: null, error: { code: "SERVICE_CONFIG_MISSING", message: "Service not in catalog" } };

        const addonContext = _resolveAddonContext(serviceCfg, addonIds);
        const dateYMD = String(start1).slice(0, 10);
        const isAnyStaff = !rId || ["all", "any"].includes(String(rId).trim().toLowerCase());

        // 1. Get F1 candidates
        const slotsF1 = await _listTimeSlotsV2({
            serviceId: resolvedServiceId,
            fromLocalDate: `${dateYMD}T00:00:00`,
            toLocalDate: `${dateYMD}T23:59:59`,
            resourceIds: isAnyStaff ? [] : _normalizeResourceIds(rId, traceId),
            nativeAddonIds: addonContext.nativeAddonIds,
        }, { skipCache: true });

        const slotF1Raw = (slotsF1 || []).find(
            (s) => _normalizeLocalIsoStr(s.localStartDate) === _normalizeLocalIsoStr(start1)
        );
        if (!slotF1Raw) return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "F1 slot is no longer available." } };

        const slotF1 = _attachServiceId(slotF1Raw, resolvedServiceId, traceId, "resolveStaff:F1Norm");
        let candidateResourceIds = _getResourceIdsFromSlot(slotF1);

        // 2. For a dual service, F2 is derived only from Import2.linkFases.
        const linkedServiceId = serviceCfg.permitirCombinar ? _safeTrim(serviceCfg.linkFases) : "";
        let slotF2 = null;
        if (linkedServiceId) {
            if (!dualContext?.start2) {
                return { status: "ERROR", data: null, error: { code: "F2_SLOT_REQUIRED", message: "Dual service requires the certified F2 slot." } };
            }
            const requestedF2Start = _normalizeLocalIsoStr(dualContext.start2);
            if (!requestedF2Start || requestedF2Start.slice(0, 10) !== dateYMD) {
                return { status: "ERROR", data: null, error: { code: "F2_DIFFERENT_DAY", message: "F2 must occur on the same Madrid day as F1." } };
            }
            const nextF2 = await _findNextSlotForServiceInternal(
                linkedServiceId,
                requestedF2Start,
                isAnyStaff ? null : _safeTrim(rId),
                traceId,
                true
            );
            if (
                nextF2?.status !== "SUCCESS" ||
                !nextF2?.data?.slot ||
                nextF2.data.dayYMD !== dateYMD ||
                _normalizeLocalIsoStr(nextF2.data.slot.localStartDate) !== requestedF2Start
            ) {
                return { status: "ERROR", data: null, error: { code: "F2_UNAVAILABLE", message: "F2 slot is no longer available." } };
            }
            slotF2 = nextF2.data.slot;
            const candidatesF2 = _getResourceIdsFromSlot(slotF2);
            candidateResourceIds = candidateResourceIds.filter(id => candidatesF2.includes(id));
        } else if (dualContext?.start2) {
            return { status: "ERROR", data: null, error: { code: "UNEXPECTED_F2_CONTEXT", message: "Simple service cannot include F2 context." } };
        }

        if (!candidateResourceIds.length) {
            return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "No staff available for this combined slot." } };
        }

        const requestedResourceId = isAnyStaff ? "" : _safeTrim(rId);
        if (requestedResourceId && !candidateResourceIds.includes(requestedResourceId)) {
            return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "Selected staff is not available for this combined slot." } };
        }

        const finalResourceId = isAnyStaff ?
            await _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) :
            requestedResourceId;

        if (!finalResourceId) return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "No staff could be assigned." } };

        const finalResourceName = (await _getStaffDisplayName(finalResourceId)) || STAFF_DEFAULT_NAME;

        return {
            status: "SUCCESS",
            data: {
                slotF1: _attachServiceId(slotF1, resolvedServiceId, traceId, "resolveStaff:F1"),
                slotF2: slotF2 ? _attachServiceId(slotF2, linkedServiceId, traceId, "resolveStaff:F2") : null,
                resourceId: finalResourceId,
                resourceName: finalResourceName,
                dayYMD: dateYMD,
            },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "STAFF_RESOLVE_FAILED") };
    }
});