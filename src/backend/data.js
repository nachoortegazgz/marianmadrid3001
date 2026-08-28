/**
 * =============================================================================
 * MODULE: backend/data.js
 * VERSION: v20.0.0-canonical-cache-and-hooks
 * RESPONSIBILITY: CMS data hooks for canonical dates, immutable fiscal records,
 *                 and immutable labor records with private staff resolution.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import wixData from "wix-data";
import {
    getMadridLocalStringNoZ,
} from "public/mmUtils";
import {
    COLLECTIONS,
    SINGLETONS,
    TIPO_FICHAJE,
    TIPO_MOVIMIENTO,
    CITA_FIELDS,
    ESTADO_CITA,
    SERVICE_CATALOG,
} from "backend/internalConfig";
import { clearStaffCache, findStaff } from "backend/staff";
import { enqueueBookingsServiceSync } from "backend/bookingsServiceSync";

const CAJA_ACTUAL_ID = SINGLETONS.CAJA;
const DUAL_CACHE_COL = COLLECTIONS.DUAL_CACHE;
const DAYS_CACHE_COL = COLLECTIONS.DAYS_CACHE;
const SLOTS_CACHE_COL = COLLECTIONS.SLOTS_CACHE;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function _toDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
}

function _normalizeDateField(item, field, fallback) {
    const date = _toDate(item[field]);
    item[field] = date || fallback;
}

const SERVICE_STATES = new Set(SERVICE_CATALOG.STATES);
const SERVICE_CATEGORIES = new Set(SERVICE_CATALOG.CATEGORIES);

function _normalizeCatalogReference(value) {
    const candidate = value && typeof value === "object" ? (value._id || value.id) : value;
    return String(candidate || "").trim().toUpperCase();
}

function _normalizeBoundedText(item, field, maxLength) {
    if (item[field] === undefined || item[field] === null) return;
    const normalized = String(item[field]).trim();
    if (normalized.length > maxLength) {
        throw new Error(`SERVICE_VALIDATION: ${field} exceeds the permitted length.`);
    }
    item[field] = normalized;
}

function _readDuration(item, field) {
    const raw = item[field];
    if (raw === undefined || raw === null || raw === "") return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > SERVICE_CATALOG.MAX_DURATION_MINUTES) {
        throw new Error(`SERVICE_VALIDATION: ${field} must be between 0 and ${SERVICE_CATALOG.MAX_DURATION_MINUTES}.`);
    }
    return value;
}

function _validateServiceCatalog(item, context) {
    if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;

    _normalizeBoundedText(item, "tituloServicio", SERVICE_CATALOG.MAX_TITLE_LENGTH);
    _normalizeBoundedText(item, "resumenCorto", SERVICE_CATALOG.MAX_SUMMARY_LENGTH);
    _normalizeBoundedText(item, "descripcionLarga", SERVICE_CATALOG.MAX_DESCRIPTION_LENGTH);

    const estado = _normalizeCatalogReference(item.estado);
    if (estado) {
        if (!SERVICE_STATES.has(estado)) {
            throw new Error("SERVICE_VALIDATION: estado must be selected from the approved catalog.");
        }
        item.estado = estado;
    }

    const categoria = _normalizeCatalogReference(item.categoria);
    if (categoria) {
        if (!SERVICE_CATEGORIES.has(categoria)) {
            throw new Error("SERVICE_VALIDATION: categoria must be selected from the approved catalog.");
        }
        item.categoria = categoria;
    }

    const moneda = _normalizeCatalogReference(item.monedaCatalogo || item.moneda);
    if (moneda && moneda !== SERVICE_CATALOG.CURRENCY) {
        throw new Error("SERVICE_VALIDATION: only EUR is supported by this catalog.");
    }

    if (item.precio !== undefined && item.precio !== null && item.precio !== "") {
        const precio = Number(item.precio);
        if (!Number.isFinite(precio) || precio < 0) {
            throw new Error("SERVICE_VALIDATION: precio must be a non-negative number.");
        }
        item.precio = Math.round(precio * 100) / 100;
    }

    if (item.personalDisponible !== undefined && !Array.isArray(item.personalDisponible)) {
        throw new Error("SERVICE_VALIDATION: personalDisponible must be a staff reference array.");
    }

    if (item.permitirCombinar !== undefined && typeof item.permitirCombinar !== "boolean") {
        throw new Error("SERVICE_VALIDATION: permitirCombinar must be boolean.");
    }
    const permitirCombinar = item.permitirCombinar === true;
    const tiempoFase1 = _readDuration(item, "tiempoFase1");
    const tiempoExposicion = _readDuration(item, "tiempoExposicion");
    const tiempoFase2 = _readDuration(item, "tiempoFase2");

    if (permitirCombinar) {
        const linkFases = String(item.linkFases || "").trim();
        if (!GUID_RE.test(linkFases)) {
            throw new Error("SERVICE_VALIDATION: a valid phase-two service is required for combined services.");
        }
        if (tiempoFase1 <= 0 || tiempoFase2 <= 0) {
            throw new Error("SERVICE_VALIDATION: combined services require positive phase durations.");
        }
        item.linkFases = linkFases;
    }

    const duracionSimple = tiempoFase1 || Number(item.duracionMinutos || item.duration || 0);
    const total = permitirCombinar ? tiempoFase1 + tiempoExposicion + tiempoFase2 : duracionSimple;
    if (!Number.isFinite(total) || total < 0 || total > SERVICE_CATALOG.MAX_DURATION_MINUTES) {
        throw new Error("SERVICE_VALIDATION: total duration is invalid.");
    }
    item.duracionTotal = Math.round(total * 100) / 100;
    return item;
}

export function Import2_beforeInsert(item, context) {
    return _validateServiceCatalog(item, context);
}

export function Import2_beforeUpdate(item, context) {
    return _validateServiceCatalog(item, context);
}

function _validateMapaStaff(item, context) {
    if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;
    const resourceId = String(item.resourceId || "").trim();
    if (!GUID_RE.test(resourceId)) throw new Error("STAFF_VALIDATION: resourceId must be a valid Bookings resource GUID.");
    item.resourceId = resourceId;

    _normalizeBoundedText(item, "nombreVisible", 80);
    if (!item.nombreVisible) throw new Error("STAFF_VALIDATION: nombreVisible is required.");
    _normalizeBoundedText(item, "memberId", 120);
    _normalizeBoundedText(item, "email", 254);
    _normalizeBoundedText(item, "scheduleId", 120);
    _normalizeBoundedText(item, "rol", 60);
    if (item.email) item.email = item.email.toLowerCase();
    if (!item.memberId && !item.email) throw new Error("STAFF_VALIDATION: memberId or email is required.");
    if (item.activo !== undefined && typeof item.activo !== "boolean") {
        throw new Error("STAFF_VALIDATION: activo must be boolean.");
    }
    item.activo = item.activo !== false;
    item.updatedAt = new Date();
    return item;
}

export function MapaStaff_beforeInsert(item, context) {
    return _validateMapaStaff(item, context);
}

export function MapaStaff_beforeUpdate(item, context) {
    return _validateMapaStaff(item, context);
}

export function MapaStaff_afterInsert(item) {
    clearStaffCache();
    return item;
}

export function MapaStaff_afterUpdate(item) {
    clearStaffCache();
    return item;
}

export function MapaStaff_afterRemove(itemId) {
    clearStaffCache();
    return itemId;
}

export function CitasF2_beforeInsert(item, context) {
    if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;

    const bookingId = String(item.bookingId || "").trim();
    if (!bookingId) throw new Error("CITAS_VIOLATION: Missing bookingId.");
    item.bookingId = bookingId;

    const now = new Date();
    _normalizeDateField(item, "startDate", null);
    _normalizeDateField(item, "endDate", null);
    _normalizeDateField(item, "fechaCreacion", now);
    _normalizeDateField(item, "fechaActualizacion", now);

    if (!item.fechaYmdMadrid && item.startDate) {
        item.fechaYmdMadrid = getMadridLocalStringNoZ(item.startDate).slice(0, 10);
    }

    item[CITA_FIELDS.STATUS] = String(item[CITA_FIELDS.STATUS] || ESTADO_CITA.CONFIRMED).toUpperCase();
    item[CITA_FIELDS.STATUS_PAGO] = String(item[CITA_FIELDS.STATUS_PAGO] || "UNPAID").toUpperCase();
    return item;
}

async function _removeCollectionItemsByServiceId(collectionId, fields, serviceId) {
    const cleanServiceId = String(serviceId || "").trim();
    if (!GUID_RE.test(cleanServiceId)) return;

    const matches = await Promise.allSettled(
        fields.map((field) => wixData.query(collectionId).eq(field, cleanServiceId).limit(1000).find({ suppressAuth: true }))
    );
    const ids = new Set(
        matches
        .filter((result) => result.status === "fulfilled")
        .flatMap((result) => result.value?.items || [])
        .map((item) => item?._id)
        .filter(Boolean)
    );
    await Promise.allSettled(
        [...ids].map((itemId) => wixData.remove(collectionId, itemId, { suppressAuth: true }))
    );
}

async function _invalidateServiceCaches(serviceId) {
    await Promise.allSettled([
        _removeCollectionItemsByServiceId(DUAL_CACHE_COL, ["serviceId", "phaseOneServiceId", "phaseTwoServiceId"], serviceId),
        _removeCollectionItemsByServiceId(DAYS_CACHE_COL, ["serviceId", "phaseOneServiceId"], serviceId),
        _removeCollectionItemsByServiceId(SLOTS_CACHE_COL, ["phaseOneServiceId"], serviceId),
    ]);
}

async function _enqueueBookingsServiceSyncSafely(item) {
    if (item?.bookingsSyncEnabled !== true) return null;
    try {
        return await enqueueBookingsServiceSync(item);
    } catch (_) {
        console.warn("Bookings service synchronization could not be queued.");
        return null;
    }
}

export async function Import2_afterInsert(item, context) {
    if (!item || context?.suppressHooks === true) return item;
    await _enqueueBookingsServiceSyncSafely(item);
    return item;
}

export async function Import2_afterUpdate(item, context) {
    if (!item || context?.suppressHooks === true) return item;
    await _invalidateServiceCaches(item.serviceId);
    await _invalidateServiceCaches(item.linkFases);
    await _enqueueBookingsServiceSyncSafely(item);
    return item;
}

export function DualSlotCache_beforeInsert(item, context) {
    if (!item || typeof item !== "object") return item;
    item.status = String(item.status || "ACTIVE").toUpperCase();
    _normalizeDateField(item, "createdAt", new Date());
    if (item.expiresAt) _normalizeDateField(item, "expiresAt", null);
    return item;
}

export function DualSlotCache_beforeUpdate(item, context) {
    if (!item || typeof item !== "object") return item;
    item.status = String(item.status || "ACTIVE").toUpperCase();
    _normalizeDateField(item, "updatedAt", new Date());
    if (item.expiresAt) _normalizeDateField(item, "expiresAt", null);
    return item;
}

export function cajaActual_beforeInsert(item) {
    if (item && typeof item === "object") item._id = CAJA_ACTUAL_ID;
    return item;
}

export function cajaActual_beforeUpdate(item) {
    if (item && typeof item === "object") item._id = CAJA_ACTUAL_ID;
    return item;
}

export function cajaActual_beforeRemove(_itemId) {
    throw new Error("SINGLETON_PROTECTED: Direct deletion of cajaActual is forbidden.");
}

function _expectedMovementNature(tipoMovimiento) {
    if (tipoMovimiento === TIPO_MOVIMIENTO.PROPINA) return "PROPINA";
    if (tipoMovimiento === TIPO_MOVIMIENTO.REEMBOLSO) return "DEVOLUCION";
    if (tipoMovimiento === TIPO_MOVIMIENTO.AJUSTE) return "AJUSTE";
    return "VENTA";
}

function _assertLedgerDocumentDetail(item) {
    const tipoMovimiento = String(item.tipoMovimiento || "").trim().toUpperCase();
    if (!Object.values(TIPO_MOVIMIENTO).includes(tipoMovimiento)) {
        throw new Error("FISCAL_VIOLATION: Unsupported tipoMovimiento.");
    }
    const expectedNature = _expectedMovementNature(tipoMovimiento);
    if (String(item.naturalezaOperacion || "").trim().toUpperCase() !== expectedNature) {
        throw new Error("FISCAL_VIOLATION: naturalezaOperacion does not match tipoMovimiento.");
    }

    const isTip = tipoMovimiento === TIPO_MOVIMIENTO.PROPINA;
    const expectedTaxTreatment = isTip ? "PROPINA_PENDIENTE_GESTORIA" : "IVA_GENERAL";
    if (String(item.tratamientoIva || "").trim().toUpperCase() !== expectedTaxTreatment) {
        throw new Error("FISCAL_VIOLATION: tratamientoIva does not match tipoMovimiento.");
    }
    if (isTip && (Number(item.baseImponible) !== 0 || Number(item.cuotaIva) !== 0 || Number(item.tasaIva) !== 0)) {
        throw new Error("FISCAL_VIOLATION: Tips must not include VAT before professional review.");
    }
    if (tipoMovimiento === TIPO_MOVIMIENTO.REEMBOLSO && !String(item.referenciaRectificativa || "").trim()) {
        throw new Error("FISCAL_VIOLATION: Refunds require referenciaRectificativa.");
    }

    const lines = Array.isArray(item.detalleLineas) ? item.detalleLineas : [];
    if (item.integrityPayloadVersion !== "LEDGER_V2" || !lines.length || lines.length > 50) {
        throw new Error("FISCAL_VIOLATION: Missing or invalid signed document detail.");
    }
    const totals = lines.reduce((acc, line) => ({
        base: acc.base + (Number(line?.baseImponible) || 0),
        tax: acc.tax + (Number(line?.cuotaIva) || 0),
        total: acc.total + (Number(line?.importeTotal) || 0),
    }), { base: 0, tax: 0, total: 0 });
    if (Math.abs(totals.base - (Number(item.baseImponible) || 0)) > 0.01 ||
        Math.abs(totals.tax - (Number(item.cuotaIva) || 0)) > 0.01 ||
        Math.abs(totals.total - Math.abs(Number(item.importeTotal) || 0)) > 0.01) {
        throw new Error("FISCAL_VIOLATION: Signed document detail totals do not match ledger totals.");
    }
}

export function movimientoCaja_beforeInsert(item, context) {
    if (!item || typeof item !== "object") return item;

    if (!SHA256_HEX_RE.test(String(item.hashCadena || "").trim())) {
        throw new Error("FISCAL_VIOLATION: Missing or invalid hashCadena format.");
    }
    if (!SHA256_HEX_RE.test(String(item.prevHash || "").trim())) {
        throw new Error("FISCAL_VIOLATION: Missing or invalid prevHash format.");
    }

    const signatureParts = String(item.firmaDigital || "").trim().split("|");
    if (signatureParts.length !== 2 || !SHA256_HEX_RE.test(signatureParts[0]) || !SHA256_HEX_RE.test(signatureParts[1])) {
        throw new Error("FISCAL_VIOLATION: Invalid firmaDigital format.");
    }
    if (!String(item.numTicketFactura || "").trim()) {
        throw new Error("FISCAL_VIOLATION: Missing numTicketFactura.");
    }
    _assertLedgerDocumentDetail(item);

    _normalizeDateField(item, "fechaCreacion", new Date());
    return item;
}

export function movimientoCaja_beforeUpdate(_item) {
    throw new Error("FISCAL_VIOLATION: Direct updates to movimientoCaja are forbidden.");
}

export function movimientoCaja_beforeRemove(_itemId) {
    throw new Error("FISCAL_VIOLATION: Direct removals from movimientoCaja are forbidden.");
}

export async function REGISTRO_HORARIO_beforeInsert(item, context) {
    if (!item || typeof item !== "object") return item;

    const staff = await findStaff(item.resourceId);
    if (!staff) {
        throw new Error("INVALID_EMPLOYEE: Employee resourceId is not registered in MAPA_STAFF.");
    }

    const tipoFichaje = String(item.tipoFichaje || "").toUpperCase();
    if (!Object.values(TIPO_FICHAJE).includes(tipoFichaje)) {
        throw new Error(`INVALID_CLOCK_TYPE: Tipo de fichaje invalido "${tipoFichaje}".`);
    }
    if (tipoFichaje === TIPO_FICHAJE.AJUSTE && !String(item.motivoAjuste || "").trim()) {
        throw new Error("INVALID_CLOCK_ADJUSTMENT: motivoAjuste is required for manual adjustments.");
    }

    const now = new Date();
    const fechaHora = _toDate(item.fechaHora) || now;
    if (fechaHora.getTime() > now.getTime() + 60000) {
        throw new Error("INVALID_TIMESTAMP: Future timestamps are forbidden.");
    }

    const madrid = getMadridLocalStringNoZ(fechaHora);
    item.resourceId = staff.resourceId;
    item.resourceName = staff.displayName;
    item.tipoFichaje = tipoFichaje;
    item.fechaHora = fechaHora;
    item.fechaCreacion = now;
    item.diaKey = madrid.slice(0, 10);
    item.mesKey = madrid.slice(0, 7);
    item.hora = madrid.slice(11, 19);
    return item;
}

export function REGISTRO_HORARIO_beforeUpdate(_item) {
    throw new Error("LABOR_LOG_VIOLATION: Direct updates to REGISTRO_HORARIO are forbidden.");
}

export function REGISTRO_HORARIO_beforeRemove(_itemId) {
    throw new Error("LABOR_LOG_VIOLATION: Direct removals from REGISTRO_HORARIO are forbidden.");
}

function _assertMoney(value, field) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0) {
        throw new Error(`ACCOUNTING_VIOLATION: Invalid ${field}.`);
    }
}

function _assertSignedHashSignature(hash, signature, hashField) {
    if (!SHA256_HEX_RE.test(String(hash || "").trim())) {
        throw new Error(`ACCOUNTING_VIOLATION: Missing or invalid ${hashField}.`);
    }
    const parts = String(signature || "").trim().split("|");
    if (parts.length !== 2 || !SHA256_HEX_RE.test(parts[0]) || !SHA256_HEX_RE.test(parts[1])) {
        throw new Error("ACCOUNTING_VIOLATION: Invalid accounting signature.");
    }
}

export function ASIENTOS_CONTABLES_beforeInsert(item, context) {
    if (!item || typeof item !== "object") return item;
    if (!String(item.idAsiento || "").trim() || !String(item.idTransaccion || "").trim()) {
        throw new Error("ACCOUNTING_VIOLATION: Missing accounting identity.");
    }
    if (!Number.isInteger(Number(item.numeroAsiento)) || Number(item.numeroAsiento) <= 0) {
        throw new Error("ACCOUNTING_VIOLATION: Invalid numeroAsiento.");
    }
    _assertMoney(item.totalDebe, "totalDebe");
    _assertMoney(item.totalHaber, "totalHaber");
    if (Math.abs(Number(item.totalDebe) - Number(item.totalHaber)) > 0.005) {
        throw new Error("ACCOUNTING_VIOLATION: Unbalanced accounting header.");
    }
    if (!SHA256_HEX_RE.test(String(item.hashAnterior || "").trim())) {
        throw new Error("ACCOUNTING_VIOLATION: Missing or invalid hashAnterior.");
    }
    _assertSignedHashSignature(item.hashAsiento, item.firmaAsiento, "hashAsiento");
    _normalizeDateField(item, "fechaOperacion", new Date());
    _normalizeDateField(item, "fechaHoraRegistro", new Date());
    return item;
}

export function ASIENTOS_CONTABLES_beforeUpdate(_item) {
    throw new Error("ACCOUNTING_VIOLATION: Direct updates to ASIENTOS_CONTABLES are forbidden.");
}

export function ASIENTOS_CONTABLES_beforeRemove(_itemId) {
    throw new Error("ACCOUNTING_VIOLATION: Direct removals from ASIENTOS_CONTABLES are forbidden.");
}

export function LINEAS_ASIENTO_CONTABLE_beforeInsert(item, context) {
    if (!item || typeof item !== "object") return item;
    if (!String(item.idLineaAsiento || "").trim() || !String(item.idAsiento || "").trim()) {
        throw new Error("ACCOUNTING_VIOLATION: Missing accounting line identity.");
    }
    if (!Number.isInteger(Number(item.numeroLinea)) || Number(item.numeroLinea) <= 0) {
        throw new Error("ACCOUNTING_VIOLATION: Invalid numeroLinea.");
    }
    _assertMoney(item.importeDebe, "importeDebe");
    _assertMoney(item.importeHaber, "importeHaber");
    const debit = Number(item.importeDebe);
    const credit = Number(item.importeHaber);
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
        throw new Error("ACCOUNTING_VIOLATION: Every accounting line requires one nonzero side.");
    }
    if (!SHA256_HEX_RE.test(String(item.hashLinea || "").trim())) {
        throw new Error("ACCOUNTING_VIOLATION: Missing or invalid hashLinea.");
    }
    _normalizeDateField(item, "fechaOperacion", new Date());
    _normalizeDateField(item, "fechaHoraRegistro", new Date());
    return item;
}

export function LINEAS_ASIENTO_CONTABLE_beforeUpdate(_item) {
    throw new Error("ACCOUNTING_VIOLATION: Direct updates to LINEAS_ASIENTO_CONTABLE are forbidden.");
}

export function LINEAS_ASIENTO_CONTABLE_beforeRemove(_itemId) {
    throw new Error("ACCOUNTING_VIOLATION: Direct removals from LINEAS_ASIENTO_CONTABLE are forbidden.");
}

export function EVENTOS_SISTEMA_FACTURACION_beforeUpdate(_item) {
    throw new Error("ACCOUNTING_VIOLATION: Direct updates to EVENTOS_SISTEMA_FACTURACION are forbidden.");
}

export function EVENTOS_SISTEMA_FACTURACION_beforeRemove(_itemId) {
    throw new Error("ACCOUNTING_VIOLATION: Direct removals from EVENTOS_SISTEMA_FACTURACION are forbidden.");
}