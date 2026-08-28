/**
 * =============================================================================
 * MODULE: pages/calendario-2.js
 * VERSION: v20.0.0-canonical-calendar-payload
 * RESPONSIBILITY: Interactive calendar page script aligned 100% with the custom
 * HTML widget (#html1). Handles availability, dual slots,
 * booking saga orchestration, and lightbox confirmation.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-canonical-calendar-payload: Emits canonical metadata image fallbacks and supports uiPairToken from nested metaCita or top-level payload.
 * - v19.6.7-ready-only-context: Waits for the HTML widget READY handshake before context delivery.
 * - v19.6.4-calendar-slugurl-contract: Resolves the canonical slugUrl query parameter before generic route fallbacks.
 * - v19.6.2-serviceid-linkfases-contract: Uses serviceId and derives F2 only from Import2.linkFases.
 * - v19.6.1-avail-action-contract: Echoes explicit days or slots action in availability responses and removes unreachable duplicate NAV handling.
 * - v19.5.2: Provides SSOT timezone/currency, canonical booking presentation values, and an enumerated privacy navigation target.
 * - v19.5.1: Uses backend-resolved staff labels in the professional selector and selection feedback.
 * - v19.4.9: Delivers the camelCase Import2 presentation context with SSOT image and location fallbacks.
 * - v19.4.7: Handles only enumerated widget NAV targets and builds routes from canonical service state.
 * - v19.4.6: Propagates selected Import2 add-on IDs for availability calculated by Bookings V2.
 * - v19.4.5: Removes calls to undefined staff helpers and relies on saga-confirmed staff data.
 * - v19.4.4: Removed getStaffCatalog and public service aliases; Import2 is staff SSOT and metadata.titulo is guaranteed.
 * - v19.4.1: Added canonical serviceId query fallback from reviewed version.
 * - v19.3.2: Resolve the Wix Bookings service from App Page Data before URL fallbacks.
 * - v19.2.0-v3-aligned-bookingsv2: Header standardized during V2 compliance review.
 * =============================================================================
 */

import wixLocation from "wix-location";
import wixWindowFrontend from "wix-window-frontend";

import {
    getAvailableDays,
    getCertifiedDualSlots,
    getServiceBySlugOrId,
} from "backend/reservas.web";

import { processDualBooking } from "backend/citasManager.web";

import {
    MESSAGE_TYPES,
    UI,
    URLS,
    MONEY,
    SDK_CONFIG,
    STAFF_DEFAULT_NAME,
    makeTraceId,
    _safeSlugOrId,
    _safeTrim,
    withTimeout,
    _executeWithRetry,
    _looksLikeGuid,
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";

let serviceId = null;
let currentServiceSlugUrl = null;
let staffDisplayByResourceId = new Map();
let currentServicePresentation = null;
const availabilityRequesterId = makeTraceId("availability-session");

function _retry(promiseFactory, label) {
    return _executeWithRetry(
        () => withTimeout(promiseFactory(), UI.FRONTEND_API_TIMEOUT_MS, label),
        UI.FRONTEND_RETRY_ATTEMPTS,
        UI.FRONTEND_RETRY_BASE_BACKOFF_MS, { retryUncertainOutcome: true },
    );
}

function _getRequestedAddonIdsFromQuery() {
    const raw = String((wixLocation.query || {}).addonIds || "");
    return Array.from(new Set(raw.split(",").map((id) => _safeTrim(id)).filter(Boolean)));
}

async function _resolveServiceKey() {
    try {
        const pageData = await wixWindowFrontend.getAppPageData();
        const service = pageData?.service || {};
        const appServiceId = _safeSlugOrId(service.id || service._id || "");
        if (appServiceId) return appServiceId;

        const appSlug = _safeSlugOrId(
            service?.supportedSlugs?.[0]?.name || service?.slug || service?.slugUrl || ""
        );
        if (appSlug) return appSlug;
    } catch (error) {
        console.warn("[calendario-2] getAppPageData unavailable", error?.message || String(error));
    }

    const q = wixLocation.query || {};
    const serviceId = _safeSlugOrId(q.serviceId || "");
    if (serviceId) return serviceId;

    const slugUrl = _safeSlugOrId(q.slugUrl || "");
    if (slugUrl) return slugUrl;

    const serviceKey = _safeSlugOrId(q.serviceKey || "");
    if (serviceKey) return serviceKey;

    const slug = _safeSlugOrId(q.slug || "");
    if (slug) return slug;

    const path = wixLocation.path || [];
    const lastSegment = path[path.length - 1] || "";
    const pathKey = _safeSlugOrId(lastSegment);
    const pageRoutes = ["calendario-de-reservas-2", "calendario-2", "calendario", "booking-calendar", "servicios", "service"];
    return pathKey && !pageRoutes.includes(String(pathKey).toLowerCase()) ? pathKey : "";
}

function _showError(msg) {
    try {
        const el = $w("#errorText");
        if (el && "text" in el) {
            el.text = msg ? `Error: ${msg}` : "";
            if (msg && typeof el.show === "function") el.show();
            if (!msg && typeof el.hide === "function") el.hide();
        }
    } catch (_) {}
}

function _withAvailabilityRequestSequence(result, requestSequence, action) {
    return {
        ...(result || {}),
        action: String(action || ""),
        requestSequence: Number(requestSequence) || 0,
    };
}

function _sumAddons(addons) {
    if (!Array.isArray(addons)) return 0;
    return addons.reduce((acc, a) => acc + Number(a && a.precio ? a.precio : 0), 0);
}

$w.onReady(async function () {
    const traceId = makeTraceId("cal2");

    const widget = $w("#html1");
    if (!widget || typeof widget.postMessage !== "function") {
        _showError("No se encontro #html1 o no es compatible.");
        return;
    }

    const serviceKey = await _resolveServiceKey();
    if (!serviceKey) {
        _showError("Falta el identificador del servicio en la URL.");
        return;
    }

    createWidgetBridge(widget, {
        slug: serviceKey,
        traceId,

        onContextReady: async () => {
            const res = await _retry(() => getServiceBySlugOrId(serviceKey), "getServiceBySlugOrId").catch(() => null);
            if (!res || res.status !== "SUCCESS" || !res.data) {
                throw new Error((res && res.error && res.error.message) || "Servicio no encontrado");
            }

            const guid = String(res.data.serviceId || "").trim();
            if (!guid || !_looksLikeGuid(guid)) {
                throw new Error("serviceId invalido en el catalogo");
            }

            serviceId = guid;
            currentServiceSlugUrl = _safeSlugOrId(res.data.slugUrl || "") || null;

            const metadata = res.data.metadata || {};
            const allowedAddonIds = new Set(
                (Array.isArray(metadata.addons) ? metadata.addons : [])
                .map((addon) => _safeTrim(addon?.addonId || addon?.id))
                .filter(Boolean)
            );
            const preselectedAddonIds = _getRequestedAddonIdsFromQuery().filter((addonId) => allowedAddonIds.has(addonId));
            const tituloServicio = _safeTrim(metadata.tituloServicio || metadata.titulo || "Servicio") || "Servicio";
            const precio = Number(metadata.precio ?? metadata.pricing?.base ?? 0);
            const duracionTotal = Number(metadata.duracionTotal ?? metadata.timing?.estimatedTotal ?? metadata.timing?.totalDuration ?? 30);
            const addons = Array.isArray(metadata.addons) ? metadata.addons : [];
            const staffOptionsFromBackend = Array.isArray(res.data.staffOptions) ? res.data.staffOptions : [];
            const staffOptions = staffOptionsFromBackend
                .map((option) => ({
                    id: _safeTrim(option?.id || option?.value),
                    value: _safeTrim(option?.value || option?.id),
                    name: _safeTrim(option?.name || option?.label) || STAFF_DEFAULT_NAME,
                    label: _safeTrim(option?.label || option?.name) || STAFF_DEFAULT_NAME,
                }))
                .filter((option) => _looksLikeGuid(option.id));
            staffDisplayByResourceId = new Map(staffOptions.map((option) => [option.id, option.name]));

            const fallbackImage = UI?.DEFAULT_SERVICE_IMAGE_URL || "https://static.wixstatic.com/media/ab7708_374e5f7adb2f47f3944f3355da129b80~mv2.jpg";
            const imageUrl = _safeTrim(metadata.imageUrl || metadata.imagenPrincipal) || fallbackImage;

            currentServicePresentation = {
                tituloServicio,
                precio,
                moneda: MONEY.DISPLAY_CURRENCY,
                imageUrl,
                addons: addons.map((addon) => ({
                    addonId: _safeTrim(addon?.addonId || addon?.id),
                    id: _safeTrim(addon?.addonId || addon?.id),
                    nombre: _safeTrim(addon?.nombre) || "Complemento",
                    precio: Number(addon?.precio || 0),
                })).filter((addon) => addon.addonId),
            };

            return {
                ...res.data,
                serviceId: guid,
                metadata: {
                    ...metadata,
                    titulo: tituloServicio,
                    tituloServicio,
                    precio,
                    duracionTotal,
                    localizacion: _safeTrim(metadata.localizacion) || UI.SALON_LOCATION_LABEL,
                    resumenCorto: _safeTrim(metadata.resumenCorto) || "Marian Madrid",
                    descripcionLarga: _safeTrim(metadata.descripcionLarga) || "Detalles no disponibles.",
                    recomendacionProductoRef: _safeTrim(metadata.recomendacionProductoRef),
                    recomendacionProductoRef2: _safeTrim(metadata.recomendacionProductoRef2),
                    addons: currentServicePresentation.addons,
                    addonsPrecio: currentServicePresentation.addons.map((addon) => Number(addon?.precio || 0)),
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
                staffOptions,
                preselectedAddonIds,
                timeZone: SDK_CONFIG.TZ,
                currencyCode: MONEY.DISPLAY_CURRENCY,
            };
        },

        onWidgetMessage: async (msg, post) => {
            const type = msg && msg.type ? String(msg.type).toUpperCase() : "";
            const messageId = msg && msg.messageId;

            // -------------------------
            // Navigation
            // -------------------------
            if (type === String(MESSAGE_TYPES.NAV).toUpperCase()) {
                const target = String(msg?.payload?.target || "").trim().toUpperCase();
                if (target === "SERVICIOS" || target === "BACK") {
                    wixLocation.to(URLS.SERVICIOS || "/reserva-online");
                    return;
                }
                if (target === "SERVICE2") {
                    const base = URLS.DETALLE_SERVICIO || "/servicio-2";
                    const serviceParam = currentServiceSlugUrl ?
                        `slugUrl=${encodeURIComponent(currentServiceSlugUrl)}` :
                        `serviceId=${encodeURIComponent(serviceId || "")}`;
                    wixLocation.to(`${base}?${serviceParam}&referral=calendar2`);
                    return;
                }
                if (target === "PRIVACY") {
                    wixLocation.to(URLS.PRIVACY_POLICY);
                    return;
                }
                post(MESSAGE_TYPES.NAV, { status: "ERROR", error: { message: "Destino de navegacion no permitido" } }, messageId);
                return;
            }

            // -------------------------
            // Availability
            // -------------------------
            if (type === String(MESSAGE_TYPES.AVAIL).toUpperCase()) {
                const p = (msg && msg.payload) || {};
                const action = p.action;

                if (!serviceId) {
                    post(MESSAGE_TYPES.AVAIL, { status: "ERROR", action: String(action || ""), error: { message: "Servicio no disponible en contexto" } }, messageId);
                    return;
                }

                if (action === "days") {
                    try {
                        const addonIds = Array.isArray(p.addonIds) ? p.addonIds.map((id) => _safeTrim(id)).filter(Boolean) : [];
                        const result = await _retry(
                            () => getAvailableDays(
                                serviceId,
                                p.resourceId || null,
                                p.year,
                                p.month,
                                addonIds,
                                availabilityRequesterId,
                            ),
                            "getAvailableDays"
                        );
                        post(MESSAGE_TYPES.AVAIL, _withAvailabilityRequestSequence(result, p.requestSequence, "days"), messageId);
                    } catch (error) {
                        post(MESSAGE_TYPES.AVAIL, _withAvailabilityRequestSequence({ status: "ERROR", error: { message: error?.message || String(error) } }, p.requestSequence, "days"), messageId);
                    }
                    return;
                }

                if (action === "slots") {
                    try {
                        const addonIds = Array.isArray(p.addonIds) ? p.addonIds.map((id) => _safeTrim(id)).filter(Boolean) : [];
                        const result = await _retry(
                            () => getCertifiedDualSlots(
                                serviceId,
                                p.resourceId || null,
                                p.dateYMD || p.date || null,
                                addonIds,
                                availabilityRequesterId,
                            ),
                            "getCertifiedDualSlots"
                        );
                        post(MESSAGE_TYPES.AVAIL, _withAvailabilityRequestSequence(result, p.requestSequence, "slots"), messageId);
                    } catch (error) {
                        post(MESSAGE_TYPES.AVAIL, _withAvailabilityRequestSequence({ status: "ERROR", error: { message: error?.message || String(error) } }, p.requestSequence, "slots"), messageId);
                    }
                    return;
                }

                post(MESSAGE_TYPES.AVAIL, { status: "ERROR", action: String(action || ""), error: { message: "AVAIL action no soportada" } }, messageId);
                return;
            }

            // -------------------------
            // Selection echo (UI)
            // -------------------------
            if (type === String(MESSAGE_TYPES.SELECT).toUpperCase()) {
                const p = (msg && msg.payload) || {};

                if (!serviceId) {
                    post(MESSAGE_TYPES.SELECT, { status: "ERROR", error: { message: "Servicio no disponible" } }, messageId);
                    return;
                }

                const resourceId = _safeTrim(p.resourceId || "") || null;
                const staffName = resourceId ? (staffDisplayByResourceId.get(resourceId) || STAFF_DEFAULT_NAME) : STAFF_DEFAULT_NAME;

                post(
                    MESSAGE_TYPES.SELECT, {
                        status: "SUCCESS",
                        data: {
                            resourceId,
                            resourceName: staffName,
                            localStartDate: p.localStartDate || null,
                            localEndDate: p.localEndDate || null,
                        },
                    },
                    messageId
                );
                return;
            }

            // -------------------------
            // Booking
            // -------------------------
            if (type === String(MESSAGE_TYPES.BOOK).toUpperCase()) {
                const p = (msg && msg.payload) || {};

                const canonicalServiceId = _safeTrim(serviceId);
                if (!canonicalServiceId || !_looksLikeGuid(canonicalServiceId)) {
                    post(MESSAGE_TYPES.BOOK, { status: "ERROR", error: { message: "serviceId invalido" } }, messageId);
                    return;
                }

                const slotF1Safe = { ...(p.slotF1 || {}), serviceId: canonicalServiceId };
                const slotF2Safe = p.slotF2 ? { ...p.slotF2 } : null;
                const incomingMeta = p.metaCita && typeof p.metaCita === "object" ? p.metaCita : {};
                const requestedAddonIds = Array.isArray(incomingMeta.addons) ?
                    incomingMeta.addons.map((addon) => _safeTrim(addon?.addonId || addon?.id)).filter(Boolean) : [];
                const canonicalAddons = (currentServicePresentation?.addons || [])
                    .filter((addon) => requestedAddonIds.includes(addon.addonId || addon.id));
                const requestedPaymentMethod = String(incomingMeta.metodoPago || "PRESENCIAL").trim().toUpperCase();
                const metaCita = {
                    serviceId: canonicalServiceId,
                    resourceFilterId: _safeTrim(incomingMeta.resourceFilterId || "") || null,
                    servicioNombre: currentServicePresentation?.tituloServicio || "Servicio",
                    precioBase: Number(currentServicePresentation?.precio || 0),
                    metodoPago: requestedPaymentMethod === "ONLINE" ? "ONLINE" : "PRESENCIAL",
                    addons: canonicalAddons,
                    uiPairToken: _safeTrim(incomingMeta.uiPairToken || p.uiPairToken || "") || null,
                    pairToken: _safeTrim(incomingMeta.pairToken || p.pairToken || "") || null,
                };
                const cliente = p.cliente || {};

                try {
                    const result = await _retry(
                        () => processDualBooking({
                            slotF1: slotF1Safe,
                            slotF2: slotF2Safe,
                            cliente,
                            metaCita,
                        }),
                        "processDualBooking"
                    );

                    post(MESSAGE_TYPES.BOOK, result, messageId);

                    if (result?.status === "SUCCESS" && result.data && !result.data.requiresPayment) {
                        try {
                            const confirmation = result.data.confirmation || {};
                            const resourceId = metaCita.resourceFilterId || null;
                            const staffName = resourceId ? (staffDisplayByResourceId.get(resourceId) || STAFF_DEFAULT_NAME) : STAFF_DEFAULT_NAME;
                            const serviceName = String(confirmation.servicio || currentServicePresentation?.tituloServicio || "Servicio");
                            const totalBilled = Number(currentServicePresentation?.precio || 0) + _sumAddons(canonicalAddons);
                            const confirmedTotal = Number(confirmation.total);

                            await wixWindowFrontend.openLightbox("ConfirmacionReserva", {
                                traceId,
                                bookingIdF1: result.data.bookingIdF1,
                                bookingIdF2: result.data.bookingIdF2 || null,
                                isCombined: result.data.isCombined || false,
                                servicio: serviceName,
                                tituloServicio: serviceName,
                                fecha: confirmation.fecha || null,
                                hora: confirmation.hora || null,
                                horaF2: confirmation.horaF2 || null,
                                estilista: confirmation.estilista || staffName,
                                resourceFilterId: resourceId,
                                extras: canonicalAddons.length > 0 ?
                                    canonicalAddons.map((addon) => addon.nombre).join(", ") : "Ninguno",
                                total: Number.isFinite(confirmedTotal) ? confirmedTotal : totalBilled,
                                moneda: confirmation.moneda || currentServicePresentation?.moneda || MONEY.DISPLAY_CURRENCY,
                            });
                        } catch (lightboxError) {
                            console.warn("[calendario-2] Error al abrir Lightbox:", lightboxError?.message || String(lightboxError));
                        }
                    }
                } catch (error) {
                    post(MESSAGE_TYPES.BOOK, { status: "ERROR", error: { message: error?.message || String(error) } }, messageId);
                }

                return;
            }

        },

        handshakeTimeoutMs: UI.HANDSHAKE_TIMEOUT_MS,
        contextTimeoutMs: UI.CONTEXT_TIMEOUT_MS,
        onError: (e) => _showError(e?.message || String(e)),
    });
});