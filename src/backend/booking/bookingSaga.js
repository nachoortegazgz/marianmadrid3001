/**
 * =============================================================================
 * MODULE: backend/booking/bookingSaga.js
 * VERSION: v20.0.0-dual-cache-invalidation-saga
 * RESPONSIBILITY: Transactional Saga Orchestrator for simple and dual bookings.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-dual-cache-invalidation-saga: Invalidates availability caches for both
 *   serviceId (F1) and linkedServiceId (F2) upon successful saga completion.
 * - v19.6.15-confirmation-revision-compensation: Stores the revision returned by offline confirmation before later compensation can cancel a created booking.
 * - v19.6.14-canonical-slot-contract: Accepts the primary serviceId and resourceFilterId only from the normalized public payload.
 * - v19.6.7-writer-slot-native-id: Serializes Writer V2 resource and location identifiers with native _id fields.
 * - v19.6.3-prioritized-reliability-refactor: Removes duplicated catalog and slot paths, restores Codegem fixes, and hardens persistence.
 * - v19.6.2-serviceid-linkfases-contract: Uses serviceId and derives F2 only from Import2.linkFases.
 * - v19.6.0-writer-v2-contract-alignment: Serializes Writer V2 revisions for external effects and persists native add-ons only on F1 for correct revalidation after reschedule.
 * - v19.5.8-any-resource-resolution-priority: Uses the backend-resolved staff before inherited slot data when ANY was requested.
 * - v19.5.7-clean-resource-contract: Uses the simplified F1 staff-resolution contract without inert dual arguments.
 * - v19.5.3-lease-and-payment-hardening: Checks a lost lease before each external booking, checkout, confirmation, and CMS persistence effect.
 * - v19.5.1-certified-resource-preserved: Preserves the staff resource of a dual pair hydrated from cache before final revalidation.
 * - v19.5.0-dual-routing-enforced: A service configured as dual in Import2 cannot degrade to a simple F1 booking when F2 is absent.
 * - v19.4.8: Derives pairToken from canonical server-validated booking inputs; UI token is cache-only.
 * - v19.4.7: Sends native add-ons only with F1, whose Import2 catalog owns their group mapping.
 * - v19.4.6: Sends only Import2-mapped and SSOT-authorized native add-ons to Bookings V2.
 * - v19.3.0-exact-slot-recheck: Revalidates exact selected F1/F2 slots before booking.
 * - v19.2.0-saga-compensation-hardened: Compensates partial effects, persists inside the saga, and aborts on lost lock lease.
 * - v19.1.2-v3-v2-contract-aligned: Starts lock heartbeat only after lock acquisition.
 * - v19.1.1-v3-v2-contract-aligned: Uses canonical nested Slot V2 payloads.
 * =============================================================================
 */

import wixData from "wix-data";

import {
    BOOKINGS_ADDON_CONFIG,
    MONEY,
    STAFF_DEFAULT_NAME,
    makeTraceId,
    _safeTrim,
    _safeEmail,
    _safePhone,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _executeWithRetry,
    withTimeout,
    _isValidEmail,
    _maskEmail,
} from "public/mmUtils";
import {
    COLLECTIONS,
    APP_IDS,
    SDK_CONFIG,
    CONCURRENCY,
} from "backend/internalConfig";

import {
    createBookingElevated,
    cancelBookingElevated,
    createCheckoutElevated,
    getCheckoutUrlSafe,
    confirmOrDeclineBookingElevated,
    _projectWriterSlotFromAvailability,
    _lockSlotKeyOrFail,
    _unlockSlotKey,
    _renewLock,
    _persistBooking,
    _handleError,
    createBookingError,
    logger,
    _getDualPairFromCache,
    _buildLockKeys,
    _initTransaction,
    _completeTransaction,
    _failTransaction,
    _sumAddons,
} from "backend/booking/bookingCore";

import { hashSHA256 } from "backend/securityEngine";

import {
    getServiceForBookingInternal,
    resolveStaffForSlot,
    resolveServiceId,
    _invalidateCachesInternal,
    revalidateExactAvailabilitySlot,
} from "backend/reservas.web";

const log = logger;

const CITAS_COLLECTION = COLLECTIONS.CITAS;
const COMPENSATIONS_COLLECTION = COLLECTIONS.COMPENSATIONS;

const API_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.API_MS || 15000;
const HEARTBEAT_MS = CONCURRENCY?.HEARTBEAT_MS || 15000;
const LOCK_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 120000;

function _buildNativeBookedAddOns(addonsNorm) {
    const selected = Array.isArray(addonsNorm) ? addonsNorm : [];
    if (selected.length > BOOKINGS_ADDON_CONFIG.MAX_PER_BOOKING) {
        throw createBookingError("ADDON_LIMIT_EXCEEDED", "Se excedio el limite de complementos para la reserva.");
    }

    const records = [];
    for (const addon of selected) {
        const nativeAddonId = _safeTrim(addon?.bookingsAddonId);
        if (!nativeAddonId) continue;

        const nativeAddonGroupId = _safeTrim(addon?.bookingsAddonGroupId);
        if (!_looksLikeGuid(nativeAddonId)) {
            throw createBookingError("NATIVE_ADDON_INVALID", "El complemento nativo configurado no es valido.");
        }
        if (!_looksLikeGuid(nativeAddonGroupId)) {
            throw createBookingError("NATIVE_ADDON_GROUP_MISSING", "Falta el grupo nativo del complemento configurado.");
        }

        records.push({ _id: nativeAddonId, groupId: nativeAddonGroupId });
    }

    return records;
}

function _extractUiPairToken(metaCita, unsafePayload) {
    return _safeTrim(
        metaCita?.uiPairToken ||
        unsafePayload?.uiPairToken ||
        unsafePayload?.pairToken ||
        metaCita?.pairToken ||
        ""
    );
}

function _buildServerPairToken({ email, serviceId, linkedServiceId, resourceId, f1LocalStart, f1LocalEnd, f2LocalStart, f2LocalEnd, addonIds }) {
    const canonical = JSON.stringify({
        email: _safeTrim(email).toLowerCase(),
        serviceId: _safeTrim(serviceId),
        linkedServiceId: _safeTrim(linkedServiceId) || null,
        resourceId: _safeTrim(resourceId),
        f1LocalStart: _safeTrim(f1LocalStart),
        f1LocalEnd: _safeTrim(f1LocalEnd),
        f2LocalStart: _safeTrim(f2LocalStart) || null,
        f2LocalEnd: _safeTrim(f2LocalEnd) || null,
        addonIds: Array.from(new Set(Array.isArray(addonIds) ? addonIds : [])).sort(),
    });

    return `pt_${hashSHA256(canonical).substring(0, 40)}`;
}

function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") return { ...slot.slot, ...slot };
    return slot;
}

async function _bestEffortUnlockAll(lockKeys, lockOwnerId, traceId) {
    for (const key of lockKeys) {
        const result = await _unlockSlotKey(key, lockOwnerId).catch((error) => ({ ok: false, error }));
        if (!result?.ok && !result?.missing && !result?.skipped) {
            log.warn("bestEffortUnlockAll failed", { traceId, slotKey: key, message: result?.error?.message || result?.reason || "UNKNOWN" });
        }
    }
}

class SagaStep {
    constructor(name, executeFn, compensateFn = null) {
        this.name = name;
        this.executeFn = executeFn;
        this.compensateFn = compensateFn;
    }
}

export class BookingSagaOrchestrator {
    constructor(traceId) {
        this.traceId = traceId || makeTraceId("saga");
        this.executedSteps = [];
    }

    async execute(steps) {
        for (const step of steps) {
            try {
                const stepResult = await step.executeFn();
                if (stepResult && stepResult.ok === false) {
                    throw createBookingError(
                        stepResult.code || "SAGA_STEP_FAILED",
                        stepResult.message || `Saga step failed: ${step.name}`
                    );
                }
                this.executedSteps.push(step);
            } catch (error) {
                log.error(`[SagaOrchestrator] Step '${step.name}' failed. Rollback...`, {
                    error: error?.message,
                    traceId: this.traceId,
                });
                await this._rollback();
                throw error;
            }
        }
    }

    async _rollback() {
        const reversedSteps = [...this.executedSteps].reverse();
        for (const step of reversedSteps) {
            if (typeof step.compensateFn === "function") {
                try {
                    log.info(`[SagaOrchestrator] Compensation: '${step.name}'`, { traceId: this.traceId });
                    await step.compensateFn();
                } catch (compError) {
                    log.error(`[SagaOrchestrator] Compensation failed '${step.name}'`, {
                        error: compError?.message,
                        traceId: this.traceId,
                    });
                }
            }
        }
    }
}

export async function executeBookingSaga(unsafePayload) {
    const traceId = unsafePayload?.traceId || makeTraceId("saga-book");

    let pairToken = null;
    let heartbeatInterval = null;
    let lockKeys = [];
    let lockOwnerId = null;
    let lockLeaseLost = false;

    try {
        if (!unsafePayload || typeof unsafePayload !== "object") {
            throw createBookingError("INVALID_PAYLOAD", "Payload transaccional no valido.");
        }
        if (!unsafePayload.cliente || typeof unsafePayload.cliente !== "object") {
            throw createBookingError("INVALID_PAYLOAD", "Informacion del cliente obligatoria.");
        }
        if (!unsafePayload.metaCita || typeof unsafePayload.metaCita !== "object") {
            throw createBookingError("INVALID_PAYLOAD", "Metadatos de la cita obligatorios.");
        }

        const email = _safeEmail(unsafePayload.cliente.email);
        if (!email || !_isValidEmail(email)) throw createBookingError("INVALID_EMAIL", "Correo electronico no valido.");

        log.info("executeBookingSaga started", {
            traceId,
            maskedEmail: _maskEmail(email),
            serviceId: unsafePayload.slotF1?.serviceId,
        });

        const { slotF1, slotF2, cliente, metaCita } = unsafePayload;
        if (!slotF1) throw createBookingError("INVALID_PAYLOAD", "La primera fase (slotF1) es obligatoria.");

        // Resolve stable pair token + optional cached dual slot
        let effectiveSlotF2 = slotF2;
        let cachedDualPair = null;

        let rawResourceId = metaCita.resourceFilterId || null;
        let slotResourceId = slotF1.resourceId || slotF1.resource?.id || null;
        let certifiedPairResourceId = null;

        const uiPairToken = _extractUiPairToken(metaCita, unsafePayload);

        if (uiPairToken && (!effectiveSlotF2 || !effectiveSlotF2.localStartDate)) {
            cachedDualPair = (await _getDualPairFromCache(uiPairToken, traceId).catch(() => null)) || null;
            if (cachedDualPair?.slotF2 && (!effectiveSlotF2 || !effectiveSlotF2.localStartDate)) {
                effectiveSlotF2 = cachedDualPair.slotF2;
                certifiedPairResourceId = _looksLikeGuid(cachedDualPair.resourceId) ? cachedDualPair.resourceId : null;
                if (certifiedPairResourceId && !metaCita.resourceFilterId) metaCita.resourceFilterId = certifiedPairResourceId;
            }
        }

        rawResourceId = metaCita.resourceFilterId || rawResourceId || null;
        slotResourceId = slotF1.resourceId || slotF1.resource?.id || slotResourceId || null;
        const assignedResource =
            (certifiedPairResourceId && _looksLikeGuid(certifiedPairResourceId) ? certifiedPairResourceId : null) ||
            (_looksLikeGuid(rawResourceId) ? rawResourceId : null) ||
            (_looksLikeGuid(slotResourceId) ? slotResourceId : null);

        const serviceIdRaw = _safeTrim(slotF1.serviceId);

        const resolvedService = await resolveServiceId(serviceIdRaw);
        const serviceId = _safeTrim(resolvedService?.data);
        if (!serviceId) {
            return { status: "ERROR", error: { code: "SERVICE_NOT_FOUND", message: "Identificador del servicio principal no valido." } };
        }

        const f1LocalStart = _normalizeLocalIsoStr(slotF1.localStartDate);
        if (!f1LocalStart) throw createBookingError("INVALID_DATES", "La hora de inicio de la Fase 1 es obligatoria.");

        const hasF2Payload = !!effectiveSlotF2;

        const rawFilter = metaCita?.resourceFilterId ?? null;
        const isAnyResourceRequested = !rawFilter ||
            String(rawFilter).trim() === "" || ["all", "any"].includes(String(rawFilter).toLowerCase());

        if (!isAnyResourceRequested && !assignedResource) {
            return { status: "ERROR", error: { code: "RESOURCE_NOT_AVAILABLE", message: "No se pudo resolver la profesional solicitada." } };
        }

        const resourceIdForResolve = isAnyResourceRequested ? null : assignedResource;

        // Load service SSOT from Import2 via reservas.web.js
        const svc = await getServiceForBookingInternal(serviceId, traceId);
        if (!svc || svc.status !== "SUCCESS" || !svc.data) {
            return { status: "ERROR", error: { code: "SERVICE_NOT_FOUND", message: "No se pudo cargar el servicio desde el catalogo." } };
        }

        const serviceData = svc.data;
        const isDualConfigured = !!(serviceData.permitirCombinar && serviceData.linkFases);

        if (hasF2Payload && !isDualConfigured) {
            return { status: "ERROR", error: { code: "DUAL_NOT_ALLOWED", message: "Este servicio no permite combinacion en dos fases." } };
        }
        if (isDualConfigured && !hasF2Payload) {
            return { status: "ERROR", error: { code: "DUAL_SLOT_REQUIRED", message: "Este servicio requiere un par de slots dual certificado." } };
        }

        const tiempoFase1Ms = (Number(serviceData.tiempoFase1) || 0) * 60 * 1000;
        const exposureMs = (Number(serviceData.tiempoExposicion) || 0) * 60 * 1000;
        const tiempoFase2Ms = (Number(serviceData.tiempoFase2) || 0) * 60 * 1000;

        const f1StartUtc = getUtcDateFromMadridLocal(f1LocalStart);
        if (!f1StartUtc) throw createBookingError("INVALID_DATES", "Error al convertir la fecha local de la Fase 1.");
        if (f1StartUtc.getTime() <= Date.now()) {
            return { status: "ERROR", error: { code: "SLOT_IN_PAST", message: "El horario seleccionado ya ha comenzado." } };
        }

        const f1EndUtcSSOT = new Date(f1StartUtc.getTime() + tiempoFase1Ms);
        const f1LocalEndSSOT = getMadridLocalStringNoZ(f1EndUtcSSOT);

        const isDual = isDualConfigured;

        let linkedServiceId = null;
        let f2LocalStart = null;
        let f2LocalEnd = null;

        if (isDual) {
            const resolvedPhase2 = await resolveServiceId(serviceData.linkFases);
            linkedServiceId = _safeTrim(resolvedPhase2?.data);

            if (!linkedServiceId) {
                return { status: "ERROR", error: { code: "SERVICE_NOT_FOUND", message: "Identificador de la segunda fase no valido." } };
            }

            f2LocalStart = _normalizeLocalIsoStr(effectiveSlotF2?.localStartDate);
            f2LocalEnd = _normalizeLocalIsoStr(effectiveSlotF2?.localEndDate);

            if (!f2LocalStart || !f2LocalEnd) {
                const f2StartUtcSSOT = new Date(f1EndUtcSSOT.getTime() + exposureMs);
                const f2EndUtcSSOT = new Date(f2StartUtcSSOT.getTime() + tiempoFase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtcSSOT);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtcSSOT);
            }

            if (!f2LocalStart || !f2LocalEnd) {
                return { status: "ERROR", error: { code: "INVALID_F2_TIMING", message: "Tiempos de la segunda fase no validos." } };
            }
        }

        // Pricing: Import2 catalog is authoritative. Client supplies only requested addon IDs.
        const requestedAddonIds = Array.from(new Set(
            (Array.isArray(metaCita?.addons) ? metaCita.addons : [])
            .map((addon) => _safeTrim(addon?.addonId || addon))
            .filter(Boolean)
        ));
        const catalogAddons = Array.isArray(serviceData?.metadata?.addons) ? serviceData.metadata.addons : [];
        const catalogAddonsById = new Map(catalogAddons.map((addon) => [_safeTrim(addon?.addonId), addon]).filter(([addonId]) => Boolean(addonId)));
        const unknownAddonId = requestedAddonIds.find((addonId) => !catalogAddonsById.has(addonId));
        if (unknownAddonId) throw createBookingError("ADDON_INVALID", "El complemento solicitado no pertenece al servicio.");
        const addonsNorm = requestedAddonIds.map((addonId) => {
            const addon = catalogAddonsById.get(addonId);
            return {
                addonId,
                nombre: String(addon?.nombre || "Complemento"),
                precio: Number(addon?.precio || 0),
                bookingsAddonId: _safeTrim(addon?.bookingsAddonId) || null,
                bookingsAddonGroupId: _safeTrim(addon?.bookingsAddonGroupId) || null,
                cantidadMaximaAddon: Number.isInteger(Number(addon?.cantidadMaximaAddon)) && Number(addon?.cantidadMaximaAddon) > 0 ? Number(addon.cantidadMaximaAddon) : 1,
            };
        });
        const nativeBookedAddOns = _buildNativeBookedAddOns(addonsNorm);
        const nativeAddonIds = nativeBookedAddOns.map((addon) => addon._id).sort();
        const addonsTotal = _sumAddons(addonsNorm);

        const serviceName = serviceData?.metadata?.titulo || "Servicio";
        const basePrice = Number(serviceData?.metadata?.pricing?.base || 0);
        const totalBilled = basePrice + addonsTotal;

        const madridDateYMD = f1LocalStart.slice(0, 10);

        // Resolve staff for F1 (and intersect with F2 if dual) (SSOT)
        const dualContext = isDualConfigured ? {
            start2: _normalizeLocalIsoStr(effectiveSlotF2?.localStartDate)
        } : null;

        const resourceValidation = await resolveStaffForSlot(
            String(serviceId),
            f1LocalStart,
            resourceIdForResolve,
            requestedAddonIds,
            dualContext
        );

        if (resourceValidation?.status !== "SUCCESS" || !resourceValidation?.data?.slotF1) {
            return {
                status: "ERROR",
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: resourceValidation?.error?.message || "El horario seleccionado ya no esta disponible.",
                },
            };
        }

        const resolvedId = resourceValidation?.data?.resourceId ?? null;
        const finalResourceId = isAnyResourceRequested ?
            (resolvedId || assignedResource || null) :
            (assignedResource || resolvedId || null);

        if (isDualConfigured && certifiedPairResourceId && finalResourceId !== certifiedPairResourceId) {
            return { status: "ERROR", error: { code: "CERTIFIED_RESOURCE_MISMATCH", message: "The selected dual pair is no longer bound to the certified professional." } };
        }
        if (!finalResourceId) {
            return { status: "ERROR", error: { code: "SLOT_UNAVAILABLE", message: "No se pudo asignar una profesional para este horario." } };
        }

        const finalResourceName =
            resourceValidation?.data?.resourceName || STAFF_DEFAULT_NAME;

        // Revalidate F1 at the exact user-selected time with the final assigned staff.
        const f1LocalEndReal = _normalizeLocalIsoStr(resourceValidation.data.slotF1?.localEndDate) || f1LocalEndSSOT;
        const exactF1 = await revalidateExactAvailabilitySlot({
            serviceId: String(serviceId),
            localStartDate: f1LocalStart,
            localEndDate: f1LocalEndReal,
            resourceId: String(finalResourceId),
            nativeAddonIds,
            traceId,
        });
        if (exactF1?.status !== "SUCCESS" || !exactF1?.data?.slot) {
            return { status: "ERROR", error: { code: "SLOT_UNAVAILABLE", message: exactF1?.error?.message || "El horario seleccionado ya no esta disponible." } };
        }
        const slotF1ForLocks = { ...exactF1.data.slot, serviceId: String(serviceId) };

        let slotF2ForLocks = null;

        if (isDual) {
            const selectedF2Start = _normalizeLocalIsoStr(effectiveSlotF2?.localStartDate);
            const selectedF2End = _normalizeLocalIsoStr(effectiveSlotF2?.localEndDate);
            const f1EndUtcReal = getUtcDateFromMadridLocal(f1LocalEndReal);
            const selectedF2StartUtc = getUtcDateFromMadridLocal(selectedF2Start);
            const selectedF2EndUtc = getUtcDateFromMadridLocal(selectedF2End);
            const earliestF2Utc = f1EndUtcReal ? new Date(f1EndUtcReal.getTime() + exposureMs) : null;

            if (!selectedF2Start || !selectedF2End || !selectedF2StartUtc || !selectedF2EndUtc || !earliestF2Utc) {
                return { status: "ERROR", error: { code: "INVALID_F2_TIMING", message: "Tiempos de la segunda fase no validos." } };
            }
            if (selectedF2StartUtc.getTime() < earliestF2Utc.getTime()) {
                return { status: "ERROR", error: { code: "INVALID_F2_TIMING", message: "La segunda fase no respeta el tiempo de exposicion." } };
            }
            if (Math.abs((selectedF2EndUtc.getTime() - selectedF2StartUtc.getTime()) - tiempoFase2Ms) > 1000) {
                return { status: "ERROR", error: { code: "INVALID_F2_TIMING", message: "La duracion de la segunda fase no coincide con el servicio." } };
            }

            const exactF2 = await revalidateExactAvailabilitySlot({
                serviceId: String(linkedServiceId),
                localStartDate: selectedF2Start,
                localEndDate: selectedF2End,
                resourceId: String(finalResourceId),
                traceId,
            });
            if (exactF2?.status !== "SUCCESS" || !exactF2?.data?.slot) {
                return { status: "ERROR", error: { code: "SLOT_UNAVAILABLE", message: exactF2?.error?.message || "La segunda fase seleccionada ya no esta disponible." } };
            }

            slotF2ForLocks = { ...exactF2.data.slot, serviceId: String(linkedServiceId) };
            f2LocalStart = selectedF2Start;
            f2LocalEnd = selectedF2End;
        }

        const phases = [{
                key: "F1",
                rawSlot: slotF1ForLocks,
                validatedSlot: slotF1ForLocks,
                localStart: f1LocalStart,
                localEnd: f1LocalEndReal,
                tipo: isDual ? "dual_fase1" : "simple",
                isDual,
            },
            ...(isDual ? [{
                key: "F2",
                rawSlot: slotF2ForLocks,
                validatedSlot: slotF2ForLocks,
                localStart: f2LocalStart,
                localEnd: f2LocalEnd,
                tipo: "dual_fase2",
                isDual: true,
            }, ] : []),
        ];

        const stableToken = _buildServerPairToken({
            email,
            serviceId,
            linkedServiceId: isDual ? linkedServiceId : null,
            resourceId: finalResourceId,
            f1LocalStart,
            f1LocalEnd: f1LocalEndReal,
            f2LocalStart: isDual ? f2LocalStart : null,
            f2LocalEnd: isDual ? f2LocalEnd : null,
            addonIds: requestedAddonIds,
        });
        pairToken = stableToken;
        metaCita.uiPairToken = uiPairToken || null;
        metaCita.pairToken = stableToken;

        const lockResourceKey = finalResourceId ? String(finalResourceId) : "ANY_RESOURCE";
        lockKeys = _buildLockKeys(phases, lockResourceKey);
        lockOwnerId = stableToken;

        const payloadHash = hashSHA256(
            JSON.stringify({
                slotF1: { serviceId: String(serviceId), start: f1LocalStart, end: f1LocalEndReal },
                slotF2: isDual ? { serviceId: String(linkedServiceId), start: f2LocalStart, end: f2LocalEnd } : null,
                pairToken: stableToken,
                addonIds: requestedAddonIds.slice().sort(),
                nativeAddonIds,
            })
        );

        const txResult = await _initTransaction(stableToken, payloadHash, traceId);
        if (!txResult.success) {
            const transactionCode = String(txResult.error || "TRANSACTION_BUSY");
            const transactionMessage = transactionCode === "PAIR_TOKEN_PAYLOAD_MISMATCH" ?
                "El token de reserva no coincide con el horario solicitado." :
                transactionCode === "TRANSACTION_PREVIOUSLY_FAILED" ?
                "La solicitud anterior fallo. Seleccione un horario actualizado." :
                "Ya hay una reserva en proceso para este horario.";
            return { status: "ERROR", data: null, error: { code: transactionCode, message: transactionMessage } };
        }

        if (!txResult.isNew) {
            if (txResult.existing && txResult.existing.status === "COMPLETED") {
                const completedResult = {
                    ...(txResult.existing.result || {}),
                    idempotent: true,
                };
                return { status: "SUCCESS", data: completedResult, idempotent: true, error: null };
            }
            if (txResult.timeout) {
                return { status: "PROCESSING", data: { retryAfter: 2, message: "La reserva esta siendo procesada. Reintentando..." }, error: null };
            }
        }

        // If already persisted in CMS by pairToken, return idempotently
        const existingCita = await wixData
            .query(CITAS_COLLECTION)
            .eq("pairToken", stableToken)
            .limit(1)
            .find({ suppressAuth: true, consistentRead: true })
            .then((res) => res?.items?.[0] || null)
            .catch(() => null);

        if (existingCita) {
            const meta = existingCita.meta || {};
            const pago = String(existingCita.statusPago || meta.statusPago || "").toUpperCase();

            if (pago === "PENDING_PAYMENT" && (meta.checkoutId || meta.checkoutID)) {
                const checkoutUrlExisting = await getCheckoutUrlSafe(meta.checkoutId || meta.checkoutID);
                const resultData = {
                    bookingIdF1: existingCita.bookingId,
                    bookingIdF2: meta.bookingIdF2 || null,
                    isCombined: meta.esCombinado || false,
                    checkoutUrl: checkoutUrlExisting || null,
                    requiresPayment: true,
                    idempotent: true,
                };
                await _completeTransaction(stableToken, resultData);
                return { status: "SUCCESS", data: resultData, error: null };
            }

            const resultData = {
                bookingIdF1: existingCita.bookingId,
                bookingIdF2: meta.bookingIdF2 || null,
                isCombined: meta.esCombinado || false,
                requiresPayment: false,
                idempotent: true,
            };

            await _completeTransaction(stableToken, resultData);
            return { status: "SUCCESS", data: resultData, error: null };
        }

        const saga = new BookingSagaOrchestrator(traceId);
        const createdBookings = [];
        let checkoutSession = null;
        let checkoutUrl = null;
        const assertLockLease = (stage) => {
            if (lockLeaseLost) {
                throw createBookingError("LOCK_LEASE_LOST", `Lock lease lost before ${String(stage || "booking effect")}.`);
            }
        };

        const sagaSteps = [
            new SagaStep(
                "LockSlots",
                async () => {
                        const acquiredKeys = [];
                        for (const key of lockKeys) {
                            const lockResult = await _lockSlotKeyOrFail(key, lockOwnerId, LOCK_TTL_MS);
                            if (!lockResult?.ok) {
                                await _bestEffortUnlockAll(acquiredKeys, lockOwnerId, traceId);
                                return { ok: false, code: "TOKEN_BUSY", message: lockResult?.message || "El horario esta ocupado." };
                            }
                            acquiredKeys.push(key);
                        }

                        if (!heartbeatInterval) {
                            heartbeatInterval = setInterval(() => {
                                Promise.all(lockKeys.map((key) => _renewLock(key, lockOwnerId, LOCK_TTL_MS)))
                                    .then((results) => {
                                        if (results.some((result) => !result?.ok)) {
                                            lockLeaseLost = true;
                                            log.error("Lock lease lost during booking saga", { traceId, lockOwnerId });
                                        }
                                    })
                                    .catch((error) => {
                                        lockLeaseLost = true;
                                        log.error("Lock heartbeat failed", { traceId, lockOwnerId, message: error?.message });
                                    });
                            }, HEARTBEAT_MS);
                        }

                        return { ok: true };
                    },
                    async () => {
                        if (heartbeatInterval) {
                            clearInterval(heartbeatInterval);
                            heartbeatInterval = null;
                        }
                        await _bestEffortUnlockAll(lockKeys, lockOwnerId, traceId);
                    }
            ),
        ];

        // Contact details (Bookings V2)
        const isOnlinePaymentRequested = String(metaCita?.metodoPago || "").toUpperCase() === "ONLINE";
        const rawName = cliente.nombre || cliente.firstName || "Cliente";
        const nameParts = String(rawName).trim().split(/\s+/);

        const contactDetails = {
            firstName: nameParts[0] || "Cliente",
            lastName: nameParts.slice(1).join(" ") || "",
            email,
            phone: _safePhone(cliente.telefono || cliente.phone),
        };

        // Build pristine slots (async)
        for (const p of phases) {
            const phaseServiceId = p.key === "F2" ? linkedServiceId : serviceId;
            p.pristineSlot = _projectWriterSlotFromAvailability(p.validatedSlot, finalResourceId, phaseServiceId);
            if (!p.pristineSlot) throw createBookingError("INVALID_SLOT", `Formato de slot invalido para el motor V2 (${p.key})`);
        }

        const compensateCreatedBookings = async () => {
            for (const b of [...createdBookings].reverse()) {
                try {
                    await cancelBookingElevated(b.bookingId, {
                        revision: String(b.revision),
                        flowControlSettings: { ignoreCancellationPolicy: true },
                    });
                } catch (error) {
                    await wixData
                        .insert(
                            COMPENSATIONS_COLLECTION, {
                                _id: `COMP_${String(b.bookingId)}_${String(traceId)}`,
                                bookingId: b.bookingId,
                                phase: b.phase.key,
                                status: "PENDING",
                                attempts: 0,
                                traceId,
                                error: error?.message || "CANCEL_COMPENSATION_FAILED",
                                createdAt: new Date(),
                            }, { suppressAuth: true })
                        .catch((persistError) => {
                            log.error("Booking compensation persistence failed", { traceId, bookingId: b.bookingId, message: persistError?.message });
                        });
                }
            }
        };

        sagaSteps.push(
            new SagaStep(
                "CreateBookings",
                async () => {
                        const buildSlotForApi = (pristine) => {
                            const resourceId = _safeTrim(pristine?.resource?._id || pristine?.resource?.id);
                            const locationId = _safeTrim(pristine?.location?._id || pristine?.location?.id);
                            const locationType = _safeTrim(pristine?.location?.locationType);

                            if (!resourceId || !locationId || !locationType) return null;

                            return {
                                serviceId: pristine.serviceId,
                                scheduleId: pristine.scheduleId,
                                startDate: pristine.startDate,
                                endDate: pristine.endDate,
                                timezone: pristine.timezone,
                                resource: { _id: resourceId },
                                location: { _id: locationId, locationType },
                            };
                        };

                        const createOne = async (phaseKey, phaseServiceId) => {
                            assertLockLease(`booking creation ${phaseKey}`);
                            const p = phases.find((ph) => ph.key === phaseKey);
                            if (!p) return;

                            if (!_looksLikeGuid(phaseServiceId)) throw new Error("SERVICE_ID_INVALID");
                            const slotForApi = buildSlotForApi(p.pristineSlot);
                            if (!slotForApi) throw new Error("BOOKING_SLOT_V2_INVALID");

                            const phaseNativeBookedAddOns = phaseKey === "F1" ? nativeBookedAddOns : [];
                            const res = await _executeWithRetry(
                                () =>
                                withTimeout(
                                    createBookingElevated({
                                        bookedEntity: { slot: slotForApi },
                                        contactDetails,
                                        totalParticipants: 1,
                                        ...(phaseNativeBookedAddOns.length > 0 ? { bookedAddOns: phaseNativeBookedAddOns } : {}),
                                        ...(isOnlinePaymentRequested ? { selectedPaymentOption: "ONLINE" } : {}),
                                    }, {
                                        flowControlSettings: {
                                            skipAvailabilityValidation: false,
                                            skipBusinessConfirmation: false,
                                            skipSelectedPaymentOptionValidation: false,
                                        },
                                    }),
                                    API_TIMEOUT_MS,
                                    `createBooking_${phaseKey}`
                                ),
                                5,
                                500
                            );

                            const bId = res?.booking?._id || res?._id;
                            const rev = Number(res?.booking?.revision || res?.revision || 1);

                            if (!bId) throw new Error(`Missing bookingId for ${phaseKey}`);
                            createdBookings.push({ bookingId: bId, revision: rev, phase: p });
                        };

                        try {
                            await createOne("F1", serviceId);
                            assertLockLease("second booking creation");
                            if (isDual) await createOne("F2", linkedServiceId);
                            assertLockLease("booking creation completion");
                            return { ok: true };
                        } catch (error) {
                            await compensateCreatedBookings();
                            throw error;
                        }
                    },
                    compensateCreatedBookings
            )
        );

        // Payment decision
        const isOnlinePayment = isOnlinePaymentRequested;
        const needsCheckout = !!isOnlinePayment;

        if (needsCheckout) {
            sagaSteps.push(
                new SagaStep("CreateCheckout", async () => {
                    assertLockLease("checkout creation");
                    const lineItems = createdBookings.map((b) => ({
                        quantity: 1,
                        catalogReference: { appId: APP_IDS.BOOKINGS, catalogItemId: String(b.bookingId) },
                    }));

                    checkoutSession = await _executeWithRetry(
                        () => withTimeout(createCheckoutElevated({ lineItems, channelType: "WEB" }), API_TIMEOUT_MS, "createCheckout"),
                        3,
                        500
                    );

                    assertLockLease("checkout URL retrieval");
                    checkoutUrl = await getCheckoutUrlSafe(checkoutSession);
                    if (!checkoutUrl) throw createBookingError("CHECKOUT_FAILED", "No se pudo obtener la URL de pago.");

                    return { ok: true };
                })
            );
        } else {
            sagaSteps.push(
                new SagaStep("ConfirmPresencial", async () => {
                    for (const b of createdBookings) {
                        assertLockLease(`booking confirmation ${b.phase.key}`);
                        const confirmation = await _executeWithRetry(
                            () =>
                            withTimeout(
                                confirmOrDeclineBookingElevated(b.bookingId, { paymentStatus: "NOT_PAID", revision: String(b.revision) }),
                                API_TIMEOUT_MS,
                                `confirm_${b.phase.key}`
                            ),
                            3,
                            500
                        );
                        b.revision = Number(confirmation?.booking?.revision || confirmation?.revision || b.revision) || b.revision;
                    }
                    return { ok: true };
                })
            );
        }

        const persistedCitas = [];
        const compensatePersistedCitas = async () => {
            for (const citaId of [...persistedCitas].reverse()) {
                await wixData.remove(CITAS_COLLECTION, citaId, { suppressAuth: true }).catch((error) => {
                    log.error("CitasF2 compensation failed", { traceId, citaId, message: error?.message });
                });
            }
        };

        const persistCreatedBookings = async () => {
            try {
                assertLockLease("CMS persistence");

                const paymentPlan = {
                    isOnline: needsCheckout,
                    metodoPago: needsCheckout ? "ONLINE" : "PRESENCIAL",
                    statusPago: needsCheckout ? "PENDING_PAYMENT" : "UNPAID",
                    checkoutId: checkoutSession ? (checkoutSession.checkout?._id || checkoutSession.checkout?.id || checkoutSession._id || checkoutSession.id || null) : null,
                };
                const baseMeta = {
                    pairToken: stableToken,
                    addons: addonsNorm,
                    nativeBookedAddOns,
                    addonsTotal,
                    resourceId: finalResourceId || null,
                    resourceFilterId: rawFilter || null,
                    resourceFilterName: isAnyResourceRequested ? STAFF_DEFAULT_NAME : finalResourceName,
                    serviceId: serviceId,
                    traceId,
                    esCombinado: isDual,
                    fechaYmdMadrid: madridDateYMD,
                    servicioNombre: serviceName,
                    uiPairToken: uiPairToken || stableToken,
                    bookingIdF2: isDual ? createdBookings.find((b) => b.phase?.key === "F2")?.bookingId || null : null,
                    ...(paymentPlan.checkoutId ? { checkoutId: paymentPlan.checkoutId } : {}),
                };

                for (const b of createdBookings) {
                    const phase = b.phase;
                    const startUtc = getUtcDateFromMadridLocal(phase.localStart);
                    const endUtc = getUtcDateFromMadridLocal(phase.localEnd);
                    if (!startUtc || !endUtc) throw createBookingError("INVALID_DATES", `Fechas no validas para guardar (${phase.key})`);

                    const persistedServiceId = phase.key === "F2" ? linkedServiceId : serviceId;
                    const persisted = await _persistBooking({
                        bookingId: b.bookingId,
                        revision: b.revision,
                        serviceId: persistedServiceId,
                        scheduleId: phase.pristineSlot?.scheduleId || "",
                        resourceId: finalResourceId,
                        startDate: startUtc,
                        endDate: endUtc,
                        contactDetails,
                        tipo: phase.tipo,
                        meta: {
                            ...baseMeta,
                            nativeBookedAddOns: phase.key === "F1" ? nativeBookedAddOns : [],
                            statusPago: paymentPlan.statusPago,
                            metodoPago: paymentPlan.metodoPago,
                            precioAuditado: totalBilled,
                        },
                    }, traceId);

                    if (persisted?.created && persisted?.item?._id) {
                        persistedCitas.push(persisted.item._id);
                    }
                }
                return { ok: true };
            } catch (error) {
                await compensatePersistedCitas();
                throw error;
            }
        };

        sagaSteps.push(new SagaStep("PersistBookings", persistCreatedBookings, compensatePersistedCitas));
        await saga.execute(sagaSteps);

        const f1Booking = createdBookings.find((b) => b.phase?.key === "F1");
        const f2Booking = createdBookings.find((b) => b.phase?.key === "F2");

        const f1StartUtcFinal = getUtcDateFromMadridLocal(phases[0].localStart);
        const f2StartUtcFinal = isDual && phases[1]?.localStart ? getUtcDateFromMadridLocal(phases[1].localStart) : null;

        const resultData = {
            requiresPayment: needsCheckout,
            checkoutUrl,
            bookingIdF1: f1Booking?.bookingId || null,
            bookingIdF2: f2Booking?.bookingId || null,
            isCombined: isDual,
            confirmation: !needsCheckout ? {
                cliente: contactDetails.firstName,
                servicio: serviceName,
                fecha: madridDateYMD,
                hora: f1StartUtcFinal ? (getMadridLocalStringNoZ(f1StartUtcFinal).split("T")[1] || "").slice(0, 5) : null,
                horaF2: isDual && f2StartUtcFinal ? (getMadridLocalStringNoZ(f2StartUtcFinal).split("T")[1] || "").slice(0, 5) : null,
                estilista: finalResourceName,
                total: totalBilled,
                moneda: MONEY?.DISPLAY_CURRENCY || "EUR",
            } : null,
        };

        await _completeTransaction(stableToken, resultData);

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        await _bestEffortUnlockAll(lockKeys, lockOwnerId, traceId);

        try {
            await _invalidateCachesInternal(String(serviceId), madridDateYMD, finalResourceId, traceId);
            if (isDual && linkedServiceId) {
                await _invalidateCachesInternal(String(linkedServiceId), madridDateYMD, finalResourceId, traceId);
            }
        } catch (e) {
            log.warn("invalidateCachesInternal failed", { traceId, message: e?.message });
        }

        return { status: "SUCCESS", data: resultData, error: null };
    } catch (error) {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        if (lockKeys.length > 0 && lockOwnerId) await _bestEffortUnlockAll(lockKeys, lockOwnerId, traceId);
        if (pairToken) await _failTransaction(pairToken, error?.message || String(error)).catch(() => {});
        return _handleError(error, "executeBookingSaga", traceId, log);
    } finally {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }
}