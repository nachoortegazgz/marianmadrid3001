/**
 * =============================================================================
 * MODULE: backend/cajas.web.js
 * VERSION: v20.0.0-resilient-caja-status-guards
 * RESPONSIBILITY: Internal financial ledger with SHA-256 hash chains,
 * idempotent transaction recording, and chain integrity verification.
 * It provides technical controls and does not claim tax certification.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-resilient-caja-status-guards: Adds backward-compatible closed status guards
 *   supporting both CLOSED and CERRADA, hardens Z-closing projections and recovery.
 * - v20.0.0-optimized-guards-shared-kernel: Adds immediate feature-flag guards
 *   for accounting and M365 projections, reuses centralized utilities from
 *   mmUtils.js and responseUtils.js, and maintains strict ledger immutability.
 * - v19.6.3-prioritized-reliability-refactor: Removes duplicated catalog and slot paths, restores Codegem fixes, and hardens persistence.
 * - v19.5.3-fiscal-recovery-finalization: Finalizes CitasF2 PAID state only after a recovered online ledger succeeds and flags exhausted recoveries for review.
 * - v19.5.1-global-ledger-chain-audit: Verifies each daily slice against its predecessor in the global immutable hash chain and uses SSOT ledger timing.
 * - v19.5.0-staff-dashboard-presentation: Aligns authorized cashier read and operational methods with the Only Staff RBAC contract.
 * - v19.2.0-fiscal-recovery-hardened: Adds durable idempotent fiscal recovery queue.
 * - v19.0.0-final: Header standardized during V2 compliance review.
 * =============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";

import {
    makeTraceId,
    _roundMoney,
    _cleanText,
    _stableSerialize,
    _normalizeIdPart,
    withTimeout,
} from "public/mmUtils";
import {
    COLLECTIONS,
    TIPO_MOVIMIENTO,
    FORMA_PAGO,
    IVA_RATES,
    CAJA_STATUS,
    SDK_CONFIG,
    CONCURRENCY,
    CITA_FIELDS,
    ESTADO_CITA,
    ESTADO_PAGO,
} from "backend/internalConfig";

import { SECRETS } from "backend/mmSecrets";

import {
    logger,
    ERROR_CODES,
    createBookingError,
    normalizeError,
    _lockSlotKeyOrFail,
    _unlockSlotKey,
} from "backend/booking/bookingCore";

import { _toPublicError } from "backend/responseUtils";
import { hmacSha256Hex, hashChain } from "backend/securityEngine";
import { projectLedgerMovementToAccounting } from "backend/contabilidad";
import { enqueueM365LedgerRecord } from "backend/m365GraphSync";
import { requireAdmin, requireCajero, rateLimiter } from "backend/security";

const log = logger;

const SEED_SIGNATURE = "0000000000000000000000000000000000000000000000000000000000000000";
const CMS_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.CMS_MS || 15000;

const LEDGER_MUTEX_KEY = "LEDGER_GLOBAL_WRITE";
const LEDGER_MUTEX_TTL_MS = Number(CONCURRENCY?.LEDGER_MUTEX_TTL_MS) || 45000;
const FISCAL_KEY_CACHE_TTL_MS = Number(SDK_CONFIG?.SECURITY?.SECRET_CACHE_TTL_MS) || 300000;

let cachedFiscalKey = null;
let cachedFiscalNif = null;
let cacheKeyTime = 0;
let cacheNifTime = 0;

function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
        e.code = "RATE_LIMITED";
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

async function _getCachedCashierSecret() {
    const now = Date.now();
    if (cachedFiscalKey && now - cacheKeyTime < FISCAL_KEY_CACHE_TTL_MS) return cachedFiscalKey;

    const key = await getSecret(SECRETS.FISCAL_KEY).catch(() => "");
    if (!key) throw createBookingError(ERROR_CODES.FISCAL_SIGN_FAIL, "FISCAL_KEY secret missing in Secrets Manager");

    cachedFiscalKey = key;
    cacheKeyTime = now;
    return cachedFiscalKey;
}

async function _getCachedFiscalIssuerNif() {
    const now = Date.now();
    if (cacheNifTime && now - cacheNifTime < FISCAL_KEY_CACHE_TTL_MS) return cachedFiscalNif;

    const raw = await getSecret(SECRETS.FISCAL_NIF_EMISOR).catch(() => "");
    const normalized = String(raw || "").trim().toUpperCase();
    cachedFiscalNif = /^[A-Z0-9]{8,12}$/.test(normalized) ? normalized : null;
    cacheNifTime = now;
    return cachedFiscalNif;
}

function _canonicalPayload(prevHash, transactionId, tipoMovimiento, importeContable, formaPago) {
    return `${String(prevHash)}|${String(transactionId)}|${String(tipoMovimiento)}|${Number(importeContable)}|${String(formaPago)}`;
}

function _canonicalPayloadV2(movement) {
    return _stableSerialize({
        prevHash: String(movement?.prevHash || ""),
        transactionId: String(movement?.transactionId || ""),
        tipoMovimiento: String(movement?.tipoMovimiento || ""),
        importeContable: Number(movement?.importeContable || 0),
        formaPago: String(movement?.formaPago || ""),
        baseImponible: Number(movement?.baseImponible || 0),
        cuotaIva: Number(movement?.cuotaIva || 0),
        tasaIva: Number(movement?.tasaIva || 0),
        naturalezaOperacion: String(movement?.naturalezaOperacion || ""),
        tratamientoIva: String(movement?.tratamientoIva || ""),
        referenciaRectificativa: String(movement?.referenciaRectificativa || ""),
        detalleLineas: Array.isArray(movement?.detalleLineas) ? movement.detalleLineas : [],
    });
}

async function _getNextSequenceNumbers(year, traceId) {
    const SEQ_COLLECTION = COLLECTIONS.CONTADORES_FISCALES;
    const SEQ_ID = "GLOBAL";

    let seqDoc = await withTimeout(
        wixData.get(SEQ_COLLECTION, SEQ_ID, { suppressAuth: true }).catch(() => null),
        CMS_TIMEOUT_MS,
        "getTicketSequence"
    );

    if (!seqDoc) {
        seqDoc = await withTimeout(
            wixData.insert(SEQ_COLLECTION, { _id: SEQ_ID, data: {} }, { suppressAuth: true }),
            CMS_TIMEOUT_MS,
            "createTicketSequence"
        );
    }

    const keyYear = String(year);
    const seqData = seqDoc && typeof seqDoc.data === "object" && seqDoc.data ? seqDoc.data : {};

    const currentYearSeq = Number(seqData[keyYear] || 0);
    const nextYearSeq = currentYearSeq + 1;

    const currentGlobalSeq = Number(seqData.seqGlobal || 0);
    const nextGlobalSeq = currentGlobalSeq + 1;

    const { _createdDate, _updatedDate, _owner, ...safeSeqDoc } = seqDoc;

    const updated = {
        ...safeSeqDoc,
        _id: SEQ_ID,
        data: { ...seqData, [keyYear]: nextYearSeq, seqGlobal: nextGlobalSeq },
    };

    const saved = await withTimeout(
        wixData.save(SEQ_COLLECTION, updated, { suppressAuth: true }),
        CMS_TIMEOUT_MS,
        "saveTicketSequence"
    );

    const savedData = saved && typeof saved.data === "object" && saved.data ? saved.data : {};
    if (Number(savedData[keyYear]) !== nextYearSeq || Number(savedData.seqGlobal) !== nextGlobalSeq) {
        throw createBookingError(ERROR_CODES.FISCAL_SIGN_FAIL, "Sequence persistence mismatch", {
            traceId,
            expectedYear: nextYearSeq,
            expectedGlobal: nextGlobalSeq,
        });
    }

    return { nextYearSeq, nextGlobalSeq };
}

async function _getUltimoHashYSecuencia() {
    const res = await withTimeout(
        wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).descending("seqGlobal").limit(1).find({ suppressAuth: true }),
        CMS_TIMEOUT_MS,
        "_getUltimoHashYSecuencia"
    );

    if (!res.items || res.items.length === 0) {
        return { ultimoHash: SEED_SIGNATURE, ultimoSeqGlobal: 0 };
    }

    const last = res.items[0];
    return {
        ultimoHash: last.hashCadena || SEED_SIGNATURE,
        ultimoSeqGlobal: Number(last.seqGlobal || 0),
    };
}

async function _getAllDailyMovements(diaKey, options = {}) {
    if (!diaKey) return [];

    let allItems = [];
    let query = wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("diaKey", String(diaKey));

    if (options.formaPago) query = query.eq("formaPago", options.formaPago);
    if (options.ascendingCreated) query = query.ascending("seqGlobal");

    query = query.limit(1000);

    let res = await withTimeout(query.find({ suppressAuth: true }), CMS_TIMEOUT_MS, "queryDailyMovements_p1");
    allItems = allItems.concat(res.items || []);

    let page = 2;
    const maxPages = Number(SDK_CONFIG?.JOBS?.FISCAL_DAILY_MAX_PAGES) || 10;

    while (res.hasNext() && page <= maxPages) {
        res = await withTimeout(res.next(), CMS_TIMEOUT_MS, `queryDailyMovements_p${page}`);
        allItems = allItems.concat(res.items || []);
        page++;
    }

    if (res.hasNext()) {
        throw createBookingError(ERROR_CODES.FISCAL_SIGN_FAIL, "Daily fiscal movement query reached configured page cap", {
            diaKey: String(diaKey),
            maxPages,
            itemCount: allItems.length,
        });
    }

    return allItems;
}

function _buildCashierProjection(items) {
    const totals = {
        saldoEfectivo: 0,
        saldoTarjeta: 0,
        saldoBizum: 0,
        saldoOnline: 0,
    };

    for (const movement of items || []) {
        const amount = Number(movement?.importeContable) || 0;
        if (movement?.formaPago === FORMA_PAGO.EFECTIVO) totals.saldoEfectivo += amount;
        if (movement?.formaPago === FORMA_PAGO.TARJETA) totals.saldoTarjeta += amount;
        if (movement?.formaPago === FORMA_PAGO.BIZUM) totals.saldoBizum += amount;
        if (movement?.formaPago === FORMA_PAGO.ONLINE) totals.saldoOnline += amount;
    }

    return {
        saldoEfectivo: _roundMoney(totals.saldoEfectivo),
        saldoTarjeta: _roundMoney(totals.saldoTarjeta),
        saldoBizum: _roundMoney(totals.saldoBizum),
        saldoOnline: _roundMoney(totals.saldoOnline),
        saldoTotal: _roundMoney(totals.saldoEfectivo + totals.saldoTarjeta + totals.saldoBizum + totals.saldoOnline),
        totalOperaciones: Array.isArray(items) ? items.length : 0,
    };
}

function _isClosedCajaState(estado) {
    const norm = String(estado || "").trim().toUpperCase();
    return norm === "CERRADA" || norm === "CLOSED";
}

async function _upsertCurrentCashProjection(diaKey, options = {}) {
    const day = String(diaKey || "").trim();
    if (!day) return null;

    const now = new Date();
    const [items, current] = await Promise.all([
        _getAllDailyMovements(day),
        withTimeout(
            wixData.get(COLLECTIONS.CAJA_ACTUAL, "CAJA_PRINCIPAL", { suppressAuth: true }).catch(() => null),
            CMS_TIMEOUT_MS,
            "getCurrentCashProjection"
        ),
    ]);
    const projection = _buildCashierProjection(items);
    const isSameDay = String(current?.diaKey || "") === day;
    const keepClosed = isSameDay && _isClosedCajaState(current?.estado) && !options.closed;
    const { _createdDate, _updatedDate, _owner, ...safeCurrent } = current || {};
    const doc = {
        ...safeCurrent,
        _id: "CAJA_PRINCIPAL",
        diaKey: day,
        ...projection,
        estado: (options.closed || keepClosed) ? CAJA_STATUS.CLOSED : CAJA_STATUS.OPEN,
        fechaApertura: isSameDay && current?.fechaApertura ? current.fechaApertura : now,
        fechaCierre: options.closed ? now : (keepClosed ? current?.fechaCierre || null : null),
        ultimaActualizacion: now,
        fechaActualizacion: now,
    };

    const operation = current ?
        wixData.update(COLLECTIONS.CAJA_ACTUAL, doc, { suppressAuth: true }) :
        wixData.insert(COLLECTIONS.CAJA_ACTUAL, doc, { suppressAuth: true });

    return await withTimeout(operation, CMS_TIMEOUT_MS, "upsertCurrentCashProjection");
}

function _mapFormaPagoToTipoMovimiento(formaPagoUpper, isRefund) {
    if (isRefund) return TIPO_MOVIMIENTO.REEMBOLSO;

    const map = {
        [FORMA_PAGO.EFECTIVO]: TIPO_MOVIMIENTO.VENTA_EFECTIVO,
        [FORMA_PAGO.TARJETA]: TIPO_MOVIMIENTO.VENTA_TARJETA,
        [FORMA_PAGO.BIZUM]: TIPO_MOVIMIENTO.VENTA_BIZUM,
        [FORMA_PAGO.ONLINE]: TIPO_MOVIMIENTO.VENTA_ONLINE,
    };

    return map[formaPagoUpper] || "";
}

function _resolveMovementType(formaPago, amount, requestedType, traceId) {
    const method = String(formaPago || "").toUpperCase();
    if (!Object.values(FORMA_PAGO).includes(method)) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Unsupported payment method", { traceId });
    }
    const requested = String(requestedType || "").trim().toUpperCase();
    if (requested && !Object.values(TIPO_MOVIMIENTO).includes(requested)) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Unsupported movement type", { traceId });
    }

    const isRefund = Number(amount) < 0 || requested === TIPO_MOVIMIENTO.REEMBOLSO;
    if (isRefund) {
        if (requested && requested !== TIPO_MOVIMIENTO.REEMBOLSO) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Refund type does not match amount", { traceId });
        }
        return TIPO_MOVIMIENTO.REEMBOLSO;
    }

    const expected = _mapFormaPagoToTipoMovimiento(method, false);
    if (!expected) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Unsupported payment method", { traceId });
    if (!requested || requested === expected) return expected;
    if (requested === TIPO_MOVIMIENTO.PROPINA && method !== FORMA_PAGO.ONLINE) return requested;

    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Movement type does not match payment method", { traceId, method, requested, expected });
}

function _movementNature(tipoMovimiento) {
    if (tipoMovimiento === TIPO_MOVIMIENTO.PROPINA) return "PROPINA";
    if (tipoMovimiento === TIPO_MOVIMIENTO.REEMBOLSO) return "DEVOLUCION";
    if (tipoMovimiento === TIPO_MOVIMIENTO.AJUSTE) return "AJUSTE";
    return "VENTA";
}

function _buildDocumentLines(concept, absAmount, baseImponible, cuotaIva, tasaIva) {
    return [{
        linea: 1,
        descripcion: String(concept || "Movimiento de caja").trim().slice(0, 180),
        cantidad: 1,
        baseImponible: _roundMoney(baseImponible),
        cuotaIva: _roundMoney(cuotaIva),
        tasaIva: Number(tasaIva) || 0,
        importeTotal: _roundMoney(absAmount),
    }];
}

async function _findCitaByBookingId(bookingId) {
    const clean = String(bookingId || "").trim();
    if (!clean) return null;

    const q = await withTimeout(
        wixData
        .query(COLLECTIONS.CITAS)
        .eq("bookingId", clean)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(() => null),
        CMS_TIMEOUT_MS,
        "findCitaByBookingIdInCajas"
    );

    return q?.items?.[0] || null;
}

// =============================================================================
// INTEGRITY VERIFICATION (prevHash + ticket sequence)
// =============================================================================
export async function _verifyIntegrityInternal(diaKey, options = {}) {
    const traceId = options.traceId || makeTraceId("verify-integrity");
    const fiscalKey = await _getCachedCashierSecret();

    const items = await _getAllDailyMovements(diaKey, { ascendingCreated: true });
    if (items.length === 0) return { integrityOk: true, inconsistencies: [], totalVerified: 0 };

    const inconsistencies = [];
    let expectedTicketNum = null;
    const firstSeqGlobal = Number(items[0]?.seqGlobal || 0);
    let expectedPrevHash = SEED_SIGNATURE;

    if (firstSeqGlobal > 0) {
        const predecessor = await withTimeout(
            wixData
            .query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .lt("seqGlobal", firstSeqGlobal)
            .descending("seqGlobal")
            .limit(1)
            .find({ suppressAuth: true }),
            CMS_TIMEOUT_MS,
            "verifyIntegrityGlobalPredecessor"
        );
        expectedPrevHash = predecessor?.items?.[0]?.hashCadena || SEED_SIGNATURE;
    }

    for (let i = 0; i < items.length; i++) {
        const m = items[i];

        // 1) Global prevHash chain, including the predecessor from an earlier day.
        if (m.prevHash !== expectedPrevHash) {
            inconsistencies.push({ index: i, id: m._id, reason: "prevHash mismatch with global predecessor hashCadena" });
        }
        expectedPrevHash = m.hashCadena || "";

        // 2) hash + signature
        const payloadCanonico = m.integrityPayloadVersion === "LEDGER_V2" ?
            _canonicalPayloadV2(m) :
            _canonicalPayload(m.prevHash, m.transactionId, m.tipoMovimiento, m.importeContable, m.formaPago);
        const computedHashCadena = hashChain(m.prevHash, payloadCanonico);
        const computedFirma = hmacSha256Hex(fiscalKey, payloadCanonico);
        const firmaExpectedFull = `${computedFirma}|${computedHashCadena}`;

        if (m.hashCadena !== computedHashCadena) inconsistencies.push({ index: i, id: m._id, reason: "hashCadena mismatch" });
        if (m.firmaDigital !== firmaExpectedFull) inconsistencies.push({ index: i, id: m._id, reason: "signature mismatch" });

        // 3) ticket sequence
        if (m.numTicketFactura && typeof m.numTicketFactura === "string") {
            const parts = m.numTicketFactura.split("-");
            if (parts.length === 3) {
                const ticketNum = parseInt(parts[2], 10);
                if (!isNaN(ticketNum)) {
                    if (i === 0) expectedTicketNum = ticketNum;
                    else {
                        expectedTicketNum++;
                        if (ticketNum !== expectedTicketNum) {
                            inconsistencies.push({
                                index: i,
                                id: m._id,
                                reason: `Ticket number sequence mismatch: expected ${expectedTicketNum}, got ${ticketNum}`,
                            });
                        }
                    }
                }
            }
        }
    }

    const integrityOk = inconsistencies.length === 0;

    if (!integrityOk) {
        log.error("Integrity violation detected", { diaKey, inconsistenciesCount: inconsistencies.length, traceId });

        await withTimeout(
            wixData
            .insert(
                COLLECTIONS.AUDIT_LOG, {
                    _id: `ALERT_${String(diaKey)}_${Date.now()}`,
                    tipoEvento: "AUDIT_ALERT_INTEGRITY_VIOLATION",
                    level: "ERROR",
                    message: `Integrity violation day ${String(diaKey)}`,
                    data: { inconsistencies },
                    traceId,
                    fechaLog: new Date(),
                    resourceId: "SYSTEM",
                    source: "backend/cajas.web.js",
                }, { suppressAuth: true }
            )
            .catch(() => {}),
            CMS_TIMEOUT_MS,
            "insertAuditAlertIntegrity"
        ).catch(() => {});
    }

    return { integrityOk, inconsistencies, totalVerified: items.length };
}

// =============================================================================
// MOVEMENT REGISTRATION
// =============================================================================
export async function registerBookingPayment(bookingId, amount, paymentMethod, options = {}) {
    const traceId = options.traceId || makeTraceId("ledger");
    const lockOwnerId = String(traceId);

    try {
        const cleanAmount = Number(amount);
        if (!Number.isFinite(cleanAmount) || cleanAmount === 0) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Invalid amount", { traceId });
        }

        const normalizedMethod = String(paymentMethod || FORMA_PAGO.EFECTIVO).toUpperCase();

        if (normalizedMethod === String(FORMA_PAGO.ONLINE).toUpperCase() && !options.transactionId) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "ONLINE payments require transactionId", { traceId });
        }

        await _getCachedCashierSecret();

        // Acquire global mutex
        const lockResult = await _lockSlotKeyOrFail(LEDGER_MUTEX_KEY, lockOwnerId, LEDGER_MUTEX_TTL_MS);
        if (!lockResult?.ok) {
            throw createBookingError(ERROR_CODES.TOKEN_BUSY, "Ledger write busy, retry later", { traceId });
        }

        try {
            const { ultimoHash } = await _getUltimoHashYSecuencia();

            const tz = SDK_CONFIG?.TZ || "Europe/Madrid";
            const madridDateStr = new Date().toLocaleDateString("sv-SE", { timeZone: tz });
            const year = parseInt(madridDateStr.slice(0, 4), 10) || new Date().getFullYear();
            const pad = (n) => String(n).padStart(5, "0");

            const tipoMov = _resolveMovementType(normalizedMethod, cleanAmount, options.tipoMovimiento, traceId);
            const isRefund = tipoMov === TIPO_MOVIMIENTO.REEMBOLSO;
            const isTip = tipoMov === TIPO_MOVIMIENTO.PROPINA;
            const signo = isRefund ? -1 : 1;

            const absAmount = Math.abs(cleanAmount);
            const importeContable = absAmount * signo;
            const taxRate = isTip ? 0 : IVA_RATES.GENERAL;
            const baseImponible = isTip ? 0 : Number((absAmount / (1 + taxRate)).toFixed(2)) * signo;
            const cuotaIva = isTip ? 0 : Number((absAmount - Math.abs(baseImponible)).toFixed(2)) * signo;
            const naturalezaOperacion = _movementNature(tipoMov);
            const tratamientoIva = isTip ? "PROPINA_PENDIENTE_GESTORIA" : "IVA_GENERAL";

            const transIdRaw = options.transactionId || `TX_${traceId}_${Date.now()}`;
            const transId = _normalizeIdPart(transIdRaw, 120);
            const referenciaRectificativa = isRefund ? _normalizeIdPart(options.refundId || options.orderId || transId, 120) : null;
            const detalleLineas = _buildDocumentLines(options.concept || `${tipoMov} ${transId}`, absAmount, baseImponible, cuotaIva, taxRate);

            const seqResult = await _getNextSequenceNumbers(year, traceId);
            const numTicketFactura = `FAC-${year}-${pad(seqResult.nextYearSeq)}`;
            const seqGlobal = seqResult.nextGlobalSeq;

            const diaKey = options.diaKey || madridDateStr.substring(0, 10);
            const mesKey = options.mesKey || diaKey.substring(0, 7);

            const fiscalKey = await _getCachedCashierSecret();
            const nifEmisor = await _getCachedFiscalIssuerNif();

            const payloadCanonico = _canonicalPayloadV2({
                prevHash: ultimoHash,
                transactionId: transId,
                tipoMovimiento: tipoMov,
                importeContable,
                formaPago: normalizedMethod,
                baseImponible,
                cuotaIva,
                tasaIva: taxRate,
                naturalezaOperacion,
                tratamientoIva,
                referenciaRectificativa,
                detalleLineas,
            });
            const hashCadena = hashChain(ultimoHash, payloadCanonico);
            const firma = hmacSha256Hex(fiscalKey, payloadCanonico);
            const firmaDigital = `${firma}|${hashCadena}`;

            const recordId = `MOV_${_normalizeIdPart(diaKey, 10)}_${_normalizeIdPart(tipoMov, 15)}_${_normalizeIdPart(transId, 120)}`;
            const resourceId = options.resourceId ? _normalizeIdPart(options.resourceId, 80) : null;

            // Defensive post-mutex check
            const checkHash = await _getUltimoHashYSecuencia();
            if (checkHash.ultimoHash !== ultimoHash) {
                throw createBookingError(ERROR_CODES.FISCAL_SIGN_FAIL, "Ledger hash changed during mutex hold", {
                    traceId,
                    expected: ultimoHash,
                    actual: checkHash.ultimoHash,
                });
            }

            // Idempotency by recordId
            const existing = await withTimeout(
                wixData.get(COLLECTIONS.MOVIMIENTOS_CAJA, recordId, { suppressAuth: true }).catch(() => null),
                CMS_TIMEOUT_MS,
                "getExistingRecord"
            );

            if (existing) {
                log.info("Ledger idempotent duplicate", { recordId, transactionId: transId, traceId });
                return { status: "SUCCESS", data: { _id: recordId, idempotent: true }, error: null };
            }

            const movimiento = {
                _id: recordId,
                seqGlobal,
                tipoMovimiento: tipoMov,
                concepto: String(options.concept || `${tipoMov} ${transId}`).trim().slice(0, 500),
                origen: String(options.origen || "INTERNAL").trim().slice(0, 80),
                orderId: options.orderId ? _normalizeIdPart(options.orderId, 120) : null,
                refundId: options.refundId ? _normalizeIdPart(options.refundId, 120) : null,
                importeTotal: absAmount,
                signo,
                importeContable,
                baseImponible,
                cuotaIva,
                tasaIva: taxRate,
                naturalezaOperacion,
                tratamientoIva,
                referenciaRectificativa,
                detalleLineas,
                integrityPayloadVersion: "LEDGER_V2",
                nifEmisor,
                numTicketFactura,
                prevHash: ultimoHash,
                hashCadena,
                firmaDigital,
                formaPago: normalizedMethod,
                reservaIdVinculada: bookingId || null,
                transactionId: transId,
                resourceId,
                diaKey,
                mesKey,
                traceId: String(traceId),
                fechaCreacion: new Date(),
            };

            const result = await withTimeout(
                wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true }),
                CMS_TIMEOUT_MS,
                "registerBookingPaymentInsert"
            );

            // Early guard: project to accounting only when explicitly enabled
            if (SDK_CONFIG?.ACCOUNTING?.ENABLED === true) {
                try {
                    const accounting = await projectLedgerMovementToAccounting(result);
                    if (accounting?.status === "SKIPPED") {
                        log.info("Accounting projection intentionally skipped", {
                            recordId,
                            reason: accounting.reason,
                            traceId,
                        });
                    }
                } catch (accountingError) {
                    log.error("Accounting projection failed after immutable ledger insert", {
                        recordId,
                        traceId,
                        message: accountingError?.message || String(accountingError),
                    });
                }
            }

            try {
                await _upsertCurrentCashProjection(diaKey, { closed: false });
            } catch (projectionError) {
                log.warn("Current cash projection refresh failed after immutable ledger insert", {
                    recordId,
                    traceId,
                    message: projectionError?.message || String(projectionError),
                });
            }

            if (!nifEmisor) {
                log.warn("Ledger entry recorded without configured fiscal issuer NIF", { recordId, traceId });
            }

            // Early guard: enqueue to M365 only when explicitly enabled
            if (SDK_CONFIG?.M365?.ENABLED === true) {
                try {
                    await enqueueM365LedgerRecord(result, traceId);
                } catch (_) {
                    log.warn("M365 ledger projection enqueue failed", {
                        recordId,
                        traceId,
                        errorCode: "M365_GRAPH_QUEUE_ENQUEUE_FAILED",
                    });
                }
            }

            log.info("Ledger entry recorded", {
                recordId,
                numTicketFactura,
                importeContable,
                formaPago: normalizedMethod,
                tipoMov,
                bookingId,
                transactionId: transId,
                traceId,
            });

            return { status: "SUCCESS", data: result, error: null };
        } finally {
            await _unlockSlotKey(LEDGER_MUTEX_KEY, lockOwnerId).catch(() => {});
        }
    } catch (error) {
        const norm = normalizeError(error);
        log.error("Ledger write failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "LEDGER_WRITE_FAIL", message: norm.message || String(error) } };
    }
}

// =============================================================================
// INTERNAL Z CLOSING FOR SCHEDULED JOBS
// =============================================================================
function _buildZClosingSummary(diaKey, movements, integrity, source) {
    const items = [...(movements || [])].sort((a, b) => Number(a?.seqGlobal || 0) - Number(b?.seqGlobal || 0));
    const totalsByPayment = { efectivo: 0, tarjeta: 0, bizum: 0, online: 0 };
    const totalsByMovement = {};
    const totalsByVatRate = {};
    let totalVentas = 0;
    let totalReembolsos = 0;
    let totalPropinas = 0;
    let totalAjustes = 0;
    let baseImponibleNeta = 0;
    let cuotaIvaNeta = 0;

    for (const movement of items) {
        const amount = Number(movement?.importeContable) || 0;
        const base = Number(movement?.baseImponible) || 0;
        const vat = Number(movement?.cuotaIva) || 0;
        const payment = String(movement?.formaPago || "").toLowerCase();
        const type = String(movement?.tipoMovimiento || "AJUSTE").toUpperCase();
        const vatRate = String(Number(movement?.tasaIva) || 0);

        if (Object.prototype.hasOwnProperty.call(totalsByPayment, payment)) totalsByPayment[payment] += amount;
        totalsByMovement[type] = _roundMoney((totalsByMovement[type] || 0) + amount);
        if (!totalsByVatRate[vatRate]) totalsByVatRate[vatRate] = { baseImponible: 0, cuotaIva: 0, total: 0, operaciones: 0 };
        totalsByVatRate[vatRate].baseImponible = _roundMoney(totalsByVatRate[vatRate].baseImponible + base);
        totalsByVatRate[vatRate].cuotaIva = _roundMoney(totalsByVatRate[vatRate].cuotaIva + vat);
        totalsByVatRate[vatRate].total = _roundMoney(totalsByVatRate[vatRate].total + amount);
        totalsByVatRate[vatRate].operaciones++;
        baseImponibleNeta += base;
        cuotaIvaNeta += vat;
        if (type === TIPO_MOVIMIENTO.REEMBOLSO || amount < 0) totalReembolsos += amount;
        else if (type === TIPO_MOVIMIENTO.PROPINA) totalPropinas += amount;
        else if (type === TIPO_MOVIMIENTO.AJUSTE) totalAjustes += amount;
        else totalVentas += amount;
    }

    const first = items[0] || null;
    const last = items[items.length - 1] || null;
    const payload = {
        version: "Z_V2",
        diaKey: String(diaKey),
        timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
        source,
        seqInicio: Number(first?.seqGlobal || 0),
        seqFin: Number(last?.seqGlobal || 0),
        hashInicio: String(first?.prevHash || SEED_SIGNATURE),
        hashFin: String(last?.hashCadena || SEED_SIGNATURE),
        ticketInicio: String(first?.numTicketFactura || ""),
        ticketFin: String(last?.numTicketFactura || ""),
        totalEfectivo: _roundMoney(totalsByPayment.efectivo),
        totalTarjeta: _roundMoney(totalsByPayment.tarjeta),
        totalBizum: _roundMoney(totalsByPayment.bizum),
        totalOnline: _roundMoney(totalsByPayment.online),
        totalVentas: _roundMoney(totalVentas),
        totalReembolsos: _roundMoney(totalReembolsos),
        totalPropinas: _roundMoney(totalPropinas),
        totalAjustes: _roundMoney(totalAjustes),
        baseImponibleNeta: _roundMoney(baseImponibleNeta),
        cuotaIvaNeta: _roundMoney(cuotaIvaNeta),
        resumenTiposMovimiento: totalsByMovement,
        resumenTipoIva: totalsByVatRate,
        numOperaciones: items.length,
        integridadVerificada: Boolean(integrity?.integrityOk),
        totalRegistrosVerificados: Number(integrity?.totalVerified || 0),
    };

    return payload;
}

export async function _registerZClosingInternal(diaKey, options = {}) {
    const traceId = options.traceId || makeTraceId('z-closing-cron');
    try {
        if (!diaKey) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, 'diaKey required', { traceId });
        const zId = `Z_${String(diaKey)}`;
        const existingZ = await withTimeout(
            wixData.query(COLLECTIONS.HISTORICO_CIERRES_Z).eq('_id', zId).limit(1).find({ suppressAuth: true }),
            CMS_TIMEOUT_MS,
            'checkExistingZInternal'
        );
        if (existingZ?.items?.length) {
            return { status: 'SUCCESS', data: { ...existingZ.items[0], idempotent: true }, error: null };
        }
        const integrity = await _verifyIntegrityInternal(diaKey, { traceId });
        if (!integrity?.integrityOk) {
            throw createBookingError(ERROR_CODES.FISCAL_VIOLATION, 'Integrity violation in Z closing', { traceId });
        }
        const items = await _getAllDailyMovements(diaKey, { ascendingCreated: true });
        const source = options.autoCron ? "CRON" : "ADMIN";
        const summary = _buildZClosingSummary(diaKey, items, integrity, source);
        const fiscalKey = await _getCachedCashierSecret();
        const hashCierre = hashChain(summary.hashFin, JSON.stringify(summary));
        const firmaCierre = hmacSha256Hex(fiscalKey, hashCierre);
        const record = {
            _id: zId,
            diaKey: String(diaKey),
            ...summary,
            totalGeneral: _roundMoney(summary.totalEfectivo + summary.totalTarjeta + summary.totalBizum + summary.totalOnline),
            estado: CAJA_STATUS.CLOSED,
            fechaCierre: new Date(),
            fechaVerificacion: new Date(),
            hashCierre,
            firmaCierre,
            traceId
        };
        const result = await withTimeout(
            wixData.insert(COLLECTIONS.HISTORICO_CIERRES_Z, record, { suppressAuth: true }),
            CMS_TIMEOUT_MS,
            'insertZClosingInternal'
        );
        await _upsertCurrentCashProjection(diaKey, { closed: true });
        return { status: 'SUCCESS', data: result, error: null };
    } catch (error) {
        return { status: 'ERROR', data: null, error: _toPublicError(error, 'Z_CLOSING_FAIL') };
    }
}

// =============================================================================
// DURABLE FISCAL RECOVERY
// =============================================================================
const FISCAL_RECOVERY_KIND = "FISCAL_LEDGER";
const FISCAL_RECOVERY_MAX_RETRIES = Number(CONCURRENCY?.MAX_COMPENSATION_RETRIES) || 3;

async function _markCitasPaidAfterFiscalRecovery(bookingIds, orderId, traceId) {
    const ids = String(bookingIds || "").split(",").map((id) => id.trim()).filter(Boolean);
    for (const bookingId of ids) {
        try {
            const res = await withTimeout(
                wixData.query(COLLECTIONS.CITAS).eq("bookingId", bookingId).limit(1).find({ suppressAuth: true }),
                CMS_TIMEOUT_MS,
                "recoveryQueryCita"
            );
            const cita = res?.items?.[0];
            if (!cita) continue;
            const meta = cita.meta || {};
            const paymentState = String(meta[CITA_FIELDS.STATUS_PAGO] || cita[CITA_FIELDS.STATUS_PAGO] || "").toUpperCase();
            if (paymentState === ESTADO_PAGO.REFUNDED || paymentState === ESTADO_PAGO.PARTIALLY_REFUNDED) continue;

            const { _createdDate, _updatedDate, _owner, ...safeCita } = cita;
            await withTimeout(
                wixData.update(COLLECTIONS.CITAS, {
                    ...safeCita,
                    [CITA_FIELDS.STATUS]: ESTADO_CITA.CONFIRMED,
                    [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
                    fechaActualizacion: new Date(),
                    meta: {
                        ...meta,
                        [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
                        orderId: orderId || meta.orderId || null,
                        fechaRegistroFiscal: new Date(),
                    },
                }, { suppressAuth: true }),
                CMS_TIMEOUT_MS,
                "recoveryUpdateCitaPaid"
            );
        } catch (error) {
            log.error("Fiscal recovery could not finalize CitasF2 payment state", { bookingId, traceId, message: error?.message });
        }
    }
}

export async function queueFiscalRecovery(payload = {}) {
    const transactionId = _normalizeIdPart(payload.transactionId, 120);
    const bookingIds = String(payload.bookingIds || "").trim();
    const amount = Number(payload.amount);
    const paymentMethod = String(payload.paymentMethod || FORMA_PAGO.ONLINE).toUpperCase();
    const traceId = String(payload.traceId || makeTraceId("fiscal-recovery"));

    if (!transactionId || !Number.isFinite(amount) || amount === 0) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Invalid fiscal recovery payload", { traceId });
    }

    const recordId = `FISCAL_${transactionId}`;
    const existing = await wixData
        .get(COLLECTIONS.COMPENSATIONS, recordId, { suppressAuth: true, consistentRead: true })
        .catch(() => null);

    const now = new Date();
    const document = {
        ...(existing || {}),
        _id: recordId,
        kind: FISCAL_RECOVERY_KIND,
        status: "PENDING",
        attempts: Number(existing?.attempts || 0),
        bookingIds,
        amount,
        paymentMethod,
        transactionId,
        orderId: String(payload.orderId || existing?.orderId || ""),
        refundId: String(payload.refundId || existing?.refundId || ""),
        origin: String(payload.origin || existing?.origin || "FISCAL_RECOVERY"),
        concept: String(payload.concept || "Fiscal ledger recovery"),
        resourceId: String(payload.resourceId || "online"),
        tipoMovimiento: String(payload.tipoMovimiento || TIPO_MOVIMIENTO.VENTA_ONLINE),
        phase: String(payload.phase || existing?.phase || ""),
        traceId,
        lastError: String(payload.lastError || existing?.lastError || ""),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };

    if (existing) {
        await wixData.update(COLLECTIONS.COMPENSATIONS, document, { suppressAuth: true });
    } else {
        try {
            await wixData.insert(COLLECTIONS.COMPENSATIONS, document, { suppressAuth: true });
        } catch (error) {
            if (String(error?.message || "").includes("WDE0123") || String(error?.message || "").includes("WD_ITEM_ALREADY_EXISTS")) {
                return { status: "SUCCESS", data: { _id: recordId, idempotent: true }, error: null };
            }
            throw error;
        }
    }

    return { status: "SUCCESS", data: { _id: recordId, idempotent: !!existing }, error: null };
}

export async function processPendingFiscalRecoveries(options = {}) {
    const traceId = String(options.traceId || makeTraceId("fiscal-recovery-cron"));
    const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
    const result = await wixData
        .query(COLLECTIONS.COMPENSATIONS)
        .eq("kind", FISCAL_RECOVERY_KIND)
        .eq("status", "PENDING")
        .ascending("createdAt")
        .limit(limit)
        .find({ suppressAuth: true, consistentRead: true });

    let completed = 0;
    let failed = 0;
    for (const item of result?.items || []) {
        const waitForOriginal = String(item.phase || "") === "WAIT_FOR_ORIGINAL_ORDER_LEDGER";
        if (waitForOriginal) {
            const originalTransactionId = `ORDER-${String(item.orderId || "").trim()}`;
            const original = await wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", originalTransactionId).limit(1).find({ suppressAuth: true }).catch(() => ({ items: [] }));
            if (!original?.items?.length) continue;
        }

        const attempt = Number(item.attempts || 0) + 1;
        const ledger = await registerBookingPayment(item.bookingIds || null, item.amount, item.paymentMethod, {
            concept: item.concept,
            resourceId: item.resourceId,
            traceId: item.traceId || traceId,
            transactionId: item.transactionId,
            orderId: item.orderId || null,
            refundId: item.refundId || null,
            origen: item.origin || "FISCAL_RECOVERY",
            tipoMovimiento: item.tipoMovimiento,
        });

        const { _createdDate, _updatedDate, _owner, ...safeItem } = item;
        if (ledger?.status === "SUCCESS") {
            if (String(item.tipoMovimiento || "").toUpperCase() === TIPO_MOVIMIENTO.VENTA_ONLINE && String(item.bookingIds || "").trim()) {
                await _markCitasPaidAfterFiscalRecovery(item.bookingIds, item.orderId, item.traceId || traceId);
            }
            await wixData.update(COLLECTIONS.COMPENSATIONS, {
                ...safeItem,
                status: "COMPLETED",
                attempts: attempt,
                completedAt: new Date(),
                updatedAt: new Date(),
                lastError: "",
            }, { suppressAuth: true });
            completed++;
            continue;
        }

        const isTerminalFailure = attempt >= FISCAL_RECOVERY_MAX_RETRIES;
        const lastError = String(ledger?.error?.message || "FISCAL_RECOVERY_FAILED");
        await wixData.update(COLLECTIONS.COMPENSATIONS, {
            ...safeItem,
            status: isTerminalFailure ? "FAILED" : "PENDING",
            attempts: attempt,
            updatedAt: new Date(),
            lastError,
            ...(isTerminalFailure ? { alertRequired: true, failedAt: new Date() } : {}),
        }, { suppressAuth: true });
        if (isTerminalFailure) {
            log.error("Fiscal recovery exhausted retries and requires administrator review", { transactionId: item.transactionId, traceId: item.traceId || traceId, lastError });
        }
        failed++;
    }

    return { status: "SUCCESS", data: { completed, failed, scanned: result?.items?.length || 0 }, error: null };
}

// =============================================================================
// PUBLIC WEB METHODS
// =============================================================================
export const registerManualTransaction = webMethod(Permissions.SiteMember, async (payload = {}) => {
    const traceId = payload.traceId || makeTraceId("manual-tx");
    try {
        _rateLimitOrThrow("cajas.registerManualTransaction", "cashier", traceId);
        await requireCajero(traceId);

        const { amount, paymentMethod, tipoMovimiento, concept, resourceId = "TPV" } = payload;
        const normalizedMethod = String(paymentMethod || "").toUpperCase();
        const requestedType = String(tipoMovimiento || "").toUpperCase();
        const inferredType = _mapFormaPagoToTipoMovimiento(normalizedMethod, false);
        if (!inferredType || (requestedType && requestedType !== TIPO_MOVIMIENTO.PROPINA && requestedType !== inferredType)) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Manual movement type does not match payment method", { traceId });
        }

        const isTip = requestedType === TIPO_MOVIMIENTO.PROPINA;
        return await registerBookingPayment(null, amount, normalizedMethod, {
            concept: concept || (isTip ? "Propina TPV" : "Manual TPV"),
            resourceId,
            traceId,
            tipoMovimiento: isTip ? TIPO_MOVIMIENTO.PROPINA : inferredType,
            transactionId: `MANUAL_${traceId}_${Date.now()}`,
            origen: isTip ? "ONLY_STAFF_MANUAL_TIP" : "ONLY_STAFF_MANUAL",
        });
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "MANUAL_TX_FAIL") };
    }
});

export const registerXCount = webMethod(Permissions.SiteMember, async (diaKey, options = {}) => {
    const traceId = options.traceId || makeTraceId('x-count');
    try {
        _rateLimitOrThrow('cajas.registerXCount', 'cashier', traceId);
        await requireCajero(traceId);
        if (!diaKey) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, 'diaKey required', { traceId });
        const metalicoCaja = Number(options.metalicoCaja);
        if (!Number.isFinite(metalicoCaja) || metalicoCaja < 0) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, 'metalicoCaja must be a non-negative number', { traceId });
        }
        const movements = await _getAllDailyMovements(String(diaKey));
        const cashProjection = _buildCashierProjection(movements);
        const countedCash = _roundMoney(metalicoCaja);
        const totalEfectivoTeorico = cashProjection.saldoEfectivo;
        const descuadre = _roundMoney(countedCash - totalEfectivoTeorico);
        const record = {
            diaKey: String(diaKey),
            metalicoCaja: countedCash,
            totalEfectivoTeorico,
            descuadre,
            estadoCuadre: Math.abs(descuadre) < 0.01 ? "CUADRADO" : "DESCUADRE",
            fechaConteo: new Date(),
            fechaArqueo: new Date(),
            traceId
        };
        const result = await withTimeout(
            wixData.insert(COLLECTIONS.CONTEOS_X, record, { suppressAuth: true }),
            CMS_TIMEOUT_MS,
            'insertXCount'
        );
        return { status: 'SUCCESS', data: result, error: null };
    } catch (error) {
        return { status: 'ERROR', data: null, error: _toPublicError(error, 'X_COUNT_FAIL') };
    }
});

export const registerZClosing = webMethod(Permissions.Admin, async (diaKey, options = {}) => {
    const traceId = options.traceId || makeTraceId("z-closing");
    try {
        _rateLimitOrThrow("cajas.registerZClosing", "admin", traceId);
        await requireAdmin(traceId);
        if (!diaKey) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "diaKey required", { traceId });

        // The public and scheduled paths must create the same signed Z_V2 record.
        return await _registerZClosingInternal(String(diaKey), { traceId, autoCron: false });
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "Z_CLOSING_FAIL") };
    }
});

export const verifyIntegrity = webMethod(Permissions.Admin, async (diaKey, options = {}) => {
    const traceId = options.traceId || makeTraceId("verify-integrity");
    try {
        _rateLimitOrThrow("cajas.verifyIntegrity", "admin", traceId);
        await requireAdmin(traceId);
        const result = await _verifyIntegrityInternal(diaKey, { ...options, traceId });
        return { status: "SUCCESS", data: result, error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "VERIFY_INTEGRITY_FAIL") };
    }
});

export const getCashierState = webMethod(Permissions.SiteMember, async (options = {}) => {
    const traceId = options.traceId || makeTraceId("cashier-state");
    try {
        _rateLimitOrThrow("cajas.getCashierState", "cashier", traceId);
        await requireCajero(traceId);

        const tz = SDK_CONFIG?.TZ || "Europe/Madrid";
        const hoyStr = new Date().toLocaleString("sv-SE", { timeZone: tz });
        const diaKey = options.diaKey || hoyStr.substring(0, 10);

        const items = await _getAllDailyMovements(diaKey);
        const projection = _buildCashierProjection(items);

        return {
            status: "SUCCESS",
            data: { diaKey, ...projection },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "CASHIER_STATE_FAIL") };
    }
});