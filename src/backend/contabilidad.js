/**
 * =============================================================================
 * MODULE: backend/contabilidad.js
 * RESPONSIBILITY: Idempotent accounting journal projection from immutable cash
 * ledger movements. Projection stays disabled until an approved account map
 * exists in PLAN_CUENTAS_CONTABLES.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";

import { COLLECTIONS, SDK_CONFIG, TIPO_MOVIMIENTO } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { hmacSha256Hex, hashChain } from "backend/securityEngine";

const MONEY_EPSILON = 0.005;

function _roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function _cleanText(value, maxLength = 500) {
    return String(value || "").trim().slice(0, maxLength);
}

function _normalizeDate(value) {
    const parsed = value instanceof Date ? value : new Date(value || Date.now());
    return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function _toFiscalKeys(date) {
    const local = date.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
    return {
        diaKey: local.slice(0, 10),
        ejercicioFiscal: Number(local.slice(0, 4)),
        periodoFiscal: local.slice(5, 7),
    };
}

function _linePayload(line) {
    return [
        line.idLineaAsiento,
        line.idAsiento,
        line.numeroLinea,
        line.codigoCuentaContable,
        line.importeDebe,
        line.importeHaber,
        line.baseImponible,
        line.tipoIva,
        line.cuotaIva,
        line.idTraza,
    ].join("|");
}

function _asAccountingLine(base, number, accountCode, accountName, debit, credit, tax) {
    const line = {
        _id: `${base.idAsiento}_L${String(number).padStart(3, "0")}`,
        idLineaAsiento: `${base.idAsiento}_L${String(number).padStart(3, "0")}`,
        idAsiento: base.idAsiento,
        numeroLinea: number,
        fechaOperacion: base.fechaOperacion,
        codigoCuentaContable: accountCode,
        nombreCuentaContable: accountName,
        grupoCuentaContable: "",
        importeDebe: _roundMoney(debit),
        importeHaber: _roundMoney(credit),
        importeNeto: _roundMoney(debit - credit),
        categoriaOperacion: base.categoriaOperacion,
        idCentroCoste: base.idCentroCoste || null,
        idResponsableOperativo: base.idResponsableOperativo || null,
        codigoProductoServicio: null,
        descripcionLinea: base.conceptoAsiento,
        baseImponible: tax?.baseImponible ?? null,
        tipoIva: tax?.tipoIva ?? null,
        cuotaIva: tax?.cuotaIva ?? null,
        claveOperacionIva: null,
        nifContraparte: null,
        nombreContraparte: null,
        referenciaExterna: base.referenciaExterna || null,
        idTraza: base.idTraza,
        fechaHoraRegistro: base.fechaHoraRegistro,
    };
    line.hashLinea = hashChain(base.hashOrigen, _linePayload(line));
    return line;
}

function _isApprovedMap(map) {
    return Boolean(map?.activa) && Boolean(map?.validadaPorGestoria) &&
        _cleanText(map?.codigoCuentaDebePredeterminada, 40) &&
        _cleanText(map?.nombreCuentaDebePredeterminada, 120) &&
        _cleanText(map?.codigoCuentaHaberPredeterminada, 40) &&
        _cleanText(map?.nombreCuentaHaberPredeterminada, 120);
}

async function _findAccountMap(tipoMovimiento) {
    const result = await wixData
        .query(COLLECTIONS.PLAN_CUENTAS_CONTABLES)
        .eq("categoriaOperacion", String(tipoMovimiento || "").toUpperCase())
        .eq("activa", true)
        .limit(1)
        .find({ suppressAuth: true });
    return result?.items?.[0] || null;
}

async function _getExisting(id) {
    return await wixData.get(COLLECTIONS.ASIENTOS_CONTABLES, id, { suppressAuth: true }).catch(() => null);
}

async function _insertLineIfMissing(line) {
    const existing = await wixData.get(COLLECTIONS.LINEAS_ASIENTO_CONTABLE, line._id, { suppressAuth: true }).catch(() => null);
    if (existing) return { idempotent: true };
    await wixData.insert(COLLECTIONS.LINEAS_ASIENTO_CONTABLE, line, { suppressAuth: true });
    return { idempotent: false };
}

function _buildBase(movimiento) {
    const fechaOperacion = _normalizeDate(movimiento?.fechaCreacion);
    const keys = _toFiscalKeys(fechaOperacion);
    const idAsiento = `ASIENTO_${_cleanText(movimiento?._id, 120)}`;
    return {
        idAsiento,
        numeroAsiento: Number(movimiento?.seqGlobal || 0),
        ejercicioFiscal: keys.ejercicioFiscal,
        periodoFiscal: keys.periodoFiscal,
        fechaOperacion,
        fechaHoraRegistro: new Date(),
        zonaHorariaOperacion: SDK_CONFIG?.TZ || "Europe/Madrid",
        tipoAsiento: String(movimiento?.tipoMovimiento || "AJUSTE").toUpperCase(),
        categoriaOperacion: String(movimiento?.tipoMovimiento || "AJUSTE").toUpperCase(),
        subcategoriaOperacion: null,
        conceptoAsiento: _cleanText(movimiento?.concepto || movimiento?.tipoMovimiento || "Movimiento de caja"),
        origenRegistro: _cleanText(movimiento?.origen || "MOVIMIENTO_CAJA", 80),
        idOrigen: _cleanText(movimiento?._id, 120),
        idTransaccion: _cleanText(movimiento?.transactionId, 120),
        idPedidoWix: _cleanText(movimiento?.orderId, 120) || null,
        idDevolucionWix: _cleanText(movimiento?.refundId, 120) || null,
        idReservaWix: _cleanText(movimiento?.reservaIdVinculada, 120) || null,
        referenciaExterna: _cleanText(movimiento?.numTicketFactura, 120) || null,
        serieFactura: null,
        numeroFactura: _cleanText(movimiento?.numTicketFactura, 120) || null,
        fechaExpedicionFactura: fechaOperacion,
        fechaOperacionFiscal: fechaOperacion,
        tipoFactura: null,
        idAsientoRectificado: null,
        motivoRectificacion: null,
        moneda: "EUR",
        importeTotalDocumento: Math.abs(Number(movimiento?.importeContable) || 0),
        medioPago: _cleanText(movimiento?.formaPago, 40) || null,
        estadoAsiento: "CONFIRMADO",
        idResponsableOperativo: _cleanText(movimiento?.resourceId, 120) || null,
        idMiembroRegistrador: "SYSTEM_FISCAL_LEDGER",
        nombreRegistrador: "SISTEMA_FISCAL",
        idCentroCoste: null,
        codigoActividadIae: null,
        versionEsquema: "ASIENTO_V1",
        versionAlgoritmoIntegridad: "HMAC_SHA256_V1",
        hashAnterior: _cleanText(movimiento?.hashCadena, 64),
        hashOrigen: _cleanText(movimiento?.hashCadena, 64),
        idTraza: _cleanText(movimiento?.traceId, 120),
    };
}

function _buildLines(base, movimiento, map) {
    const signedTotal = Number(movimiento?.importeContable) || 0;
    const total = Math.abs(signedTotal);
    const vat = Math.abs(Number(movimiento?.cuotaIva) || 0);
    const net = _roundMoney(total - vat);
    const rate = Number(movimiento?.tasaIva);
    const baseTax = { baseImponible: Math.abs(Number(movimiento?.baseImponible) || 0), tipoIva: Number.isFinite(rate) ? rate : null, cuotaIva: vat || null };

    if (total <= MONEY_EPSILON || net < -MONEY_EPSILON || vat > total + MONEY_EPSILON) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_AMOUNT");
    }

    const lines = [];
    const isRefund = signedTotal < 0;
    const requiresVatLine = vat > MONEY_EPSILON;
    const vatCode = _cleanText(map?.codigoCuentaIvaRepercutido, 40);
    const vatName = _cleanText(map?.nombreCuentaIvaRepercutido, 120);

    if (requiresVatLine && (!vatCode || !vatName)) {
        throw new Error("ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT");
    }

    if (!isRefund) {
        lines.push(_asAccountingLine(base, 1, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, total, 0, null));
        lines.push(_asAccountingLine(base, 2, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, 0, net, baseTax));
        if (requiresVatLine) lines.push(_asAccountingLine(base, 3, vatCode, vatName, 0, vat, baseTax));
    } else {
        lines.push(_asAccountingLine(base, 1, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, net, 0, baseTax));
        if (requiresVatLine) lines.push(_asAccountingLine(base, 2, vatCode, vatName, vat, 0, baseTax));
        lines.push(_asAccountingLine(base, requiresVatLine ? 3 : 2, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, 0, total, null));
    }

    const totalDebe = _roundMoney(lines.reduce((sum, line) => sum + Number(line.importeDebe || 0), 0));
    const totalHaber = _roundMoney(lines.reduce((sum, line) => sum + Number(line.importeHaber || 0), 0));
    if (Math.abs(totalDebe - totalHaber) > MONEY_EPSILON) throw new Error("ACCOUNTING_PROJECTION_UNBALANCED");
    return { lines, totalDebe, totalHaber };
}

export async function projectLedgerMovementToAccounting(movimiento) {
    const sourceId = _cleanText(movimiento?._id, 120);
    if (!sourceId || !movimiento?.hashCadena || !movimiento?.transactionId) {
        return { status: "SKIPPED", reason: "INVALID_SOURCE_LEDGER" };
    }
    if (movimiento?.tipoMovimiento === TIPO_MOVIMIENTO.PROPINA || movimiento?.tratamientoIva === "PROPINA_PENDIENTE_GESTORIA") {
        return { status: "SKIPPED", reason: "TIP_TREATMENT_PENDING_PROFESSIONAL_REVIEW" };
    }
    if (SDK_CONFIG?.ACCOUNTING?.ENABLED !== true) {
        return { status: "SKIPPED", reason: "ACCOUNTING_DISABLED" };
    }

    const base = _buildBase(movimiento);
    const existing = await _getExisting(base.idAsiento);
    if (existing) return { status: "SUCCESS", idempotent: true, idAsiento: base.idAsiento };

    const map = await _findAccountMap(base.categoriaOperacion);
    if (!_isApprovedMap(map)) return { status: "SKIPPED", reason: "NO_APPROVED_ACCOUNT_MAP" };

    const projected = _buildLines(base, movimiento, map);
    for (const line of projected.lines) await _insertLineIfMissing(line);

    const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
    if (!fiscalKey) throw new Error("ACCOUNTING_PROJECTION_SIGNING_KEY_MISSING");

    const headerPayload = [
        base.idAsiento,
        base.numeroAsiento,
        base.idOrigen,
        base.idTransaccion,
        projected.totalDebe,
        projected.totalHaber,
        ...projected.lines.map((line) => line.hashLinea),
    ].join("|");
    const hashAsiento = hashChain(base.hashOrigen, headerPayload);
    const firmaAsiento = `${hmacSha256Hex(fiscalKey, headerPayload)}|${hashAsiento}`;
    const header = {
        ...base,
        totalDebe: projected.totalDebe,
        totalHaber: projected.totalHaber,
        hashAsiento,
        firmaAsiento,
    };
    delete header.hashOrigen;

    await wixData.insert(COLLECTIONS.ASIENTOS_CONTABLES, header, { suppressAuth: true });
    return { status: "SUCCESS", idempotent: false, idAsiento: base.idAsiento, lineCount: projected.lines.length };
}

export function isAccountingProjectionError(error) {
    return String(error?.message || error || "").startsWith("ACCOUNTING_PROJECTION_");
}
