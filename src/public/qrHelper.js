/**
 * =============================================================================
 * FILE: public/qrHelper.js
 * VERSION: v19.6.16-verifactu-qr-generator
 * RESPONSIBILITY: Builds internal verification URL and receipt metadata from
 *                 configured issuer data and persisted ledger evidence.
 * NOTE: Does not certify regulatory compliance or replace fiscal validation.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import { _safeTrim } from "public/mmUtils";

const VERIFACTU_BASE_URL = "https://sede.agenciatributaria.gob.es/verifactu/consulta";

export function extractHuella8(hashCadena) {
    const raw = _safeTrim(hashCadena);
    return raw.length >= 8 ? raw.slice(0, 8).toUpperCase() : "";
}

export function generateVerifactuUrl(params = {}) {
    const nif = _safeTrim(params.nifEmisor);
    const num = _safeTrim(params.numTicket || params.numTicketFactura);
    const fechaRaw = _safeTrim(params.fechaIso || params.diaKey);
    const fecha = fechaRaw.slice(0, 10);
    const impNum = Number(params.importeTotal);
    const huella = extractHuella8(params.hashCadena);
    if (!nif || !num || !fecha || !Number.isFinite(impNum) || !huella) return "";

    const queryParts = [
        `nif=${encodeURIComponent(nif)}`,
        `num=${encodeURIComponent(num)}`,
        `fecha=${encodeURIComponent(fecha)}`,
        `imp=${encodeURIComponent(Math.abs(impNum).toFixed(2))}`,
        `h=${encodeURIComponent(huella)}`
    ];

    return `${VERIFACTU_BASE_URL}?${queryParts.join("&")}`;
}

export function buildVerifactuReceiptMeta(movimiento = {}) {
    const numTicket = _safeTrim(movimiento.numTicketFactura || movimiento.numTicket);
    const fechaIso = _safeTrim(movimiento.diaKey || movimiento.fechaCreacion || new Date().toISOString());
    const importeTotal = Number(movimiento.importeTotal || movimiento.importeContable || 0);
    const hashCadena = _safeTrim(movimiento.hashCadena);
    const nifEmisor = _safeTrim(movimiento.nifEmisor);

    const qrUrl = generateVerifactuUrl({
        nifEmisor,
        numTicket,
        fechaIso,
        importeTotal,
        hashCadena
    });

    const huella8 = extractHuella8(hashCadena);

    return {
        nifEmisor,
        numTicketFactura: numTicket,
        fechaExpedicion: fechaIso.slice(0, 10),
        importeTotal: Math.abs(importeTotal),
        baseImponible: Number(movimiento.baseImponible) || 0,
        cuotaIva: Number(movimiento.cuotaIva) || 0,
        tasaIva: `${Math.round((Number(movimiento.tasaIva) || 0) * 100)}%`,
        huellaVerifactu: huella8,
        configuracionFiscalCompleta: Boolean(nifEmisor && numTicket && hashCadena),
        hashCompleto: hashCadena,
        qrVerificationUrl: qrUrl,
        leyendaFiscal: "Borrador tecnico de metadatos de recibo; requiere configuracion y validacion fiscal antes de su uso regulado."
    };
}
