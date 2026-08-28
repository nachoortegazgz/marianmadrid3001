/**
 * =============================================================================
 * MODULE: pages/servicio-2.js
 * VERSION: v19.6.15-canonical-duration-context
 * RESPONSIBILITY: Resolve a service from Import2 through the backend and connect
 *                 the custom service widget to canonical catalog and calendar routes.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v19.6.15-canonical-duration-context: Preserves canonical duracionTotal with nullish fallbacks only.
 * - v19.6.14-canonical-widget-service-context: Emits serviceId only; removes the primaryServiceGuid migration alias.
 * - v19.6.10-widget-migration-context: Mirrors canonical serviceId to the active HTML widget migration field until its non-versioned source is replaced.
 * - v19.6.7-ready-only-context: Relies on the bridge READY handshake before context delivery.
 * - v19.6.2-serviceid-linkfases-contract: Uses serviceId and derives F2 only from Import2.linkFases.
 * - v19.4.9: Normalizes the Service 2 presentation contract to Import2 camelCase fields and SSOT visual fallbacks.
 * - v19.4.6: Carries only Import2-validated local add-on IDs to the calendar context.
 * - v19.4.4: Resolves Import2 by slugUrl first and serviceId second.
 *            Validates BOOK/NAV targets before navigation.
 * - v19.4.4: Removes public service aliases and requires serviceId.
 * - v19.4.2: Adopted verified Wix image fallback from reviewed attachment.
 * =============================================================================
 */

import wixLocation from "wix-location";
import wixWindowFrontend from "wix-window-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web";

import {
    MESSAGE_TYPES,
    UI,
    URLS,
    MONEY,
    makeTraceId,
    _normType,
    _safeSlugOrId,
    _safeTrim,
    BOOKINGS_ADDON_CONFIG,
    withTimeout,
    _executeWithRetry,
    _looksLikeGuid,
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";

function _isGuid(value) {
    const clean = String(value || "").trim();
    return clean && _looksLikeGuid(clean) ? clean : "";
}

function _isSlug(value) {
    const clean = _safeSlugOrId(value || "");
    return clean && !_isGuid(clean) ? clean : "";
}

async function _resolveServiceLookup() {
    const query = wixLocation.query || {};
    let appService = {};

    try {
        const pageData = await wixWindowFrontend.getAppPageData();
        appService = pageData?.service || {};
    } catch (error) {
        console.warn("[servicio-2] getAppPageData unavailable", error?.message || String(error));
    }

    const slugCandidates = [
        query.slugUrl,
        query.slug,
        query.serviceKey,
        appService?.supportedSlugs?.[0]?.name,
        appService?.slugUrl,
        appService?.slug,
    ];
    for (const candidate of slugCandidates) {
        const slugUrl = _isSlug(candidate);
        if (slugUrl) return { kind: "SLUG", value: slugUrl };
    }

    const guidCandidates = [
        query.serviceId,
        appService?.id,
        appService?._id,
    ];
    for (const candidate of guidCandidates) {
        const serviceId = _isGuid(candidate);
        if (serviceId) return { kind: "GUID", value: serviceId };
    }

    const path = wixLocation.path || [];
    const pathCandidate = _isSlug(path[path.length - 1] || "");
    const excluded = ["servicios", "service", "servicio", "servicio-2", "pagina-de-servicio-2"];
    if (pathCandidate && !excluded.includes(pathCandidate)) return { kind: "SLUG", value: pathCandidate };

    return null;
}

async function _fetchServiceFromBackend(lookup) {
    if (!lookup?.value) throw new Error("Service lookup is required");

    const result = await _executeWithRetry(
        () => withTimeout(
            getServiceBySlugOrId(lookup.value),
            UI.FRONTEND_API_TIMEOUT_MS,
            `getServiceBySlugOrId:${lookup.kind}`
        ),
        UI.FRONTEND_RETRY_ATTEMPTS,
        UI.FRONTEND_RETRY_BASE_BACKOFF_MS
    );

    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(result?.error?.message || "Service not found in Import2");
    }

    const serviceId = _isGuid(result.data.serviceId);
    const slugUrl = _isSlug(result.data.slugUrl);
    if (!serviceId || !slugUrl) {
        throw new Error("Import2 service is missing serviceId or slugUrl");
    }

    return { ...result.data, serviceId, slugUrl };
}

function _showError(message) {
    console.error("[servicio-2] Error:", message);
    try {
        const banner = $w("#errorBanner") || $w("#errorBox") || $w("#textError") || $w("#errorText");
        if (banner && "text" in banner) {
            banner.text = "Error: " + String(message || "Unknown error");
            if (typeof banner.show === "function") banner.show();
        }
    } catch (_) {
        // Optional page error component can be absent.
    }
}

function _sanitizeRequestedAddonIds(rawAddons, resolvedService) {
    const catalog = Array.isArray(resolvedService?.metadata?.addons) ? resolvedService.metadata.addons : [];
    const allowedIds = new Set(catalog.map((addon) => _safeTrim(addon?.addonId)).filter(Boolean));
    const requestedIds = Array.from(new Set(
        (Array.isArray(rawAddons) ? rawAddons : [])
            .map((addon) => _safeTrim(addon?.addonId || addon))
            .filter((addonId) => allowedIds.has(addonId))
    ));
    return requestedIds.slice(0, BOOKINGS_ADDON_CONFIG.MAX_PER_BOOKING);
}

function _goToCalendar(slugUrl, serviceId, addonIds = []) {
    const canonicalSlugUrl = _isSlug(slugUrl);
    const canonicalGuid = _isGuid(serviceId);
    if (!canonicalSlugUrl || !canonicalGuid) {
        _showError("No se pudo identificar el servicio para continuar la reserva.");
        return;
    }

    const base = URLS.CALENDARIO_2 || "/booking-calendar/calendario-2";
    const addonParam = addonIds.length > 0 ? `&addonIds=${encodeURIComponent(addonIds.join(","))}` : "";
    wixLocation.to(
        `${base}?slugUrl=${encodeURIComponent(canonicalSlugUrl)}` +
        `&serviceId=${encodeURIComponent(canonicalGuid)}` +
        addonParam +
        "&referral=service2"
    );
}

function _goToServices() {
    wixLocation.to(URLS.SERVICIOS || "/reserva-online");
}

function _buildContext(data, traceId) {
    const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
    const tituloServicio = _safeTrim(metadata.tituloServicio || metadata.titulo || "Servicio") || "Servicio";
    const precio = Number(metadata.precio ?? metadata.pricing?.base ?? 0);
    const duracionTotal = Number(metadata.duracionTotal ?? metadata.timing?.estimatedTotal ?? metadata.timing?.totalDuration ?? 30);
    const addons = Array.isArray(metadata.addons) ? metadata.addons : [];
    const imageUrl = _safeTrim(metadata.imageUrl) || UI.DEFAULT_SERVICE_IMAGE_URL;
    const localizacion = _safeTrim(metadata.localizacion) || UI.SALON_LOCATION_LABEL;
    const recomendacionProductoRef = _safeTrim(metadata.recomendacionProductoRef);
    const recomendacionProductoRef2 = _safeTrim(metadata.recomendacionProductoRef2);

    const canonicalServiceId = _isGuid(data.serviceId);

    return {
        ...data,
        traceId,
        serviceId: canonicalServiceId,
        slugUrl: _isSlug(data.slugUrl),
        slug: _isSlug(data.slugUrl),
        permitirCombinar: Boolean(data.permitirCombinar),
        metadata: {
            ...metadata,
            titulo: tituloServicio,
            tituloServicio,
            precio,
            duracionTotal,
            localizacion,
            resumenCorto: _safeTrim(metadata.resumenCorto) || "Marian Madrid",
            descripcionLarga: _safeTrim(metadata.descripcionLarga) || "Detalles no disponibles.",
            recomendacionProductoRef,
            recomendacionProductoRef2,
            addons,
            addonsPrecio: addons.map((addon) => Number(addon?.precio || 0)),
            imageUrl,
            pricing: {
                base: precio,
                currency: metadata.pricing?.currency || MONEY.DISPLAY_CURRENCY,
            },
            timing: {
                estimatedTotal: duracionTotal,
                totalDuration: duracionTotal,
            },
        },
        staffOptions: Array.isArray(data.staffOptions) ? data.staffOptions : [],
        staffDisponible: Array.isArray(data.staffDisponible) ? data.staffDisponible : [],
    };
}

$w.onReady(async function () {
    const traceId = makeTraceId("servicio");
    const widget = $w("#htmlWidgetCustomService");

    if (!widget || typeof widget.postMessage !== "function") {
        _showError("HTML widget not found or incompatible.");
        return;
    }

    const lookup = await _resolveServiceLookup();
    if (!lookup) {
        _showError("No se pudo localizar slugUrl ni serviceId del servicio.");
        return;
    }

    let resolvedService = null;

    createWidgetBridge(widget, {
        slug: lookup.value,
        traceId,
        handshakeTimeoutMs: UI.HANDSHAKE_TIMEOUT_MS,
        contextTimeoutMs: UI.CONTEXT_TIMEOUT_MS,
        onContextReady: async () => {
            resolvedService = await _fetchServiceFromBackend(lookup);
            return _buildContext(resolvedService, traceId);
        },
        onWidgetMessage: async (message) => {
            const type = _normType(message?.type);
            const payload = message?.payload || {};
            const currentSlugUrl = resolvedService?.slugUrl || "";
            const currentServiceId = resolvedService?.serviceId || "";

            if (type === _normType(MESSAGE_TYPES.BOOK)) {
                const addonIds = _sanitizeRequestedAddonIds(payload.addons, resolvedService);
                _goToCalendar(currentSlugUrl, currentServiceId, addonIds);
                return;
            }

            if (type === _normType(MESSAGE_TYPES.NAV)) {
                const target = String(payload.target || "").trim().toUpperCase();
                if (target === "SERVICIOS" || target === "BACK") {
                    _goToServices();
                    return;
                }
                if (target === "CALENDARIO2" || target.includes("CALENDAR")) {
                    _goToCalendar(currentSlugUrl, currentServiceId);
                    return;
                }
                _goToServices();
            }
        },
        onError: (error) => _showError(error?.message || String(error)),
    });
});
