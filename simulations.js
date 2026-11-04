// Recorridos didácticos aislados. No importan ni modifican el estado del servidor.
// Las horas y el criterio DEMO-01 son ficticios, no especificaciones de planta.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = value => Number(value).toLocaleString('es-CL');
export const SIMULATION_AREAS = {simulaciones:'Simulaciones',produccion:'Producción',calidad:'Calidad',mantenimiento:'Mantenimiento',despacho:'Despacho'};
export const SIMULATION_SCENARIOS = {
  negative: {name:'Pedido con problemas',tag:'Incidencias y atraso',description:'Una detención de TRQ-01 retrasa la fabricación. Después, Calidad retiene el lote. Resuelve las incidencias para completar la entrega.',orderId:'DEMO-ATRASO',tone:'danger'},
  normal: {name:'Entrega normal',tag:'Dentro del plazo',description:'Sigue un pedido desde su recepción hasta la entrega en las 16 horas comprometidas, con todos los controles aprobados.',orderId:'DEMO-NORMAL',tone:'neutral'},
  early: {name:'Entrega anticipada',tag:'Antes de lo previsto',description:'Completa el mismo recorrido en 12 horas, con la cantidad completa y sin omitir el control de Calidad.',orderId:'DEMO-ANTICIPO',tone:'success'},
};
const step = (id,label,hours,stage,good=0,extra={}) => ({id,label,hours,stage,good,...extra});
const routine = times => [
  step('received','Pedido recibido',times[0],'received'),
  step('prepared','Preparación terminada',times[1],'scheduled'),
  step('producing','Producción en curso',times[2],'production',250),
  step('produced','Producción terminada',times[3],'quality',500),
  step('passed','Calidad aprobada',times[4],'quality',500,{inspection:2,qualityApproved:true}),
  step('ready','Listo para despacho',times[5],'ready',500,{qualityApproved:true}),
  step('shipped','Pedido en tránsito',times[6],'in_transit',500,{qualityApproved:true}),
  step('delivered','Pedido entregado',times[7],'delivered',500,{qualityApproved:true}),
];
const STEPS = {
  normal:routine([0,2,4,8,10,11,12,16]),
  early:routine([0,1,3,6,7,8,9,12]),
  negative:[
    step('received','Pedido recibido',0,'received'),
    step('prepared','Preparación terminada',2,'scheduled'),
    step('producing','Producción en curso',6,'production',250),
    step('machine','TRQ-01 detenida',10,'production',250,{requires:'repair'}),
    step('produced','Máquina restituida; producción terminada',12,'quality',500),
    step('failed','Lote retenido por Calidad',14,'quality',500,{inspection:4,hold:true,requires:'correct'}),
    step('corrected','Corrección verificada; lote liberado',18,'ready',500,{inspection:2,qualityApproved:true}),
    step('shipped','Pedido en tránsito con atraso',20,'in_transit',500,{qualityApproved:true}),
    step('delivered','Pedido entregado con atraso',24,'delivered',500,{qualityApproved:true}),
  ],
};
const STAGE_LABELS={received:'Recibido',scheduled:'Programado',production:'En producción',quality:'Control de Calidad',ready:'Listo para despacho',in_transit:'En tránsito',delivered:'Entregado'};
const PLAN=[['Preparación','prepared',2],['Producción','produced',8],['Calidad','passed',10],['Listo para despacho','ready',11],['Salida','shipped',12],['Entrega','delivered',16]];
const copy = value => structuredClone(value);

export function restoreSimulation(value) {
  if (!value || value.version!==1 || !Object.hasOwn(STEPS,value.scenarioId) || !Number.isInteger(value.index) || value.index<0 || value.index>=STEPS[value.scenarioId].length || typeof value.startedAt!=='string' || !Number.isFinite(Date.parse(value.startedAt))) return null;
  return {version:1,scenarioId:value.scenarioId,index:value.index,startedAt:new Date(value.startedAt).toISOString()};
}
export function createSimulation(scenarioId, startedAt=new Date().toISOString()) {
  const run=restoreSimulation({version:1,scenarioId,index:0,startedAt});
  if(!run) throw new Error('Selecciona un escenario válido para iniciar.');
  return run;
}
export function simulationFrame(value) {
  const run=restoreSimulation(value);
  if(!run) throw new Error('El recorrido guardado no es válido. Inicia una simulación.');
  const sequence=STEPS[run.scenarioId], current=sequence[run.index], history=sequence.slice(0,run.index+1), finished=current.stage==='delivered';
  const alert=(id,area,level,title,message,owner,action)=>({id,area,level,title,message,owner,action});
  const alerts=[];
  if(run.scenarioId==='negative') {
    if(current.id==='machine') {
      alerts.push(alert('machine','mantenimiento','danger','TRQ-01 detenida','La máquina no permite completar las 250 cajas pendientes.','Mantenimiento','Revisar y restituir la máquina antes de continuar.'));
      alerts.push(alert('production-delay','produccion','warning','Producción atrasada 2 h','La fabricación debía terminar en la hora 8; el reloj del ejemplo marca la hora 10.','Producción','Coordinar la intervención y completar la cantidad pendiente.'));
      alerts.push(alert('delivery-risk','despacho','warning','Entrega en riesgo','El pedido sigue en fabricación. La entrega continúa comprometida para la hora 16.','Despacho','Revisar la programación; todavía no hay autorización de salida.'));
    }
    if(current.id==='produced') alerts.push(alert('quality-pending','calidad','warning','Control de Calidad pendiente','La fabricación terminó en la hora 12; el control estaba previsto para la hora 10.','Calidad','Realizar el ensayo antes de autorizar el despacho.'));
    if(current.hold) {
      alerts.push(alert('quality-failure','calidad','danger','Lote retenido: ensayo fuera de rango','El resultado ficticio de deformación es 4 %, sobre el límite de 3 %.','Calidad','Segregar, corregir y repetir el ensayo.'));
      alerts.push(alert('blocked-dispatch','despacho','danger','Despacho bloqueado por Calidad','Las 500 cajas están fabricadas, pero el lote no tiene autorización de salida.','Despacho','Esperar el nuevo ensayo conforme y la liberación de Calidad.'));
    }
    if(current.hours>16 && !finished) alerts.push(alert('overdue','despacho','danger',`Plazo de entrega vencido hace ${current.hours-16} h`,'El compromiso de entrega era la hora 16. La incidencia resuelta queda en el historial.','Despacho','Registrar y coordinar la entrega con atraso.'));
  }
  const lastInspection=[...history].reverse().find(s=>s.inspection!==undefined);
  const inspections=history.filter(s=>s.inspection!==undefined).map(s=>({hours:s.hours,value:s.inspection,passed:s.inspection<=3,id:s.id}));
  const canDispatch=current.good===500 && Boolean(current.qualityApproved) && !current.hold && lastInspection?.inspection<=3;
  const comparison=PLAN.map(([label,id,planned])=>{
    const ids=id==='passed'?['passed','corrected']:id==='ready'?['ready','corrected']:[id];
    const actual=history.find(s=>ids.includes(s.id));
    return {label,planned,actual:actual?.hours??null,delta:actual?actual.hours-planned:null};
  });
  const delta=finished?current.hours-16:null;
  return {run,scenario:copy(SIMULATION_SCENARIOS[run.scenarioId]),current:copy(current),history:copy(history),steps:copy(sequence),alerts,inspections,comparison,finished,canDispatch,quantity:500,plannedHours:16,delta,progress:Math.round(run.index/(sequence.length-1)*100),status:current.hold?'Retenido por Calidad':current.id==='machine'?'Producción detenida':STAGE_LABELS[current.stage]};
}
export function advanceSimulation(value, action='next') {
  const frame=simulationFrame(value);
  if(frame.finished) throw new Error('Este recorrido terminó. Puedes reiniciarlo o elegir otro caso.');
  if(frame.current.requires && action!==frame.current.requires) throw new Error(frame.current.requires==='repair'?'Primero debes restituir la máquina.':'Primero debes corregir y repetir el ensayo de Calidad.');
  if(action!==(frame.current.requires||'next')) throw new Error('Esa acción no corresponde a la etapa actual.');
  const next=frame.steps[frame.run.index+1];
  if(['in_transit','delivered'].includes(next.stage) && !frame.canDispatch) throw new Error('No se puede despachar sin cantidad completa y liberación de Calidad.');
  return {...frame.run,index:frame.run.index+1};
}
const hours=n=>`${count(n)} h`;
const timestamp=(run,h)=>new Date(Date.parse(run.startedAt)+h*3600000).toLocaleString('es-CL',{timeZone:'America/Santiago',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const actionButton=(text,action,extra='')=>`<button data-action="sim-${action}" ${extra}>${text}</button>`;
const deltaLabel=delta=>delta===0?'Según lo previsto':delta>0?`${hours(delta)} de atraso`:`${hours(-delta)} antes`;

export function simulationHome(saved=null) {
  const restored=restoreSimulation(saved);
  return `<div class="page-heading"><div><p class="eyebrow">DEMOSTRACIÓN INTERACTIVA</p><h1>Simulaciones de pedidos</h1><p>Prueba cómo responde cada área ante un pedido con problemas, una entrega normal y una anticipada.</p></div></div>
  <div class="sim-info"><strong>Ejemplos separados de la operación.</strong> Los recorridos usan 500 cajas y un plazo ficticio de 16 horas. Se ejecutan en este navegador y no cambian pedidos, usuarios ni indicadores del servidor.</div>
  <div class="sim-scenarios">${Object.entries(SIMULATION_SCENARIOS).map(([id,s])=>`<section class="panel sim-scenario sim-tone-${s.tone}"><span class="sim-tag">${s.tag}</span><h2>${s.name}</h2><p>${s.description}</p><button class="primary" data-action="sim-start" data-scenario="${id}">Iniciar ${id==='negative'?'caso con problemas':id==='normal'?'entrega normal':'entrega anticipada'}</button></section>`).join('')}</div>
  ${restored?`<section class="panel sim-resume"><div><h2>Último recorrido en este navegador</h2><p>${SIMULATION_SCENARIOS[restored.scenarioId].name} · Paso ${restored.index+1} de ${STEPS[restored.scenarioId].length}.</p></div>${actionButton('Continuar recorrido','resume')}</section>`:''}
  <section class="panel"><h2>Cómo mostrarlo en la presentación</h2><p class="sim-body-copy">Inicia un caso y usa «Avanzar etapa» o «Reproducir». Las alertas aparecen en el tablero y junto al nombre del área afectada. La reproducción se pausa ante una falla: tendrás que resolverla para continuar. «Reiniciar» vuelve al primer paso y «Salir de simulación» regresa a la operación.</p><p class="muted">Estos recorridos complementan los escenarios de evaluación del informe. Los horarios y el criterio DEMO-01 son didácticos; no prueban mejoras en planta.</p></section>`;
}
export function simulationNavigation(frame,view) {
  return Object.entries(SIMULATION_AREAS).map(([id,label])=>{
    const list=frame.alerts.filter(a=>a.area===id), danger=list.some(a=>a.level==='danger');
    return `<button data-view="${id}" class="${view===id?'active':''}"><span>${label}</span>${list.length?`<span class="sim-nav-count ${danger?'danger':'warning'}" aria-label="${list.length} alerta${list.length===1?'':'s'}">${list.length}</span>`:''}</button>`;
  }).join('');
}
export function simulationBanner(frame) {
  return `<div><strong>SIMULACIÓN ACTIVA</strong><span>${frame.scenario.orderId} · ${frame.scenario.name} · Reloj ficticio +${hours(frame.current.hours)}</span></div>${actionButton('Salir de simulación','exit')}`;
}
function alertsHtml(alerts) {
  return alerts.length?alerts.map(a=>`<article class="sim-alert ${a.level}" role="${a.level==='danger'?'alert':'status'}"><div class="sim-alert-label">${SIMULATION_AREAS[a.area]} · ${a.level==='danger'?'Requiere atención':'Advertencia'}</div><h3>${a.title}</h3><p>${a.message}</p><p><strong>Responsable:</strong> ${a.owner}. <strong>Acción:</strong> ${a.action}</p><button data-view="${a.area}">Revisar ${SIMULATION_AREAS[a.area]}</button></article>`).join(''):'<div class="sim-clear"><strong>Sin alertas activas.</strong> Las incidencias resueltas permanecen en el historial del ejemplo.</div>';
}
function controlsHtml(frame,playing) {
  const required=frame.current.requires, nextLabel=required==='repair'?'Restituir máquina':required==='correct'?'Corregir y repetir ensayo':'Avanzar etapa';
  return `<section class="panel sim-controls"><div><span class="sim-kicker">PASO ${frame.run.index+1} DE ${frame.steps.length}</span><h2 id="sim-status" role="status">${frame.current.label}</h2><p>Cada paso adelanta el reloj del ejemplo; no depende de la hora real.</p></div><div class="actions">${actionButton(playing?'Pausar':'Reproducir','play',`id="sim-play" aria-pressed="${playing}" ${frame.finished||required?'disabled':''}`)}${actionButton(nextLabel,required||'next',`id="sim-next" class="primary" ${frame.finished?'disabled':''}`)}${actionButton('Reiniciar','restart')}${actionButton('Elegir otro caso','choose')}</div>${required?`<p class="sim-manual">${required==='repair'?'La reproducción está pausada. La intervención simulada restituye TRQ-01 y permite completar las cajas pendientes.':'La reproducción está pausada. Esta acción simula la corrección, un nuevo ensayo de 2 % y su verificación por Calidad.'}</p>`:''}</section>`;
}
function productionHtml(frame) {
  const pct=frame.current.good/5;
  return `<section class="panel"><div class="panel-heading"><h2>Producción · TRQ-01</h2><span class="sim-tag">${frame.current.id==='machine'?'Máquina detenida':frame.current.good===500?'Fabricación completa':frame.current.good===0?'Sin iniciar':'Fabricación en curso'}</span></div><div class="sim-production-number">${count(frame.current.good)} <small>/ 500 cajas conformes</small></div><div class="progress" role="progressbar" aria-label="Fabricación del ejemplo" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div><p class="sim-body-copy">${pct} % fabricado · Lote L-${frame.scenario.orderId} · Pallet P01.</p><p class="muted">Fabricar el 100 % de las cajas no autoriza la salida sin revisión y liberación de Calidad.</p></section>`;
}
function qualityHtml(frame) {
  return `<section class="panel"><div class="panel-heading"><h2>Calidad · Criterio DEMO-01</h2><span class="sim-tag">${frame.current.hold?'Retenido':frame.canDispatch?'Liberación aprobada':'Pendiente'}</span></div><p class="sim-body-copy">Ensayo ficticio de deformación, muestra de 10 cajas, límites de 0 a 3 %. Sirve para demostrar la regla; no es una especificación industrial.</p><div class="sim-inspections">${frame.inspections.length?frame.inspections.map(i=>`<div class="sim-inspection ${i.passed?'pass':'fail'}"><strong>${i.value} % · ${i.passed?'Conforme':'Fuera de rango'}</strong><span>Hora ${i.hours} · Calidad simulada</span>${i.id==='corrected'?'<span>Corrección y verificación documentadas; liberación final aprobada.</span>':''}</div>`).join(''):'<p class="muted">Todavía no se ha realizado el ensayo. Las cajas no tienen autorización de salida.</p>'}</div></section>`;
}
function maintenanceHtml(frame) {
  const repair=frame.run.scenarioId==='negative', failed=frame.history.some(s=>s.id==='machine'), solved=frame.history.some(s=>s.id==='produced');
  return `<section class="panel"><div class="panel-heading"><h2>Mantenimiento · TRQ-01</h2><span class="sim-tag">${repair&&failed&&!solved?'Intervención pendiente':repair&&failed?'Incidencia resuelta':'Equipo disponible'}</span></div><p class="sim-body-copy">${repair&&failed?solved?'La intervención simulada quedó documentada y la fabricación pudo completarse. La alerta activa se retira; la detención permanece en el historial.':'La máquina se detuvo y hay 250 cajas pendientes. Usa «Restituir máquina» para simular la intervención antes de continuar.':'Este punto del recorrido no registra una falla de equipo.'}</p></section>`;
}
function dispatchHtml(frame) {
  const shipped=['in_transit','delivered'].includes(frame.current.stage);
  return `<section class="panel"><div class="panel-heading"><h2>Despacho y entrega</h2><span class="sim-tag">${frame.finished?'Entregado':shipped?'En tránsito':frame.canDispatch?'Salida autorizada':'Salida pendiente'}</span></div><div class="sim-checklist"><p>${frame.current.good===500?'✓':'○'} Cantidad completa: ${frame.current.good} / 500 cajas.</p><p>${frame.canDispatch?'✓':'○'} Ensayo conforme y liberación de Calidad.</p><p>${frame.current.hold?'✕ Lote retenido: despacho bloqueado.':frame.canDispatch?'✓ Expediente del ejemplo revisado.':'○ Revisión final pendiente.'}</p></div><p class="sim-body-copy">Entrega comprometida: ${timestamp(frame.run,16)} (hora 16 del ejemplo). ${frame.finished?`Entrega registrada: ${timestamp(frame.run,frame.current.hours)}.`:'Todavía no hay una entrega registrada.'}</p>${shipped?`<p class="muted">Guía ficticia GD-${frame.scenario.orderId} · Transportista y recepción de demostración.</p>`:''}</section>`;
}
function outcomeHtml(frame) {
  if(!frame.finished) return '';
  const tone=frame.delta>0?'warning':'success', title=frame.delta>0?'Entregado con atraso':frame.delta<0?'Entrega anticipada':'Entregado dentro del plazo';
  return `<section class="sim-outcome ${tone}"><span>RESULTADO DEL EJEMPLO</span><h2>${title}</h2><p>Plazo previsto: 16 h · Tiempo real simulado: ${hours(frame.current.hours)} · ${deltaLabel(frame.delta)}${frame.delta<0?` (${Math.round(-frame.delta/16*100)} % menos tiempo)` : ''}.</p><p>500 cajas entregadas con control conforme y liberación de Calidad. ${frame.run.scenarioId==='negative'?'Las fallas de máquina y Calidad fueron resueltas y conservan su historial.':'No hubo incidencias en este recorrido.'}</p></section>`;
}
export function simulationPage(frame,view='simulaciones',playing=false,storageAvailable=true) {
  const area=Object.hasOwn(SIMULATION_AREAS,view)?view:'simulaciones';
  const relevant=area==='simulaciones'?frame.alerts:frame.alerts.filter(a=>a.area===area);
  const body=area==='produccion'?productionHtml(frame):area==='calidad'?qualityHtml(frame):area==='mantenimiento'?maintenanceHtml(frame):area==='despacho'?dispatchHtml(frame):`<div class="sim-area-grid">${Object.entries(SIMULATION_AREAS).filter(([a])=>a!=='simulaciones').map(([a,label])=>{
    const warnings=frame.alerts.filter(v=>v.area===a), danger=warnings.some(v=>v.level==='danger');
    return `<button class="sim-area-card ${danger?'danger':warnings.length?'warning':'clear'}" data-view="${a}"><span>${label}</span><strong>${warnings.length?`${warnings.length} alerta${warnings.length===1?'':'s'}`:'Sin alertas'}</strong><small>${warnings[0]?.title||'Ver el estado del área'}</small></button>`;
  }).join('')}</div><div class="sim-two-columns">${productionHtml(frame)}${qualityHtml(frame)}</div>`;
  return `<div class="page-heading"><div><p class="eyebrow">PEDIDO ${frame.scenario.orderId} · SOLO DEMOSTRACIÓN</p><h1>${area==='simulaciones'?frame.scenario.name:SIMULATION_AREAS[area]+' · Ejemplo'}</h1><p>${frame.status} · Cliente de demostración · Lote L-${frame.scenario.orderId}.</p></div><span class="sim-tag">+${hours(frame.current.hours)} de reloj simulado</span></div>
  ${controlsHtml(frame,playing)}
  ${!storageAvailable?'<p class="sim-info">El navegador no permite guardar este recorrido. Podrás usarlo, pero se perderá al recargar.</p>':''}
  <div class="sim-stats"><div><span>Fabricación</span><strong>${frame.current.good/5} %</strong></div><div><span>Entrega comprometida</span><strong>16 h</strong></div><div><span>Tiempo transcurrido</span><strong>${hours(frame.current.hours)}</strong></div><div><span>${frame.finished?'Resultado de entrega':'Alertas activas'}</span><strong>${frame.finished?deltaLabel(frame.delta):frame.alerts.length}</strong></div></div>
  <section class="sim-alert-region" aria-label="Alertas ${area==='simulaciones'?'del recorrido':SIMULATION_AREAS[area]}">${alertsHtml(relevant)}</section>
  ${outcomeHtml(frame)}${body}
  <section class="panel"><h2>Plan frente al avance del ejemplo</h2><p class="sim-body-copy">Horas acumuladas desde el ingreso del pedido. Una etapa pendiente no se presenta como cumplida.</p><div class="table-scroll"><table><thead><tr><th>Etapa</th><th>Plan</th><th>Registrado</th><th>Diferencia</th></tr></thead><tbody>${frame.comparison.map(r=>`<tr><td>${r.label}</td><td>${hours(r.planned)}</td><td>${r.actual===null?'Pendiente':hours(r.actual)}</td><td>${r.delta===null?'Por verificar':deltaLabel(r.delta)}</td></tr>`).join('')}</tbody></table></div></section>
  <section class="panel"><h2>Historial del recorrido</h2><ol class="sim-history">${frame.steps.map((s,i)=>`<li class="${i===frame.run.index?'current':i<frame.run.index?'done':'pending'}"><strong>${s.label}</strong><span>${i<=frame.run.index?hours(s.hours)+' · '+timestamp(frame.run,s.hours):'Pendiente'}</span></li>`).join('')}</ol><p class="muted">Datos ficticios. Las diferencias de tiempo de estos recorridos no representan indicadores observados ni sustituyen los escenarios económicos del informe.</p></section>`;
}
