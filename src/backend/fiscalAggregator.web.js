/**
 * =============================================================================
 * FILE: backend/fiscalAggregator.web.js
 * VERSION: v19.6.16-fiscal-aggregator-aeat
 * RESPONSIBILITY: Produces tax-review summaries and an internal supporting
 *                 ledger extract from the immutable financial ledger.
 *                 Outputs require professional review and are not official filings.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import {
    COLLECTIONS,
    SDK_CONFIG,
    TIPO_MOVIMIENTO
} from "backend/internalConfig";
import {
    makeTraceId,
    withTimeout,
    _safeTrim
} from "public/mmUtils";
import {
    requireAdmin,
    requireCajero,
    rateLimiter
} from "backend/security";
import { logger } from "backend/booking/bookingCore";

const log = logger;
const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
const MAX_PAGES = Number(SDK_CONFIG?.JOBS?.FISCAL_DAILY_MAX_PAGES) || 10;

function _toPublicError(err, fallbackCode = "FISCAL_ERROR", fallbackMessage = "Error en agregacion fiscal") {
    return { code: String(err?.code || fallbackCode), message: String(err?.message || fallbackMessage) };
}

function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
        e.code = "RATE_LIMITED";
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

function _getQuarterMonths(year, quarter) {
    const y = Number(year);
    const q = Number(quarter);
    if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) return [];

    const monthMap = {
        1: ["01", "02", "03"],
        2: ["04", "05", "06"],
        3: ["07", "08", "09"],
        4: ["10", "11", "12"]
    };

    return monthMap[q].map((m) => `${y}-${m}`);
}

async function _queryAllQuarterMovements(months, traceId) {
    if (!Array.isArray(months) || months.length === 0) return [];

    let allItems = [];
    const query = wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .hasSome("mesKey", months)
        .ascending("seqGlobal")
        .limit(1000);

    let res = await withTimeout(query.find({ suppressAuth: true }), CMS_TIMEOUT_MS, "queryQuarterMovements_p1");
    allItems = allItems.concat(res?.items || []);

    let page = 2;
    while (res && res.hasNext() && page <= MAX_PAGES) {
        res = await withTimeout(res.next(), CMS_TIMEOUT_MS, `queryQuarterMovements_p${page}`);
        allItems = allItems.concat(res?.items || []);
        page++;
    }

    if (res?.hasNext()) {
        const error = new Error("Quarterly fiscal movement query reached configured page cap");
        error.code = "FISCAL_RESULT_TRUNCATED";
        error.meta = { maxPages: MAX_PAGES, itemCount: allItems.length, traceId };
        throw error;
    }

    return allItems;
}

export const getQuarterlyTaxSummary = webMethod(Permissions.SiteMember, async (year, quarter, options = {}) => {
    const traceId = options.traceId || makeTraceId("tax-303");
    try {
        _rateLimitOrThrow("fiscal.getQuarterlyTaxSummary", "staff", traceId);
        await requireCajero(traceId);

        const y = Number(year);
        const q = Number(quarter);
        if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "year and quarter (1-4) are required." } };
        }

        const months = _getQuarterMonths(y, q);
        const items = await _queryAllQuarterMovements(months, traceId);

        let totalBaseImponible = 0;
        let totalCuotaIva = 0;
        let totalFacturado = 0;
        let totalVentas = 0;
        let totalReembolsos = 0;
        let totalPropinas = 0;
        let totalAjustes = 0;
        let countVentas = 0;
        let countReembolsos = 0;
        let countPropinas = 0;
        let countAjustes = 0;
        let countFiscal = 0;

        const breakdownByPaymentMethod = {
            efectivo: 0,
            tarjeta: 0,
            bizum: 0,
            online: 0
        };

        const breakdownByMonth = {};
        const breakdownByVatRate = {};
        months.forEach((m) => {
            breakdownByMonth[m] = { baseImponible: 0, cuotaIva: 0, total: 0, count: 0 };
        });

        for (const m of items) {
            const importeContable = Number(m.importeContable) || 0;
            const base = Number(m.baseImponible) || 0;
            const cuota = Number(m.cuotaIva) || 0;
            const mes = _safeTrim(m.mesKey);
            const formaPago = _safeTrim(m.formaPago).toLowerCase();
            const tasaIva = Number(m.tasaIva) || 0;
            const tasaIvaKey = String(tasaIva);
            const tipoMovimiento = _safeTrim(m.tipoMovimiento).toUpperCase();
            const naturaleza = _safeTrim(m.naturalezaOperacion).toUpperCase() || (tipoMovimiento === TIPO_MOVIMIENTO.PROPINA ? "PROPINA" : tipoMovimiento === TIPO_MOVIMIENTO.REEMBOLSO || importeContable < 0 ? "DEVOLUCION" : tipoMovimiento === TIPO_MOVIMIENTO.AJUSTE ? "AJUSTE" : "VENTA");

            if (breakdownByPaymentMethod[formaPago] !== undefined) {
                breakdownByPaymentMethod[formaPago] += importeContable;
            }
            if (naturaleza === "PROPINA") {
                totalPropinas += importeContable;
                countPropinas++;
                continue;
            }
            if (naturaleza === "AJUSTE") {
                totalAjustes += importeContable;
                countAjustes++;
                continue;
            }

            countFiscal++;
            totalBaseImponible += base;
            totalCuotaIva += cuota;
            totalFacturado += importeContable;

            if (naturaleza === "VENTA") {
                totalVentas += importeContable;
                countVentas++;
            } else {
                totalReembolsos += importeContable;
                countReembolsos++;
            }

            if (breakdownByMonth[mes]) {
                breakdownByMonth[mes].baseImponible += base;
                breakdownByMonth[mes].cuotaIva += cuota;
                breakdownByMonth[mes].total += importeContable;
                breakdownByMonth[mes].count++;
            }

            if (!breakdownByVatRate[tasaIvaKey]) {
                breakdownByVatRate[tasaIvaKey] = { tasaIva, baseImponible: 0, cuotaIva: 0, total: 0, operaciones: 0 };
            }
            breakdownByVatRate[tasaIvaKey].baseImponible += base;
            breakdownByVatRate[tasaIvaKey].cuotaIva += cuota;
            breakdownByVatRate[tasaIvaKey].total += importeContable;
            breakdownByVatRate[tasaIvaKey].operaciones++;
        }

        const round2 = (num) => Math.round((Number(num) || 0) * 100) / 100;

        return {
            status: "SUCCESS",
            data: {
                ejercicio: y,
                trimestre: q,
                periodoMeses: months,
                                    totalOperaciones: items.length,
                    totalOperacionesFiscales: countFiscal,
                    conteo: {
                        ventas: countVentas,
                        reembolsos: countReembolsos,
                        propinas: countPropinas,
                        ajustes: countAjustes
                    },
                    borradorIva: {
                        estado: "REVISION_PROFESIONAL_REQUERIDA",
                        baseImponibleRegistrada: round2(totalBaseImponible),
                        cuotaIvaRegistrada: round2(totalCuotaIva),
                        nota: "No es un Modelo 303 ni una declaracion preparada para presentar. Los tipos y el regimen deben ser validados por la gestoria."
                    },
                    borradorIngresos: {
                        estado: "REVISION_PROFESIONAL_REQUERIDA",
                        ingresosRegistrados: round2(totalBaseImponible),
                        nota: "No es un Modelo 130 ni una declaracion preparada para presentar."
                    },
                    totales: {
                        totalVentasBrutas: round2(totalVentas),
                        totalReembolsos: round2(totalReembolsos),
                        totalFacturadoNeto: round2(totalFacturado),
                        totalPropinasSeparadas: round2(totalPropinas),
                        totalAjustesSeparados: round2(totalAjustes)
                    },

                desgloseFormaPago: {
                    efectivo: round2(breakdownByPaymentMethod.efectivo),
                    tarjeta: round2(breakdownByPaymentMethod.tarjeta),
                    bizum: round2(breakdownByPaymentMethod.bizum),
                    online: round2(breakdownByPaymentMethod.online)
                },
                desgloseMensual: Object.keys(breakdownByMonth).map((mesKey) => ({
                    mesKey,
                    baseImponible: round2(breakdownByMonth[mesKey].baseImponible),
                    cuotaIva: round2(breakdownByMonth[mesKey].cuotaIva),
                    total: round2(breakdownByMonth[mesKey].total),
                    operaciones: breakdownByMonth[mesKey].count
                })),
                desgloseTipoIva: Object.values(breakdownByVatRate).map((item) => ({
                    tasaIva: item.tasaIva,
                    baseImponible: round2(item.baseImponible),
                    cuotaIva: round2(item.cuotaIva),
                    total: round2(item.total),
                    operaciones: item.operaciones
                }))
            },
            error: null
        };
    } catch (err) {
        log.error("getQuarterlyTaxSummary failed", { error: err?.message, traceId });
        return { status: "ERROR", data: null, error: _toPublicError(err, "TAX_SUMMARY_FAIL") };
    }
});

export const getLibroRegistroFacturasExpedidas = webMethod(Permissions.Admin, async (year, quarter, options = {}) => {
    const traceId = options.traceId || makeTraceId("libro-registro");
    try {
        _rateLimitOrThrow("fiscal.getLibroRegistroFacturasExpedidas", "admin", traceId);
        await requireAdmin(traceId);

        const y = Number(year);
        const q = Number(quarter);
        if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "year and quarter (1-4) are required." } };
        }

        const months = _getQuarterMonths(y, q);
        const items = await _queryAllQuarterMovements(months, traceId);

        const libroFilas = items.map((m, idx) => ({
            orden: idx + 1,
            numTicketFactura: _safeTrim(m.numTicketFactura),
            fechaExpedicion: _safeTrim(m.diaKey),
            tipoFactura: m.tipoMovimiento === "REEMBOLSO" || Number(m.importeContable) < 0 ? "R1" : "BORRADOR_INTERNO",
            tipoMovimiento: _safeTrim(m.tipoMovimiento),
            naturalezaOperacion: _safeTrim(m.naturalezaOperacion) || "VENTA",
            tratamientoIva: _safeTrim(m.tratamientoIva) || "PENDIENTE_VALIDACION",
            incluidoEnBorradorIva: _safeTrim(m.naturalezaOperacion).toUpperCase() !== "PROPINA" && _safeTrim(m.naturalezaOperacion).toUpperCase() !== "AJUSTE",
            referenciaRectificativa: _safeTrim(m.referenciaRectificativa) || null,
            formaPago: _safeTrim(m.formaPago),
            baseImponible: Number(m.baseImponible) || 0,
            tipoIva: `${Math.round((Number(m.tasaIva) || 0) * 100)}%`,
            cuotaIva: Number(m.cuotaIva) || 0,
            importeTotal: Number(m.importeContable) || 0,
            concepto: _safeTrim(m.concepto),
            origen: _safeTrim(m.origen),
            orderId: _safeTrim(m.orderId) || null,
            refundId: _safeTrim(m.refundId) || null,
            fechaHoraRegistro: m.fechaCreacion || null,
            huellaSha256: _safeTrim(m.hashCadena).slice(0, 8).toUpperCase(),
            hashCompleto: _safeTrim(m.hashCadena),
            reservaVinculada: _safeTrim(m.reservaIdVinculada) || null,
            transactionId: _safeTrim(m.transactionId)
        }));

        return {
            status: "SUCCESS",
            data: {
                ejercicio: y,
                trimestre: q,
                totalRegistros: libroFilas.length,
                filas: libroFilas
            },
            error: null
        };
    } catch (err) {
        log.error("getLibroRegistroFacturasExpedidas failed", { error: err?.message, traceId });
        return { status: "ERROR", data: null, error: _toPublicError(err, "LIBRO_REGISTRO_FAIL") };
    }
});
