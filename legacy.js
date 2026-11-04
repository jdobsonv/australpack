export const stages = ["received", "scheduled", "production", "quality", "ready", "in_transit", "delivered"];
export const stageNames = { received: "Recibido", scheduled: "Programado", production: "En producción", quality: "En control de calidad", ready: "Listo para despacho", in_transit: "En tránsito", delivered: "Entregado" };
export const roleNames = { admin: "Gerencia", production: "Producción", quality: "Calidad", dispatch: "Despacho", administration: "Administración", viewer: "Consulta" };
export class DomainError extends Error {
    status;
    constructor(message, status = 400) { super(message); this.status = status; }
}
const permissions = { create: ["admin", "administration"], advance: ["admin", "production"], production: ["admin", "production"], quality: ["admin", "quality"], dispatch: ["admin", "dispatch"], finance: ["admin", "administration"], note: ["admin", "production", "quality", "dispatch", "administration"], document: ["admin", "production", "quality", "dispatch", "administration"] };
export function can(role, action) { return Object.hasOwn(permissions, action) && Boolean(permissions[action]?.includes(role)); }
export function good(order) { return order.pallets.reduce((n, p) => n + p.good, 0); }
export function scrap(order) { return order.pallets.reduce((n, p) => n + p.scrap, 0); }
export function progress(order) { return Math.min(100, Math.floor(good(order) / order.quantity * 100)); }
export function text(value, label, max = 200) { if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new DomainError(`${label}: ingresa un valor válido de hasta ${max} caracteres.`); return value.trim(); }
function int(value, label, min = 0, max = 1e10) { const n = Number(value); if (value === "" || value === null || !Number.isSafeInteger(n) || n < min || n > max)
    throw new DomainError(`${label}: ingresa un entero entre ${min} y ${max}.`); return n; }
export function palletList(id, quantity, capacity = 500) { return Array.from({ length: Math.ceil(quantity / capacity) }, (_, i) => ({ id: `${id}-P${String(i + 1).padStart(2, "0")}`, planned: Math.min(capacity, quantity - i * capacity), good: 0, scrap: 0 })); }
function fillPallets(pallets, count) { for (const p of pallets) {
    p.good = Math.min(p.planned, count);
    count -= p.good;
} return pallets; }
export function seedState(now = new Date().toISOString()) {
    const date = (days) => new Date(new Date(now).getTime() + days * 86400000).toISOString().slice(0, 10);
    const inputs = [
        ["Frutos del Sur Export", "Caja exportación · Doble corrugado", 5000, 3500, "production", 2, 0, false, "high"],
        ["Salmones del Pacífico", "Caja industrial · 60 × 40 cm", 3000, 0, "scheduled", 3, 0, false, "normal"],
        ["Agrícola Los Robles", "Caja fruta · Ventilada", 2000, 2000, "ready", 1, 24, false, "normal"],
        ["Exportadora Patagonia", "Caja exportación · Reforzada", 8000, 8000, "quality", 1, 90, true, "high"],
        ["Alimentos del Lago", "Caja alimentaria · 40 × 30 cm", 1200, 1200, "in_transit", 0, 12, false, "normal"],
        ["Distribuidora Austral", "Caja despacho · Estándar", 6000, 2100, "production", -1, 40, false, "high"],
        ["Cooperativa del Sur", "Caja cosecha · Reciclada", 2400, 2400, "delivered", -2, 16, false, "normal"],
        ["Conservas Llanquihue", "Caja industrial · Estándar", 4000, 0, "received", 6, 0, false, "normal"],
    ];
    const orders = inputs.map(([client, format, quantity, count, stage, due, scrapCount, hold, priority], i) => {
        const id = `AP-${String(i + 1).padStart(3, "0")}`;
        const pallets = fillPallets(palletList(id, quantity), count);
        pallets[0].scrap = scrapCount;
        const approved = ["ready", "in_transit", "delivered"].includes(stage);
        const sale = quantity * 480;
        return { id, client, format, quantity, due: date(due), priority, stage, lot: `L-${date(-1).replaceAll("-", "")}-${String(i + 1).padStart(3, "0")}`, pallets, hold, holdReason: hold ? "Deformación detectada en inspección. Revisar condición del lote antes de liberar." : "", qualityApproved: approved, createdAt: new Date(new Date(now).getTime() - 86400000 * 2).toISOString(), updatedAt: now, finance: { sale, invoiced: ["in_transit", "delivered"].includes(stage) ? sale : 0, received: stage === "delivered" ? sale : 0, material: quantity * 205, labor: quantity * 72, transport: approved ? 60000 : 0, other: quantity * 18 }, carrier: stage === "in_transit" || stage === "delivered" ? "Transporte Austral (ejemplo)" : "", guide: stage === "in_transit" || stage === "delivered" ? `GD-${1000 + i}` : "", receiver: stage === "delivered" ? "Recepción de bodega (ejemplo)" : "" };
    });
    const events = [
        { id: "DEMO-E1", orderId: "AP-001", at: now, area: "Producción", actor: "Turno A · Ejemplo", type: "production", message: "Troquelado registrado. 3.500 cajas conformes acumuladas.", palletId: "AP-001-P07" },
        { id: "DEMO-E2", orderId: "AP-004", at: new Date(new Date(now).getTime() - 22 * 60000).toISOString(), area: "Calidad", actor: "Control de calidad · Ejemplo", type: "hold", message: "Lote retenido por deformación. Despacho bloqueado." },
        { id: "DEMO-E3", orderId: "AP-005", at: new Date(new Date(now).getTime() - 47 * 60000).toISOString(), area: "Despacho", actor: "Logística · Ejemplo", type: "dispatch", message: "Salida registrada con guía GD-1004." },
        { id: "DEMO-E4", orderId: "AP-003", at: new Date(new Date(now).getTime() - 85 * 60000).toISOString(), area: "Calidad", actor: "Control de calidad · Ejemplo", type: "release", message: "Lote liberado. Pedido disponible para despacho." },
    ];
    const documents = orders.slice(0, 3).map(o => ({ id: `DOC-${o.id}`, orderId: o.id, name: `Orden_produccion_${o.id}.csv`, kind: "Orden de producción", area: "Producción", at: now, actor: "Sistema · Ejemplo", size: 0, mime: "text/csv", generated: true }));
    return { orders, events, documents, nextNumber: 9, demo: true };
}
export function publicState(state, role) { const copy = structuredClone(state); if (!["admin", "administration"].includes(role)) {
    copy.orders.forEach(o => delete o.finance);
    copy.events = copy.events.filter(e => e.type !== "finance");
    copy.documents = copy.documents.filter(d => d.area !== "Administración");
} return copy; }
export function applyAction(previous, action, payload, actor, now = new Date().toISOString()) {
    if (!can(actor.role, action))
        throw new DomainError("Tu perfil no tiene permiso para esta acción.", 403);
    const state = structuredClone(previous);
    let order = state.orders.find(o => o.id === payload.orderId);
    const addEvent = (message, type = action, palletId) => state.events.unshift({ id: crypto.randomUUID(), orderId: order.id, at: now, area: action === "quality" ? "Calidad" : action === "dispatch" ? "Despacho" : action === "finance" || action === "create" ? "Administración" : roleNames[actor.role], actor: actor.name, type, message, ...(palletId ? { palletId } : {}) });
    if (action === "create") {
        const quantity = int(payload.quantity, "Cantidad", 1, 50000);
        const capacity = int(payload.capacity ?? 500, "Cajas por pallet", 50, 2000);
        if (Math.ceil(quantity / capacity) > 200)
            throw new DomainError("El pedido admite hasta 200 pallets.");
        const client = text(payload.client, "Cliente", 100);
        const format = text(payload.format, "Formato", 120);
        const due = text(payload.due, "Fecha", 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due + "T12:00:00Z")) || new Date(due + "T12:00:00Z").toISOString().slice(0, 10) !== due)
            throw new DomainError("La fecha de entrega no es válida.");
        const id = `AP-${String(state.nextNumber++).padStart(3, "0")}`;
        order = { id, client, format, quantity, due, priority: payload.priority === "high" ? "high" : "normal", stage: "received", lot: `L-${now.slice(0, 10).replaceAll("-", "")}-${id.slice(3)}`, pallets: palletList(id, quantity, capacity), hold: false, holdReason: "", qualityApproved: false, createdAt: now, updatedAt: now, finance: { sale: payload.sale === "" || payload.sale === undefined ? null : int(payload.sale, "Venta"), invoiced: 0, received: 0, material: null, labor: null, transport: null, other: null }, carrier: "", guide: "", receiver: "" };
        state.orders.unshift(order);
        addEvent(`Pedido creado: ${quantity.toLocaleString("es-CL")} cajas para ${client}.`);
        return state;
    }
    if (!order)
        throw new DomainError("El pedido no existe.", 404);
    if (action === "production") {
        if (order.stage !== "production")
            throw new DomainError("El pedido debe estar en producción para registrar cajas.");
        if (order.hold)
            throw new DomainError("El lote está retenido. Calidad debe resolver la retención antes de continuar.");
        const pallet = order.pallets.find(p => p.id === payload.palletId);
        if (!pallet)
            throw new DomainError("Selecciona un pallet de este pedido.");
        const count = int(payload.good, "Cajas conformes", 0, 50000);
        const wasted = int(payload.scrap ?? 0, "Scrap", 0, 50000);
        if (count + wasted === 0)
            throw new DomainError("Registra al menos una caja conforme o descartada.");
        if (pallet.good + count > pallet.planned)
            throw new DomainError(`Este pallet admite ${pallet.planned - pallet.good} cajas conformes adicionales.`);
        pallet.good += count;
        pallet.scrap += wasted;
        addEvent(`${count} cajas conformes y ${wasted} descartadas en ${pallet.id}.${payload.note ? " " + text(payload.note, "Observación", 400) : ""}`, "production", pallet.id);
    }
    else if (action === "advance") {
        if (order.hold)
            throw new DomainError("Un pedido retenido no puede avanzar.");
        const next = { received: "scheduled", scheduled: "production", production: "quality" };
        const target = next[order.stage];
        if (!target)
            throw new DomainError("El cambio de etapa corresponde a Calidad o Despacho.");
        if (target === "quality" && good(order) !== order.quantity)
            throw new DomainError("Completa la cantidad conforme solicitada antes del control final.");
        order.stage = target;
        addEvent(`Pedido actualizado: ${stageNames[target]}.`);
    }
    else if (action === "quality") {
        const note = text(payload.note, "Resultado o motivo", 500);
        if (["received", "scheduled", "in_transit", "delivered"].includes(order.stage))
            throw new DomainError("El pedido no admite cambios de calidad en esta etapa.");
        if (payload.result === "hold") {
            order.hold = true;
            order.holdReason = note;
            order.qualityApproved = false;
            if (order.stage === "ready")
                order.stage = "quality";
            addEvent(`Lote retenido: ${note}`, "hold");
        }
        else if (payload.result === "resolve") {
            if (!order.hold)
                throw new DomainError("El lote no tiene una retención activa.");
            order.hold = false;
            order.holdReason = "";
            addEvent(`Retención resuelta: ${note}`, "resolve");
        }
        else if (payload.result === "release") {
            if (order.hold)
                throw new DomainError("Resuelve la retención antes de liberar el lote.");
            if (order.stage !== "quality" || good(order) !== order.quantity)
                throw new DomainError("La liberación requiere el control final y la cantidad conforme completa.");
            order.qualityApproved = true;
            order.stage = "ready";
            addEvent(`Lote liberado para despacho: ${note}`, "release");
        }
        else
            throw new DomainError("Selecciona un resultado de calidad válido.");
    }
    else if (action === "dispatch") {
        if (payload.step === "ship") {
            if (order.stage !== "ready" || !order.qualityApproved || order.hold || good(order) !== order.quantity)
                throw new DomainError("El despacho requiere producción completa y liberación de Calidad.");
            order.carrier = text(payload.carrier, "Transportista", 120);
            order.guide = text(payload.guide, "Guía de despacho", 80);
            order.stage = "in_transit";
            addEvent(`Salida registrada. ${order.carrier} · Guía ${order.guide}.`);
        }
        else if (payload.step === "deliver") {
            if (order.stage !== "in_transit")
                throw new DomainError("El pedido debe estar en tránsito para registrar la entrega.");
            order.receiver = text(payload.receiver, "Recibido por", 120);
            order.stage = "delivered";
            addEvent(`Entrega confirmada. Recibido por ${order.receiver}.`);
        }
        else
            throw new DomainError("Selecciona una acción de despacho válida.");
    }
    else if (action === "finance") {
        const finance = {};
        for (const key of ["sale", "invoiced", "received", "material", "labor", "transport", "other"]) {
            const value = payload[key];
            finance[key] = value === "" || value === null || value === undefined ? null : int(value, key);
        }
        if (finance.received !== null && finance.invoiced !== null && finance.received > finance.invoiced)
            throw new DomainError("El monto cobrado supera el monto facturado.");
        if (finance.invoiced !== null && finance.sale !== null && finance.invoiced > finance.sale)
            throw new DomainError("El monto facturado supera el valor del pedido.");
        order.finance = finance;
        addEvent("Información económica actualizada.", "finance");
    }
    else if (action === "note") {
        addEvent(text(payload.note, "Observación", 600), "note");
    }
    else
        throw new DomainError("Acción desconocida.");
    order.updatedAt = now;
    return state;
}
export function csv(rows) { return "\uFEFF" + rows.map(row => row.map(v => { let s = String(v ?? ""); if (/^[=+@\-\t\r]/.test(s))
    s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }).join(",")).join("\r\n"); }

