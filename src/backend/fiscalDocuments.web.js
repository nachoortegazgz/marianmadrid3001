/**
 * Paquetes de revision para gestoria.
 * No crea facturas ni declaraciones oficiales y no sustituye la revision fiscal profesional.
 */
import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";

import { COLLECTIONS, SDK_CONFIG, TIPO_MOVIMIENTO } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { requireMarianManager } from "backend/security";
import { hashSHA256 } from "backend/securityEngine";
import { makeTraceId } from "public/mmUtils";

const PACKAGE_CLASS = "PAQUETE_GESTORIA";
const EVENT_CREATED = "GESTORIA_DOCUMENT_CREATED";
const EVENT_SENT = "GESTORIA_DOCUMENT_SENT";
const EVENT_FAILED = "GESTORIA_DOCUMENT_FAILED";
const MAX_HISTORY_ROWS = 50;
const MAX_MOVEMENT_PAGES = 20;
const PAGE_SIZE = 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PDF_MAX_ROWS = 1200;
const PDF_LINES_PER_PAGE = 50;
const PDF_MAX_PAGES = 100;

function _safeText(value, max = 240) {
    return String(value ?? "").trim().replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function _money(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function _iso(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

function _assertPeriod(input = {}) {
    const year = Number(input?.year);
    const currentYear = new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2020 || year > currentYear + 1) {
        throw new Error("DOCUMENT_INVALID_PERIOD");
    }

    const hasMonth = input?.month !== undefined && input?.month !== null && input?.month !== "";
    const hasQuarter = input?.quarter !== undefined && input?.quarter !== null && input?.quarter !== "";
    if (hasMonth === hasQuarter) throw new Error("DOCUMENT_INVALID_PERIOD");

    if (hasMonth) {
        const month = Number(input.month);
        if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("DOCUMENT_INVALID_PERIOD");
        return { year, month, kind: "MENSUAL" };
    }

    const quarter = Number(input.quarter);
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        throw new Error("DOCUMENT_INVALID_PERIOD");
    }
    return { year, quarter, kind: "TRIMESTRAL" };
}

function _periodCode(period) {
    return period.kind === "MENSUAL" ? `M${String(period.month).padStart(2, "0")}` : `T${period.quarter}`;
}

function _periodLabel(period) {
    return period.kind === "MENSUAL"
        ? `${period.year}-${String(period.month).padStart(2, "0")}`
        : `${period.year}-T${period.quarter}`;
}

function _dateRange(period) {
    if (period.kind === "MENSUAL") {
        return {
            start: new Date(Date.UTC(period.year, period.month - 1, 1, 0, 0, 0)),
            end: new Date(Date.UTC(period.year, period.month, 1, 0, 0, 0)),
        };
    }
    const monthStart = (period.quarter - 1) * 3;
    return {
        start: new Date(Date.UTC(period.year, monthStart, 1, 0, 0, 0)),
        end: new Date(Date.UTC(period.year, monthStart + 3, 1, 0, 0, 0)),
    };
}

function _documentKey(period) {
    return `DOC_GESTORIA_${period.year}_${_periodCode(period)}_${PACKAGE_CLASS}`;
}

function _documentId(key, version) {
    return `${key}_V${String(version).padStart(4, "0")}`;
}

function _movementKind(movement) {
    const declared = _safeText(movement?.naturalezaOperacion, 30).toUpperCase();
    if (["VENTA", "DEVOLUCION", "PROPINA", "AJUSTE"].includes(declared)) return declared;
    const type = _safeText(movement?.tipoMovimiento, 60).toUpperCase();
    if (type === TIPO_MOVIMIENTO.PROPINA) return "PROPINA";
    if (type.includes("REEMBOLSO") || Number(movement?.importeContable) < 0) return "DEVOLUCION";
    if (type.includes("AJUSTE")) return "AJUSTE";
    return "VENTA";
}

function _toBookRow(movement) {
    const total = _money(movement?.importeContable ?? movement?.importeTotal);
    const base = _money(movement?.baseImponible ?? total - Number(movement?.cuotaIva || 0));
    const iva = _money(movement?.cuotaIva || 0);
    const naturaleza = _movementKind(movement);
    return {
        fecha: _iso(movement?.fechaCreacion || movement?._createdDate),
        numero: _safeText(movement?.numTicketFactura || movement?.transactionId, 120),
        naturaleza,
        tipoMovimiento: _safeText(movement?.tipoMovimiento, 60),
        tratamientoIva: _safeText(movement?.tratamientoIva, 80) || "PENDIENTE_VALIDACION",
        incluidoEnBorradorIva: naturaleza !== "PROPINA" && naturaleza !== "AJUSTE",
        referenciaRectificativa: _safeText(movement?.referenciaRectificativa, 120),
        detalleLineas: Array.isArray(movement?.detalleLineas) ? movement.detalleLineas.slice(0, 50) : [],
        formaPago: _safeText(movement?.formaPago, 40),
        concepto: _safeText(movement?.concepto, 180),
        baseImponible: base,
        cuotaIva: iva,
        importeTotal: total,
        hashCadena: _safeText(movement?.hashCadena, 64),
        transactionId: _safeText(movement?.transactionId, 120),
    };
}

function _summarize(rows) {
    const totals = {
        ventas: 0,
        devoluciones: 0,
        propinas: 0,
        ajustes: 0,
        baseImponible: 0,
        cuotaIva: 0,
        porFormaPago: {},
    };
    for (const row of rows) {
        const amount = _money(row.importeTotal);
        if (row.naturaleza === "DEVOLUCION") totals.devoluciones = _money(totals.devoluciones + amount);
        else if (row.naturaleza === "PROPINA") totals.propinas = _money(totals.propinas + amount);
        else if (row.naturaleza === "AJUSTE") totals.ajustes = _money(totals.ajustes + amount);
        else totals.ventas = _money(totals.ventas + amount);
        if (row.incluidoEnBorradorIva) {
            totals.baseImponible = _money(totals.baseImponible + row.baseImponible);
            totals.cuotaIva = _money(totals.cuotaIva + row.cuotaIva);
        }
        const payment = row.formaPago || "SIN_ESPECIFICAR";
        totals.porFormaPago[payment] = _money((totals.porFormaPago[payment] || 0) + amount);
    }
    return {
        ...totals,
        ventasNetas: _money(totals.ventas + totals.devoluciones),
        registros: rows.length,
        nota: "Las propinas se separan del resumen de IVA hasta la validacion de su tratamiento por la gestoria.",
    };
}

async function _findMovements(period) {
    const { start, end } = _dateRange(period);
    let result = await wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .ge("fechaCreacion", start)
        .lt("fechaCreacion", end)
        .ascending("fechaCreacion")
        .limit(PAGE_SIZE)
        .find();
    const items = [...result.items];
    let pages = 1;
    while (result.hasNext() && pages < MAX_MOVEMENT_PAGES) {
        result = await result.next();
        items.push(...result.items);
        pages += 1;
    }
    if (result.hasNext()) throw new Error("DOCUMENT_PERIOD_TOO_LARGE");
    return items;
}

function _csvEscape(value) {
    const raw = String(value ?? "");
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function _buildCsv(packageData) {
    const { period, generatedAt, summary, rows, documentId, version } = packageData;
    const lines = [
        ["DOCUMENTO", "PAQUETE DE REVISION PARA GESTORIA"],
        ["AVISO", "No es una factura, declaracion, modelo oficial ni prueba de cumplimiento regulatorio."],
        ["PERIODO", _periodLabel(period)],
        ["PERIODICIDAD", period.kind],
        ["VERSION", version],
        ["IDENTIFICADOR", documentId],
        ["GENERADO_UTC", generatedAt],
        ["REGISTROS", summary.registros],
        ["VENTAS_NETAS", summary.ventasNetas],
        ["BASE_IMPONIBLE", summary.baseImponible],
        ["CUOTA_IVA", summary.cuotaIva],
        ["PROPINAS_SEPARADAS", summary.propinas],
        [],
        ["FECHA_UTC", "NUMERO", "NATURALEZA", "TRATAMIENTO_IVA", "INCLUIDO_BORRADOR_IVA", "REFERENCIA_RECTIFICATIVA", "TIPO_MOVIMIENTO", "FORMA_PAGO", "CONCEPTO", "BASE_IMPONIBLE", "CUOTA_IVA", "IMPORTE_TOTAL", "LINEAS", "HASH_LEDGER", "TRANSACCION"],
        ...rows.map((row) => [
            row.fecha, row.numero, row.naturaleza, row.tratamientoIva, row.incluidoEnBorradorIva, row.referenciaRectificativa, row.tipoMovimiento, row.formaPago,
            row.concepto, row.baseImponible, row.cuotaIva, row.importeTotal, JSON.stringify(row.detalleLineas), row.hashCadena, row.transactionId,
        ]),
    ];
    return `\uFEFF${lines.map((line) => line.map(_csvEscape).join(",")).join("\r\n")}\r\n`;
}

function _pdfText(value, max = 110) {
    return _safeText(value, max)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\x20-\x7e]/g, "?")
        .replace(/[\\()]/g, "\\$&");
}

function _pdfMoney(value) {
    return _money(value).toFixed(2);
}

function _pdfRowLines(row) {
    const date = _safeText(row.fecha, 10);
    const number = _safeText(row.numero, 34);
    const payment = _safeText(row.formaPago, 14) || "SIN_PAGO";
    const concept = _safeText(row.concepto, 90) || "SIN_CONCEPTO";
    const reference = _safeText(row.referenciaRectificativa, 34) || "-";
    const transaction = _safeText(row.transactionId, 36) || "-";
    const hash = _safeText(row.hashCadena, 16) || "-";
    return [
        `${date} | ${number} | ${row.naturaleza} | ${payment}`,
        `Base ${_pdfMoney(row.baseImponible)} | IVA ${_pdfMoney(row.cuotaIva)} | Total ${_pdfMoney(row.importeTotal)} | ${concept}`,
        `Ref ${reference} | Tx ${transaction} | Hash ${hash}`,
    ];
}

function _buildPdf(packageData) {
    if (packageData.rows.length > PDF_MAX_ROWS) throw new Error("DOCUMENT_PDF_TOO_LARGE");
    const summary = packageData.summary;
    const fixedLines = [
        "MARIAN MADRID - PAQUETE DE REVISION PARA GESTORIA",
        "AVISO: documento de apoyo. No es factura, declaracion, modelo oficial ni prueba de cumplimiento.",
        `Periodo: ${_periodLabel(packageData.period)} (${packageData.period.kind})`,
        `Version: ${packageData.version || 0} | Identificador: ${packageData.documentId || "VISTA_PREVIA"}`,
        `Generado UTC: ${packageData.generatedAt}`,
        `Registros: ${summary.registros} | Ventas netas: ${_pdfMoney(summary.ventasNetas)} EUR`,
        `Base imponible: ${_pdfMoney(summary.baseImponible)} EUR | IVA: ${_pdfMoney(summary.cuotaIva)} EUR`,
        `Propinas separadas: ${_pdfMoney(summary.propinas)} EUR | Devoluciones: ${_pdfMoney(summary.devoluciones)} EUR`,
        "La gestoria debe completar gastos, retenciones y revisar los datos antes de cualquier presentacion.",
        "",
        "DETALLE DEL LEDGER",
    ];
    const detailLines = packageData.rows.flatMap(_pdfRowLines);
    const lines = [...fixedLines, ...detailLines];
    const pages = [];
    for (let index = 0; index < lines.length; index += PDF_LINES_PER_PAGE) {
        pages.push(lines.slice(index, index + PDF_LINES_PER_PAGE));
    }
    if (pages.length > PDF_MAX_PAGES) throw new Error("DOCUMENT_PDF_TOO_LARGE");

    const objects = [];
    const pageObjectStart = 4;
    const contentObjectStart = pageObjectStart + pages.length;
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    const pageRefs = pages.map((_, index) => `${pageObjectStart + index} 0 R`).join(" ");
    objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");

    pages.forEach((page, index) => {
        const contentObjectId = contentObjectStart + index;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`);
    });
    pages.forEach((page, index) => {
        const pageNumber = `Pagina ${index + 1}/${pages.length}`;
        const streamLines = [...page, "", pageNumber].map((line) => `(${_pdfText(line)}) Tj T*`).join("\n");
        const stream = `BT\n/F1 8 Tf\n40 800 Td\n11 TL\n${streamLines}\nET`;
        const bytes = Buffer.byteLength(stream, "latin1");
        objects.push(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`);
    });

    let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(output, "latin1"));
        output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(output, "latin1");
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
        output += `${String(offset).padStart(10, "0")} 00000 n \n`;
    });
    output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(output, "latin1");
}

async function _loadPackage(period, documentId = "", version = 0, generatedAt = "") {
    const movements = await _findMovements(period);
    const rows = movements.map(_toBookRow);
    const stableGeneratedAt = _iso(generatedAt) || new Date().toISOString();
    const packageData = {
        period,
        documentId,
        version,
        generatedAt: stableGeneratedAt,
        summary: _summarize(rows),
        rows,
    };
    const csv = _buildCsv(packageData);
    const pdf = _buildPdf(packageData);
    return {
        ...packageData,
        csv,
        pdf,
        contentHash: hashSHA256(csv),
        pdfHash: hashSHA256(pdf.toString("base64")),
        bytes: pdf.length,
        sourceBytes: Buffer.byteLength(csv, "utf8"),
    };
}

async function _historyForKey(documentKey) {
    const result = await wixData.query(COLLECTIONS.AUDIT_LOG)
        .eq("resourceId", documentKey)
        .descending("fechaLog")
        .limit(MAX_HISTORY_ROWS)
        .find();
    return result.items.filter((item) => [EVENT_CREATED, EVENT_SENT, EVENT_FAILED].includes(item?.tipoEvento));
}

function _publicHistory(items) {
    return items.map((item) => ({
        id: _safeText(item?._id, 120),
        event: _safeText(item?.tipoEvento, 80),
        at: _iso(item?.fechaLog || item?._createdDate),
        documentId: _safeText(item?.data?.documentId, 160),
        version: Number(item?.data?.version || 0),
        status: _safeText(item?.data?.status, 40),
        origin: _safeText(item?.data?.origin, 40),
        recipient: _safeText(item?.data?.recipient, 240),
        providerMessageId: _safeText(item?.data?.providerMessageId, 160),
        failureCode: _safeText(item?.data?.failureCode, 80),
        contentHash: _safeText(item?.data?.contentHash, 64),
        pdfHash: _safeText(item?.data?.pdfHash, 64),
    }));
}

async function _audit({ id = "", type, level, message, documentKey, data, traceId }) {
    await wixData.insert(COLLECTIONS.AUDIT_LOG, {
        ...(id ? { _id: id } : {}),
        tipoEvento: type,
        level,
        message: _safeText(message, 240),
        data,
        resourceId: documentKey,
        source: "fiscalDocuments",
        fechaLog: new Date(),
        traceId,
    });
}

function _assertEmail(value) {
    const email = _safeText(value, 240).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("DOCUMENT_INVALID_RECIPIENT");
    return email;
}

function _parseDocumentId(value) {
    const raw = _safeText(value, 180);
    const match = /^DOC_GESTORIA_(20\d{2}|21\d{2})_(T([1-4])|M(0[1-9]|1[0-2]))_PAQUETE_GESTORIA_V(\d{4})$/.exec(raw);
    if (!match) throw new Error("DOCUMENT_INVALID_VERSION");
    const month = match[4] ? Number(match[4]) : null;
    const quarter = match[3] ? Number(match[3]) : null;
    return {
        documentId: raw,
        documentKey: raw.replace(/_V\d{4}$/, ""),
        period: month ? { year: Number(match[1]), month, kind: "MENSUAL" } : { year: Number(match[1]), quarter, kind: "TRIMESTRAL" },
        version: Number(match[5]),
    };
}

function _filename(period, version) {
    return `paquete-gestoria-${_periodLabel(period)}-v${version}.pdf`;
}

function _resultPreview(packageData, history) {
    return {
        status: "PREVIEW",
        class: PACKAGE_CLASS,
        period: packageData.period,
        defaultRecipient: SDK_CONFIG.DOCUMENTS.DEFAULT_MANAGER_EMAIL,
        summary: packageData.summary,
        recordsPreview: packageData.rows.slice(0, 25),
        recordsTruncated: packageData.rows.length > 25,
        bytes: packageData.bytes,
        history: _publicHistory(history),
        disclaimer: "Paquete de revision para gestoria. No es una factura ni una autoliquidacion oficial; requiere validacion profesional antes de cualquier uso fiscal.",
    };
}

async function _createManagerPackageVersionInternal(period, { traceId, origin = "MANUAL" } = {}) {
    const documentKey = _documentKey(period);
    const history = await _historyForKey(documentKey);
    const automaticExists = origin === "AUTOMATIC_SCHEDULE" && history.some((item) => item?.tipoEvento === EVENT_CREATED && item?.data?.origin === "AUTOMATIC_SCHEDULE");
    if (automaticExists) {
        const item = history.find((entry) => entry?.tipoEvento === EVENT_CREATED && entry?.data?.origin === "AUTOMATIC_SCHEDULE");
        return {
            status: "ALREADY_PREPARED",
            documentId: _safeText(item?.data?.documentId, 160),
            version: Number(item?.data?.version || 0),
            period,
        };
    }
    const nextVersion = history.filter((item) => item?.tipoEvento === EVENT_CREATED).length + 1;
    const documentId = _documentId(documentKey, nextVersion);
    const packageData = await _loadPackage(period, documentId, nextVersion);
    await _audit({
        id: documentId,
        type: EVENT_CREATED,
        level: "INFO",
        message: origin === "AUTOMATIC_SCHEDULE" ? "Paquete documental preparado por tarea programada." : "Version de paquete para gestoria creada.",
        documentKey,
        data: {
            status: "CREADO",
            origin,
            documentId,
            version: nextVersion,
            period,
            contentHash: packageData.contentHash,
            pdfHash: packageData.pdfHash,
            generatedAt: packageData.generatedAt,
            bytes: packageData.bytes,
            records: packageData.summary.registros,
        },
        traceId,
    });
    return {
        status: "CREATED",
        class: PACKAGE_CLASS,
        documentId,
        filename: _filename(period, nextVersion),
        version: nextVersion,
        period,
        origin,
        contentHash: packageData.contentHash,
        pdfHash: packageData.pdfHash,
        bytes: packageData.bytes,
        summary: packageData.summary,
        disclaimer: "Version creada para revision. No se ha enviado ningun correo.",
    };
}

export async function prepareScheduledManagerPackages({ now = new Date(), traceId = makeTraceId("scheduled-manager-packages") } = {}) {
    const localDay = Number(new Intl.DateTimeFormat("en-GB", {
        timeZone: SDK_CONFIG.TZ,
        day: "2-digit",
    }).format(now));
    if (localDay !== 5) {
        return { status: "SKIPPED", data: { reason: "OUTSIDE_SCHEDULE_DAY" }, error: null };
    }
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: SDK_CONFIG.TZ,
        year: "numeric",
        month: "2-digit",
    }).formatToParts(now);
    const localYear = Number(parts.find((part) => part.type === "year")?.value);
    const localMonth = Number(parts.find((part) => part.type === "month")?.value);
    if (!Number.isInteger(localYear) || !Number.isInteger(localMonth)) throw new Error("DOCUMENT_SCHEDULE_DATE_INVALID");
    const previousMonth = localMonth === 1 ? 12 : localMonth - 1;
    const previousYear = localMonth === 1 ? localYear - 1 : localYear;
    const periods = [{ year: previousYear, month: previousMonth, kind: "MENSUAL" }];
    if ([3, 6, 9, 12].includes(previousMonth)) {
        periods.push({ year: previousYear, quarter: Math.ceil(previousMonth / 3), kind: "TRIMESTRAL" });
    }
    const prepared = [];
    for (const period of periods) {
        prepared.push(await _createManagerPackageVersionInternal(period, { traceId, origin: "AUTOMATIC_SCHEDULE" }));
    }
    return {
        status: "SUCCESS",
        data: {
            prepared,
            emailSent: false,
            recipient: SDK_CONFIG.DOCUMENTS.DEFAULT_MANAGER_EMAIL,
        },
        error: null,
    };
}

export const previewManagerPackage = webMethod(Permissions.Admin, async (input = {}) => {
    const traceId = makeTraceId("fiscal-document-preview");
    await requireMarianManager(traceId);
    const period = _assertPeriod(input);
    const documentKey = _documentKey(period);
    const [packageData, history] = await Promise.all([_loadPackage(period), _historyForKey(documentKey)]);
    return _resultPreview(packageData, history);
});

export const createManagerPackageVersion = webMethod(Permissions.Admin, async (input = {}) => {
    const traceId = makeTraceId("fiscal-document-create");
    await requireMarianManager(traceId);
    return _createManagerPackageVersionInternal(_assertPeriod(input), { traceId });
});

export const downloadManagerPackageVersion = webMethod(Permissions.Admin, async (input = {}) => {
    const traceId = makeTraceId("fiscal-document-download");
    await requireMarianManager(traceId);
    const identity = _parseDocumentId(input?.documentId);
    const history = await _historyForKey(identity.documentKey);
    const created = history.find((item) => item?.tipoEvento === EVENT_CREATED && item?.data?.documentId === identity.documentId);
    if (!created) throw new Error("DOCUMENT_NOT_FOUND");
    const packageData = await _loadPackage(
        identity.period,
        identity.documentId,
        identity.version,
        created?.data?.generatedAt,
    );
    if (packageData.contentHash !== _safeText(created?.data?.contentHash, 64)) {
        throw new Error("DOCUMENT_SOURCE_CHANGED");
    }
    if (packageData.pdfHash !== _safeText(created?.data?.pdfHash, 64)) {
        throw new Error("DOCUMENT_RENDER_CHANGED");
    }
    return {
        status: "READY",
        documentId: identity.documentId,
        filename: _filename(identity.period, identity.version),
        mimeType: "application/pdf",
        contentBase64: packageData.pdf.toString("base64"),
        contentHash: packageData.contentHash,
        pdfHash: packageData.pdfHash,
    };
});

export const getManagerPackageHistory = webMethod(Permissions.Admin, async (input = {}) => {
    const traceId = makeTraceId("fiscal-document-history");
    await requireMarianManager(traceId);
    const period = _assertPeriod(input);
    const documentKey = _documentKey(period);
    const history = await _historyForKey(documentKey);
    return {
        status: "OK",
        period,
        defaultRecipient: SDK_CONFIG.DOCUMENTS.DEFAULT_MANAGER_EMAIL,
        history: _publicHistory(history),
    };
});

export const getPreparedManagerPackages = webMethod(Permissions.Admin, async () => {
    const traceId = makeTraceId("fiscal-document-prepared");
    await requireMarianManager(traceId);
    const result = await wixData.query(COLLECTIONS.AUDIT_LOG)
        .eq("tipoEvento", EVENT_CREATED)
        .descending("fechaLog")
        .limit(MAX_HISTORY_ROWS)
        .find();
    const items = result.items
        .filter((item) => item?.source === "fiscalDocuments" && item?.data?.origin === "AUTOMATIC_SCHEDULE")
        .map((item) => ({
            documentId: _safeText(item?.data?.documentId, 160),
            version: Number(item?.data?.version || 0),
            period: item?.data?.period || null,
            at: _iso(item?.fechaLog || item?._createdDate),
            contentHash: _safeText(item?.data?.contentHash, 64),
            pdfHash: _safeText(item?.data?.pdfHash, 64),
            bytes: Number(item?.data?.bytes || 0),
            records: Number(item?.data?.records || 0),
        }))
        .filter((item) => item.documentId && item.period)
        .slice(0, 20);
    return { status: "OK", items, traceId };
});

export const emailManagerPackageVersion = webMethod(Permissions.Admin, async (input = {}) => {
    const traceId = makeTraceId("fiscal-document-email");
    await requireMarianManager(traceId);
    if (input?.confirmed !== true) throw new Error("DOCUMENT_SEND_CONFIRMATION_REQUIRED");
    const recipient = _assertEmail(input?.recipient || SDK_CONFIG.DOCUMENTS.DEFAULT_MANAGER_EMAIL);
    const identity = _parseDocumentId(input?.documentId);
    const history = await _historyForKey(identity.documentKey);
    const created = history.find((item) => item?.tipoEvento === EVENT_CREATED && item?.data?.documentId === identity.documentId);
    if (!created) throw new Error("DOCUMENT_NOT_FOUND");

    const packageData = await _loadPackage(
        identity.period,
        identity.documentId,
        identity.version,
        created?.data?.generatedAt,
    );
    if (packageData.contentHash !== _safeText(created?.data?.contentHash, 64)) {
        throw new Error("DOCUMENT_SOURCE_CHANGED");
    }
    if (packageData.pdfHash !== _safeText(created?.data?.pdfHash, 64)) {
        throw new Error("DOCUMENT_RENDER_CHANGED");
    }
    if (packageData.bytes > SDK_CONFIG.DOCUMENTS.MAX_EMAIL_ATTACHMENT_BYTES) {
        throw new Error("DOCUMENT_ATTACHMENT_TOO_LARGE");
    }

    const deliveryKey = hashSHA256(`${identity.documentId}|${recipient}|${packageData.contentHash}|${packageData.pdfHash}`);
    const alreadySent = history.some((item) => item?.tipoEvento === EVENT_SENT && item?.data?.deliveryKey === deliveryKey);
    if (alreadySent) {
        return {
            status: "ALREADY_SENT",
            documentId: identity.documentId,
            recipient,
            message: "Esta version ya consta como enviada a ese destinatario.",
        };
    }

    const [apiKey, from] = await Promise.all([
        getSecret(SECRETS.RESEND_API_KEY),
        getSecret(SECRETS.RESEND_FROM_EMAIL),
    ]);
    const safeApiKey = _safeText(apiKey, 500);
    const sender = _safeText(from, 240).toLowerCase();
    if (!safeApiKey || !EMAIL_RE.test(sender)) {
        throw new Error("DOCUMENT_EMAIL_NOT_CONFIGURED");
    }

    const filename = _filename(identity.period, identity.version);
    let response;
    try {
        response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${safeApiKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `marian-${deliveryKey.slice(0, 56)}`,
            },
            body: JSON.stringify({
                from: sender,
                to: [recipient],
                subject: `Paquete de revision para gestoria ${_periodLabel(identity.period)} v${identity.version}`,
                text: "Adjunto se remite el paquete PDF de revision solicitado desde ADMINISTRACION. No es una declaracion ni factura oficial.",
                attachments: [{ filename, content: packageData.pdf.toString("base64") }],
                tags: [
                    { name: "source", value: "administracion" },
                    { name: "document", value: "paquete_gestoria_pdf" },
                ],
            }),
        });
    } catch (_) {
        await _audit({
            type: EVENT_FAILED,
            level: "WARN",
            message: "No fue posible contactar con el proveedor de correo.",
            documentKey: identity.documentKey,
            data: { status: "FALLIDO", documentId: identity.documentId, version: identity.version, recipient, deliveryKey, failureCode: "PROVIDER_UNAVAILABLE" },
            traceId,
        });
        throw new Error("DOCUMENT_EMAIL_DELIVERY_FAILED");
    }

    if (!response.ok) {
        await _audit({
            type: EVENT_FAILED,
            level: "WARN",
            message: "El proveedor de correo rechazo la solicitud documental.",
            documentKey: identity.documentKey,
            data: { status: "FALLIDO", documentId: identity.documentId, version: identity.version, recipient, deliveryKey, failureCode: `PROVIDER_HTTP_${response.status}` },
            traceId,
        });
        throw new Error("DOCUMENT_EMAIL_DELIVERY_FAILED");
    }

    let providerMessageId = "";
    try {
        const body = await response.json();
        providerMessageId = _safeText(body?.id, 160);
    } catch (_) {
        providerMessageId = "";
    }
    await _audit({
        type: EVENT_SENT,
        level: "INFO",
        message: "Paquete PDF para gestoria aceptado por el proveedor de correo.",
        documentKey: identity.documentKey,
        data: {
            status: "ENVIADO",
            documentId: identity.documentId,
            version: identity.version,
            recipient,
            deliveryKey,
            contentHash: packageData.contentHash,
            pdfHash: packageData.pdfHash,
            providerMessageId,
        },
        traceId,
    });
    return {
        status: "SENT",
        documentId: identity.documentId,
        recipient,
        providerMessageId,
        message: "El proveedor ha aceptado el correo para su entrega.",
    };
});
