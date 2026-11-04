// Reglas del Caso 2. Los registros originales se conservan al migrar desde v1.
import * as v1 from './legacy.js';
export const { stages, stageNames, DomainError, good, scrap, progress, text, palletList, csv } = v1;
export const roleNames = { ...v1.roleNames, maintenance: 'Mantenimiento' };
export const shiftNames = { day: 'Diurno', night: 'Nocturno' };
const additional = {
  inspection: ['admin', 'quality'], trace_review: ['admin', 'quality'],
  incident: ['admin', 'quality', 'dispatch'], incident_update: ['admin', 'quality'],
  maintenance: ['admin', 'maintenance'], sample: ['admin', 'production', 'quality', 'maintenance'],
  sample_review: ['admin', 'quality'], demo: ['admin'], pilot_config: ['admin'],
};
export const can = (role, action) => additional[action]?.includes(role) || v1.can(role, action);
const id = () => crypto.randomUUID();
const num = (value, label, min = 0, max = 1e10, integer = false) => {
  const n = Number(value);
  if (!['number','string'].includes(typeof value) || typeof value==='string' && !value.trim() || !Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new DomainError(`${label}: ingresa ${integer ? 'un entero' : 'un número'} entre ${min} y ${max}.`);
  return n;
};
const choice = (value, values, label) => { if (!values.includes(value)) throw new DomainError(`${label}: selecciona una opción válida.`); return value; };
const timestamp = (value, now) => {
  const date = new Date(value);
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()) || date.getTime() > new Date(now).getTime() + 300000) throw new DomainError('La fecha del registro no es válida o está en el futuro.');
  return date.toISOString();
};
const equipmentFor = (state, value) => {
  const machine = state.equipment.find(e => e.id === value && e.active);
  if (!machine) throw new DomainError('Selecciona un equipo del catálogo.');
  return machine.id;
};
export function normalize(previous) {
  const s = structuredClone(previous);
  s.equipment ??= [
    { id: 'TRQ-01', name: 'Troqueladora 01', active: true },
    { id: 'COR-01', name: 'Corrugadora 01', active: true },
    { id: 'IMP-01', name: 'Impresora 01', active: true },
  ];
  s.productionRecords ??= [];
  s.inspections ??= [];
  s.incidents ??= [];
  s.maintenanceRecords ??= [];
  s.pilotSamples ??= [];
  s.pilotConfig ??= { inspectionMaintained: 'unverified', noLayoffs: 'unverified', costYear1: null, stopDays: null, evidence: '' };
  if (s.schemaVersion !== 2) {
    // Un total previo no permite reconstruir equipo, turno ni hora de fabricación.
    for (const o of s.orders) for (const p of o.pallets) if (p.good || p.scrap) {
      s.productionRecords.push({ id: `PREV-${p.id}`, orderId: o.id, lot: o.lot, palletId: p.id, good: p.good, scrap: p.scrap, at: null, recordedAt: null, equipmentId: '', shift: '', actor: 'Registro previo sin detalle', captureMode: 'legacy', sourceRef: '', review: null });
    }
  }
  s.schemaVersion = 2;
  return s;
}
export const seedState = (now) => normalize(v1.seedState(now));
const addEvent = (s, actor, now, orderId, type, message, extra = {}) => s.events.unshift({ id: id(), orderId, at: now, area: roleNames[actor.role], actor: actor.name, actorId: actor.id, type, message, ...extra });
export const effectiveRecord = record => ({ ...record, ...(record.review?.fields || {}) });
export const completeRecord = record => {
  const r = effectiveRecord(record);
  return Boolean(r.lot && r.at && r.equipmentId && r.shift && r.actor && (r.captureMode === 'online' || r.review));
};
const recordsFor = (s, orderId) => s.productionRecords.filter(r => r.orderId === orderId);
const openIncidents = (s, orderId) => s.incidents.filter(i => i.orderId === orderId && i.status !== 'closed');
const latestControl = (s, orderId) => s.inspections.find(i => i.orderId === orderId);
function releaseChecks(s, order) {
  const control=latestControl(s,order.id);
  if (!control?.passed) throw new DomainError('Registra un control conforme con criterio y resultado antes de liberar.');
  if(recordsFor(s,order.id).some(r=>r.recordedAt && r.recordedAt>control.at)) throw new DomainError('El control final debe ser posterior al último registro de producción.');
  if (recordsFor(s, order.id).some(r => !completeRecord(r))) throw new DomainError('La trazabilidad tiene registros previos o manuales pendientes de revisión.');
  if (openIncidents(s, order.id).length) throw new DomainError('Calidad debe resolver las incidencias abiertas antes de liberar o despachar.');
}
function createIncident(s, p, actor, now, order) {
  const item = { id: id(), orderId: order.id, lot: order.lot, affected: num(p.affected, 'Cajas afectadas', 1, order.quantity, true), source: choice(p.source, ['client','quality','dispatch'], 'Origen'), description: text(p.description, 'Descripción', 700), assignedTo: text(p.assignedTo, 'Responsable', 100), at: now, actor: actor.name, status: 'open', containment: '', analysis: '', corrective: '', verification: '', closedAt: null };
  s.incidents.unshift(item);
  addEvent(s, actor, now, order.id, 'incident', `Incidencia abierta: ${item.affected} cajas. ${item.description}`, { incidentId: item.id });
  return item;
}
export function applyAction(previous, action, p, actor, now = new Date().toISOString()) {
  if (!can(actor.role, action)) throw new DomainError('Tu perfil no tiene permiso para esta acción.', 403);
  let s = normalize(previous);
  const order = s.orders.find(o => o.id === p.orderId);
  const globalActions = ['demo','sample','sample_review','pilot_config','maintenance'];
  if (!globalActions.includes(action) && action !== 'create' && !order) throw new DomainError('Pedido no encontrado.', 404);

  if (action === 'production') {
    p={...p,good:num(p.good,'Cajas conformes',0,50000,true),scrap:num(p.scrap??0,'Scrap',0,50000,true)};
    const equipmentId = equipmentFor(s, p.equipmentId), shift = choice(p.shift, ['day','night'], 'Turno');
    const captureMode = choice(p.captureMode || 'online', ['online','manual'], 'Captura');
    const at = captureMode === 'manual' ? timestamp(p.occurredAt, now) : now;
    const sourceRef = captureMode === 'manual' ? text(p.sourceRef, 'Folio de contingencia', 160) : '';
    s = v1.applyAction(s, action, p, actor, now);
    s.productionRecords.unshift({ id: id(), orderId: order.id, lot: order.lot, palletId: p.palletId, equipmentId, shift, good: Number(p.good), scrap: Number(p.scrap || 0), at, recordedAt: now, actor: actor.name, actorId: actor.id, captureMode, sourceRef, review: null, demo:Boolean(order.demo) });
    return s;
  }
  if (action === 'trace_review') {
    const record = s.productionRecords.find(r => r.id === p.recordId && r.orderId === order.id);
    if (!record || record.captureMode === 'online' || record.review) throw new DomainError('El registro no tiene una revisión pendiente.');
    const evidence = text(p.evidence, 'Documento o evidencia de revisión', 500);
    const fields = record.captureMode === 'legacy' ? { equipmentId: equipmentFor(s, p.equipmentId), shift: choice(p.shift, ['day','night'], 'Turno'), at: timestamp(p.occurredAt, now), actor: text(p.originalActor, 'Responsable del registro original', 100) } : {};
    record.review = { at: now, actor: actor.name, actorId: actor.id, evidence, fields };
    addEvent(s, actor, now, order.id, 'trace_review', `Revisión documentada del registro ${record.id}. ${evidence}`);
  } else if (action === 'inspection') {
    if(['received','scheduled'].includes(order.stage)) throw new DomainError('Inicia la producción antes de registrar un ensayo del lote.');
    const equipmentId = equipmentFor(s, p.equipmentId), shift = choice(p.shift, ['day','night'], 'Turno');
    const value = num(p.value, 'Resultado medido', -1e6, 1e6);
    const lower = p.lower === '' || p.lower == null ? null : num(p.lower, 'Límite inferior', -1e6, 1e6);
    const upper = p.upper === '' || p.upper == null ? null : num(p.upper, 'Límite superior', -1e6, 1e6);
    if (lower == null && upper == null || lower != null && upper != null && lower > upper) throw new DomainError('Define al menos un límite y verifica que el inferior no supere al superior.');
    const item = { id: id(), orderId: order.id, lot: order.lot, at: now, equipmentId, shift, parameter: text(p.parameter, 'Ensayo o parámetro', 120), unit: text(p.unit, 'Unidad', 30), sampleSize: num(p.sampleSize, 'Tamaño de muestra', 1, order.quantity, true), criterionRef: text(p.criterionRef, 'Especificación o criterio aprobado', 180), value, lower, upper, passed: (lower == null || value >= lower) && (upper == null || value <= upper), actor: actor.name, actorId: actor.id, note: String(p.note || '').slice(0,500) };
    s.inspections.unshift(item);
    if (!item.passed && !['in_transit','delivered'].includes(order.stage)) {
      order.hold = true; order.qualityApproved = false;
      order.holdReason = `${item.parameter}: ${value} ${item.unit}, fuera del criterio ${item.criterionRef}.`;
      if (order.stage === 'ready') order.stage = 'quality';
    }
    if (!item.passed && ['in_transit','delivered'].includes(order.stage)) createIncident(s, { affected: p.affected || order.quantity, source:'quality', description:`Control posterior al despacho no conforme: ${item.parameter}.`, assignedTo: actor.name }, actor, now, order);
    addEvent(s, actor, now, order.id, 'inspection', `${item.passed ? 'Conforme' : 'No conforme'}: ${item.parameter} = ${value} ${item.unit}; criterio ${item.criterionRef}.`, { inspectionId: item.id });
  } else if (action === 'incident') {
    createIncident(s, p, actor, now, order);
    if (!['in_transit','delivered'].includes(order.stage)) { order.hold = true; order.holdReason = p.description; order.qualityApproved = false; }
  } else if (action === 'incident_update') {
    const item = s.incidents.find(i => i.id === p.incidentId && i.orderId === order.id);
    if (!item || item.status === 'closed') throw new DomainError('Incidencia no disponible para actualizar.');
    const status = choice(p.status, ['contained','investigation','closed'], 'Estado');
    item.containment = text(p.containment, 'Acción de contención', 700);
    if (status !== 'contained') { item.analysis = text(p.analysis, 'Análisis de causa', 700); item.corrective = text(p.corrective, 'Acción correctiva', 700); }
    if (status === 'closed') { item.verification = text(p.verification, 'Evidencia de verificación del cierre', 700); item.closedAt = now; item.closedBy = actor.name; }
    item.status = status;
    item.updates ??= [];
    item.updates.push({at:now,actor:actor.name,status,containment:item.containment,analysis:item.analysis,corrective:item.corrective,verification:item.verification});
    addEvent(s, actor, now, order.id, 'incident_update', `Incidencia ${status === 'closed' ? 'cerrada' : status === 'contained' ? 'contenida' : 'en investigación'}. ${item.containment}`, { incidentId:item.id });
  } else if (action === 'maintenance') {
    const equipmentId = equipmentFor(s, p.equipmentId), start = timestamp(p.start, now), end = timestamp(p.end, now);
    if (new Date(end) <= new Date(start)) throw new DomainError('El fin de la detención debe ser posterior al inicio.');
    if(s.maintenanceRecords.some(r=>r.equipmentId===equipmentId && start<r.end && end>r.start)) throw new DomainError('El intervalo se superpone con una detención del mismo equipo. Revisa el registro existente.');
    const item = { id:id(), orderId: order?.id || null, equipmentId, shift:choice(p.shift,['day','night'],'Turno'), start, end, minutes:(new Date(end)-new Date(start))/60000, reason:text(p.reason,'Causa de detención',500), intervention:text(p.intervention,'Intervención o respuesta',500), actor:actor.name, at:now };
    s.maintenanceRecords.unshift(item);
    addEvent(s, actor, now, item.orderId, 'maintenance', `${equipmentId}: detención de ${item.minutes.toFixed(1)} minutos. ${item.reason}`);
  } else if (action === 'sample') {
    const day = text(p.day, 'Día', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day || day>now.slice(0,10)) throw new DomainError('Día no válido o situado en el futuro.');
    const shift = choice(p.shift,['day','night'],'Turno'), source = choice(p.source,['pilot','simulation'],'Fuente');
    if (s.pilotSamples.some(v=>v.day===day && v.shift===shift && v.source===source && !v.voided)) throw new DomainError('Ya existe una medición de ese día y turno para esa fuente.');
    const item = { id:id(), day, shift, source, sourceRef:text(p.sourceRef,'Folio o fuente de medición',180), at:now, actor:actor.name, validated:false };
    for (const key of ['plannedMinutes','downMinutes','good','scrap','completedLots','cycleHoursTotal','dueOrders','otifOrders','shippedBoxes','claims']) item[key]=num(p[key],key,0,1e7,!['cycleHoursTotal'].includes(key));
    if (!item.plannedMinutes || item.plannedMinutes>1440 || item.downMinutes>item.plannedMinutes || item.otifOrders>item.dueOrders || item.completedLots===0 && item.cycleHoursTotal>0 || item.completedLots>0 && item.cycleHoursTotal===0 || item.shippedBoxes===0 && item.claims>0) throw new DomainError('Revisa denominadores, tiempos y cantidades de la medición.');
    s.pilotSamples.unshift(item);
    addEvent(s,actor,now,null,'sample',`Medición ${source==='simulation'?'simulada':'del piloto'} ${day}, turno ${shiftNames[shift]}, pendiente de validación.`);
  } else if (action === 'sample_review') {
    const item = s.pilotSamples.find(v=>v.id===p.sampleId && !v.voided);
    if (!item || item.validated) throw new DomainError('La medición no está pendiente.');
    const review = text(p.review,'Revisión de la fuente',500);
    const decision = choice(p.decision,['validate','void'],'Decisión');
    item.validated = decision==='validate'; item.voided = decision==='void'; item.review = review; item.reviewedBy = actor.name; item.reviewedAt = now;
    addEvent(s,actor,now,null,'sample_review',`Medición ${item.day} ${shiftNames[item.shift]} ${item.validated?'validada':'anulada'}. ${review}`);
  } else if (action === 'pilot_config') {
    s.pilotConfig = { inspectionMaintained:choice(p.inspectionMaintained,['yes','no','unverified'],'Inspección'), noLayoffs:choice(p.noLayoffs,['yes','no','unverified'],'Personas'), costYear1:num(p.costYear1,'Costo total del año 1',0), stopDays:num(p.stopDays,'Detención consecutiva en días',0,365), evidence:text(p.evidence,'Evidencia de condiciones',700), at:now, actor:actor.name };
    addEvent(s,actor,now,null,'pilot_config','Condiciones del piloto actualizadas con evidencia.');
  } else if (action === 'demo') {
    if (s.orders.some(o=>o.scenario==='case2')) return s;
    const o = { ...v1.seedState(now).orders[0], id:'AP-CASO2', lot:'L-CASO2-DEMO', quantity:48000, format:'Caja exportación · Escenario académico', stage:'delivered', hold:false, holdReason:'', qualityApproved:true, pallets:palletList('AP-CASO2',48000), receiver:'Cliente · Ejemplo', carrier:'Transporte de demostración', guide:'GD-DEMO-CASO2', scenario:'case2', demo:true, finance:{sale:null,invoiced:0,received:0,material:null,labor:null,transport:null,other:null} };
    const productionAt = new Date(new Date(now).getTime()-86400000).toISOString();
    for (const p of o.pallets) {p.good=p.planned; s.productionRecords.push({id:id(),orderId:o.id,lot:o.lot,palletId:p.id,good:p.good,scrap:0,at:productionAt,recordedAt:productionAt,equipmentId:'TRQ-01',shift:'night',actor:'Operación simulada',captureMode:'online',sourceRef:'Fixture Caso2',review:null,demo:true});}
    s.orders.unshift(o);
    const pilot={...o,id:'AP-PILOTO',lot:'L-PILOTO-DEMO',client:'Cliente del piloto · Ejemplo',quantity:500,pallets:palletList('AP-PILOTO',500),stage:'production',qualityApproved:false,guide:'',carrier:'',receiver:'',scenario:'workflow',createdAt:now,updatedAt:now};
    s.orders.unshift(pilot);
    const inspectionAt=new Date(new Date(now).getTime()-14*3600000).toISOString();
    s.inspections.unshift({id:id(),orderId:o.id,lot:o.lot,at:inspectionAt,equipmentId:'TRQ-01',shift:'night',parameter:'Deformación de ejemplo',unit:'%',sampleSize:10,criterionRef:'DEMO-01 no industrial',value:2,lower:0,upper:3,passed:true,actor:'Calidad simulada',note:'Dato ficticio para mostrar el expediente',demo:true});
    for(const [type,message,hours] of [['production','Producción del ejemplo completada.',24],['release','Control simulado conforme y liberación del ejemplo.',14],['dispatch','Despacho simulado con guía GD-DEMO-CASO2.',12],['delivery','Entrega simulada en recepción del cliente.',2]]) s.events.unshift({id:id(),orderId:o.id,at:new Date(new Date(now).getTime()-hours*3600000).toISOString(),area:'Demostración',actor:'Sistema simulado',type,message});
    createIncident(s,{affected:48000,source:'client',description:'Deformación en frío reportada por Frutos del Sur Export. Escenario simulado basado en el caso.',assignedTo:'Calidad · Responsable del piloto'},actor,now,o);
    for(const [shift,down,goodCount,scrapCount,cycle,due,otif] of [['day',40,4700,300,9.8,12,11],['night',56,4600,400,10.2,13,12]]) s.pilotSamples.push({id:id(),day:now.slice(0,10),shift,source:'simulation',sourceRef:'Fixture reproducible Caso2',at:now,actor:'Sistema de demostración',validated:true,reviewedBy:'Fixture simulado',plannedMinutes:480,downMinutes:down,good:goodCount,scrap:scrapCount,completedLots:1,cycleHoursTotal:cycle,dueOrders:due,otifOrders:otif,shippedBoxes:5000,claims:shift==='day'?2:3});
    addEvent(s,actor,now,o.id,'demo','Ejemplos cargados: incidente de 48.000 cajas y flujo de 500 cajas. Fechas, equipos, ensayos y mediciones son simulados.');
  } else {
    if(action==='quality' && ['release','resolve'].includes(p.result)) {
      if(p.result==='release') releaseChecks(s,order);
      else {
        if(!latestControl(s,order.id)?.passed) throw new DomainError('Registra un nuevo control conforme antes de resolver la retención.');
        text(p.corrective,'Acción correctiva',500);text(p.verification,'Evidencia de verificación',500);
        p={...p,note:`${text(p.note,'Revisión',500)} Acción: ${p.corrective}. Verificación: ${p.verification}.`};
        if(p.note.length>500) throw new DomainError('Resume la revisión, acción y verificación en un máximo total de 500 caracteres.');
      }
    }
    if(action==='dispatch' && p.step==='ship') releaseChecks(s,order);
    return v1.applyAction(s,action,p,actor,now);
  }
  if(order) order.updatedAt=now;
  return s;
}
export function pilotMetrics(s, source='pilot') {
  const samples=s.pilotSamples.filter(v=>v.source===source && v.validated && !v.voided);
  const sum=key=>samples.reduce((n,v)=>n+v[key],0);
  const ratio=(a,b,m=100)=>b?Math.round(a/b*m*1e6)/1e6:null;
  const records=s.productionRecords.filter(r=>source==='simulation'?r.demo:!r.demo);
  const coverage=ratio(records.filter(completeRecord).length,records.length);
  const values={cycle:ratio(sum('cycleHoursTotal'),sum('completedLots'),1),scrap:ratio(sum('scrap'),sum('good')+sum('scrap')),otif:ratio(sum('otifOrders'),sum('dueOrders')),availability:ratio(sum('plannedMinutes')-sum('downMinutes'),sum('plannedMinutes')),claims:ratio(sum('claims'),sum('shippedBoxes'),10000),trace:coverage};
  const shifts=Object.fromEntries(['day','night'].map(k=>[k,samples.filter(v=>v.shift===k).length]));
  const cfg=s.pilotConfig, reasons=[];
  let decision='Sin evidencia suficiente';
  if(source==='simulation') { decision='Demostración sin decisión sobre planta'; reasons.push('Las cifras simuladas no acreditan mejoras reales.'); }
  else if(cfg.inspectionMaintained==='no' || cfg.noLayoffs==='no' || cfg.costYear1>48000000 || cfg.stopDays>4) {decision='Detener';reasons.push('Se incumple al menos una restricción de calidad, personas, presupuesto o detención.');}
  else if(shifts.day<5 || shifts.night<5 || Object.values(values).some(v=>v===null) || cfg.inspectionMaintained!=='yes' || cfg.noLayoffs!=='yes' || cfg.costYear1==null || cfg.stopDays==null) reasons.push('Se requieren al menos cinco mediciones validadas por turno, trazabilidad y todas las condiciones documentadas.');
  else {
    const pass=values.cycle<=10.1 && values.scrap<=7.6 && values.otif>=91.5 && values.availability>=80 && values.claims<=12 && values.trace>=96;
    decision=pass?'Continuar':'Corregir';
    reasons.push(pass?'Se cumplen los umbrales propuestos para continuar midiendo. La decisión de escalar requiere revisar las metas globales.':'No se cumple al menos un umbral del piloto. Identifica la causa y vuelve a medir.');
  }
  return {source,sampleCount:samples.length,pending:s.pilotSamples.filter(v=>v.source===source&&!v.validated&&!v.voided).length,shifts,values,decision,reasons,denominators:{lots:sum('completedLots'),boxes:sum('good')+sum('scrap'),orders:sum('dueOrders'),minutes:sum('plannedMinutes'),shipped:sum('shippedBoxes'),records:records.length}};
}
export function traceReport(s, orderId) {
  const order=s.orders.find(o=>o.id===orderId);
  if(!order) throw new DomainError('Pedido no encontrado.',404);
  const {finance,...safeOrder}=order;
  return {generatedAt:new Date().toISOString(),company:'AustralPack Circular SpA',order:safeOrder,production:recordsFor(s,orderId).map(r=>({...r,effective:effectiveRecord(r),complete:completeRecord(r)})),inspections:s.inspections.filter(i=>i.orderId===orderId),incidents:s.incidents.filter(i=>i.orderId===orderId),maintenance:s.maintenanceRecords.filter(i=>i.orderId===orderId),events:s.events.filter(e=>e.orderId===orderId&&e.type!=='finance'),equipment:s.equipment};
}
export function publicState(s, role) {
  const copy=v1.publicState(s,role);
  copy.metrics={pilot:pilotMetrics(s,'pilot'),simulation:pilotMetrics(s,'simulation')};
  if(!['admin','administration'].includes(role)) delete copy.pilotConfig.costYear1;
  return copy;
}
