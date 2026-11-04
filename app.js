import {SIMULATION_AREAS,createSimulation,restoreSimulation,advanceSimulation,simulationFrame,simulationHome,simulationPage,simulationNavigation,simulationBanner} from './simulations.js';

const $ = selector => document.querySelector(selector);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = value => Number(value).toLocaleString('es-CL');
const money = value => value == null ? 'Pendiente' : Number(value).toLocaleString('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0});
const date = value => new Date(value.length === 10 ? value+'T15:00:00Z' : value).toLocaleString('es-CL',{timeZone:'America/Santiago',day:'2-digit',month:'short',...(value.length > 10 ? {hour:'2-digit',minute:'2-digit'} : {})});
const names = {received:'Recibido',scheduled:'Programado',production:'En producción',quality:'Control de calidad',ready:'Listo para despacho',in_transit:'En tránsito',delivered:'Entregado'};
const roles = {admin:'Gerencia',production:'Producción',quality:'Calidad',dispatch:'Despacho',administration:'Administración',maintenance:'Mantenimiento',viewer:'Consulta'};
const stages = Object.keys(names);
const areas = {resumen:'Vista general',simulaciones:'Simulaciones',pedidos:'Pedidos',produccion:'Producción',calidad:'Calidad',incidentes:'Incidencias y reclamos',despacho:'Despacho',mantenimiento:'Mantenimiento',piloto:'Piloto e indicadores',proyecto:'Evaluación Caso 2',documentos:'Documentos',finanzas:'Costos e ingresos',historial:'Historial',usuarios:'Usuarios'};
const permissions = {create:['admin','administration'],production:['admin','production'],advance:['admin','production'],quality:['admin','quality'],dispatch:['admin','dispatch'],finance:['admin','administration'],document:['admin','production','quality','dispatch','administration'],note:['admin','production','quality','dispatch','administration']};
let model, me, setup=false, view='resumen', selectedId='', users=[], toastTimer;
let simulationRun=null,simulationActive=false,simulationPlaying=false,simulationTimer=0,simulationUserId='',simulationStorageAvailable=true;
const good = order => order.pallets.reduce((sum,p)=>sum+p.good,0);
const discarded = order => order.pallets.reduce((sum,p)=>sum+p.scrap,0);
const percent = order => Math.floor(good(order)/order.quantity*100);
const has = action => permissions[action]?.includes(me.role);
const orderById = id => model.state.orders.find(o=>o.id===id);
const badge = order => `<span class="badge ${order.hold?'hold':order.stage}">${order.hold?'Retenido':names[order.stage]}</span>`;
const progress = order => `<div class="progress-copy"><span>${n(good(order))} / ${n(order.quantity)}</span><strong>${percent(order)} %</strong></div><div class="progress" role="progressbar" aria-label="Producción conforme" aria-valuenow="${percent(order)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent(order)}%"></i></div>`;
const button = (label,action,id='',primary=false) => `<button class="${primary?'primary':''}" data-action="${action}" data-id="${h(id)}">${label}</button>`;
const field = (label,content) => `<label>${label}${content}</label>`;
const input = (name,type='text',value='',extra='') => `<input name="${name}" type="${type}" value="${h(value)}" ${extra}>`;
const empty = text => `<p class="empty">${text}</p>`;

// El recorrido queda en este navegador y usuario. Nunca se envía a /api/workspace.
const simulationStorageKey=()=>`australpack-simulation-v1-${me.id}`;
function readSavedSimulation(){
  if(simulationUserId===me.id)return;
  stopSimulationPlayback();simulationActive=false;simulationRun=null;simulationUserId=me.id;simulationStorageAvailable=true;
  try {const saved=localStorage.getItem(simulationStorageKey());if(saved){try{simulationRun=restoreSimulation(JSON.parse(saved));}catch{simulationRun=null;}}}
  catch{simulationStorageAvailable=false;}
}
function saveSimulation(){
  try{localStorage.setItem(simulationStorageKey(),JSON.stringify(simulationRun));simulationStorageAvailable=true;}
  catch{simulationStorageAvailable=false;}
}
function stopSimulationPlayback(){clearTimeout(simulationTimer);simulationTimer=0;simulationPlaying=false;}
function renderSimulation(){
  const frame=simulationFrame(simulationRun),focusId=document.activeElement?.id;
  if(!Object.hasOwn(SIMULATION_AREAS,view))view='simulaciones';
  $('#profile-name').textContent=me.name;$('#profile-role').textContent=roles[me.role];
  $('#portal .nav-label').textContent='ÁREAS DEL EJEMPLO';
  $('#navigation').innerHTML=simulationNavigation(frame,view);
  $('#portal .banner').hidden=true;$('#simulation-banner').hidden=false;
  $('#simulation-banner').innerHTML=simulationBanner(frame);
  $('#content').innerHTML=simulationPage(frame,view,simulationPlaying,simulationStorageAvailable);
  const nextFocus=focusId?document.getElementById(focusId):null;
  if(nextFocus&&!nextFocus.disabled)nextFocus.focus({preventScroll:true});
}
function stepSimulation(action='next',automatic=false){
  if(!simulationActive||!simulationRun)throw new Error('Inicia un recorrido desde Simulaciones.');
  if(!automatic)stopSimulationPlayback();
  simulationRun=advanceSimulation(simulationRun,action);saveSimulation();
  const frame=simulationFrame(simulationRun);
  if(frame.finished||frame.current.requires)stopSimulationPlayback();
  render();
}
function queueSimulationStep(){
  clearTimeout(simulationTimer);
  if(!simulationPlaying)return;
  simulationTimer=setTimeout(()=>{
    try{stepSimulation('next',true);if(simulationPlaying)queueSimulationStep();}
    catch(error){stopSimulationPlayback();render();toast(error.message);}
  },2200);
}
function simulationAction(action,target){
  if(action==='sim-start'){
    stopSimulationPlayback();simulationRun=createSimulation(target.dataset.scenario);simulationActive=true;view='simulaciones';saveSimulation();
  }else if(action==='sim-resume'){
    if(!restoreSimulation(simulationRun))throw new Error('Selecciona un caso para iniciar.');
    stopSimulationPlayback();simulationActive=true;view='simulaciones';
  }else if(action==='sim-exit'||action==='sim-choose'){
    stopSimulationPlayback();simulationActive=false;view=action==='sim-exit'?'resumen':'simulaciones';
  }else{
    if(!simulationActive||!simulationRun)throw new Error('Inicia un recorrido desde Simulaciones.');
    if(action==='sim-restart'){
      stopSimulationPlayback();simulationRun=createSimulation(simulationRun.scenarioId);saveSimulation();
    }else if(action==='sim-play'){
      const frame=simulationFrame(simulationRun);
      if(simulationPlaying)stopSimulationPlayback();
      else if(!frame.finished&&!frame.current.requires){simulationPlaying=true;queueSimulationStep();}
    }else if(['sim-next','sim-repair','sim-correct'].includes(action)){
      stepSimulation(action.slice(4));return;
    }else throw new Error('Control de simulación desconocido.');
  }
  render();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&simulationPlaying){stopSimulationPlayback();if(me)render();}});

async function api(path,{method='GET',data,form}={}) {
  const response = await fetch(path,{method,credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:undefined,body:form || (data?JSON.stringify(data):undefined)});
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'No se pudo completar la acción.'); error.status=response.status; throw error;
  }
  return result;
}
function toast(message) {
  $('#toast').textContent=message; $('#toast').hidden=false;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,5000);
}
async function authenticate() {
  const auth=await api('/api/auth'); setup=auth.setup; me=auth.user;
  $('#access').hidden=Boolean(me); $('#portal').hidden=!me;
  if (me) {
    await load();
    const linked=new URLSearchParams(location.search).get('pedido');
    if(linked&&orderById(linked)){selectedId=linked;view='detalle';render();}
    return;
  }
  $('#auth-title').textContent=setup?'Crear cuenta inicial':'Acceso al sistema';
  $('#auth-description').textContent=setup?'Crea la cuenta de Gerencia para comenzar. La contraseña debe tener al menos 10 caracteres.':'Ingresa con el correo y la contraseña asignados a tu cuenta.';
  $('#name-field').hidden=!setup; $('#name-field input').required=setup;
  $('#password').minLength=10; $('#password').autocomplete=setup?'new-password':'current-password';
  $('#auth-submit').textContent=setup?'Crear cuenta de Gerencia':'Ingresar';
}
async function load() {
  model=await api('/api/workspace'); me=model.user;
  readSavedSimulation();
  if (view==='usuarios' && me.role!=='admin') view='resumen';
  if (view==='finanzas' && !has('finance')) view='resumen';
  if (view==='usuarios') users=(await api('/api/users')).users;
  render();
}
async function mutate(action,payload) {
  try { model=await api('/api/workspace',{method:'POST',data:{action,payload,revision:model.revision}}); me=model.user; render(); }
  catch(error) { if(error.status===409) await load(); throw error; }
}
function heading(title,description='',actions='') {
  return `<div class="page-heading"><div><p class="eyebrow">AUSTRALPACK CIRCULAR SpA</p><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
}
function toolbar(filters=true) {
  return `<div class="toolbar"><input id="search" aria-label="Buscar" placeholder="Buscar pedido, cliente o documento…">${filters?`<select id="filter" aria-label="Filtrar estado"><option value="all">Todos los estados</option>${stages.map(s=>`<option value="${s}">${names[s]}</option>`).join('')}<option value="hold">Retenidos</option></select>`:''}</div>`;
}
function stageAction(order) {
  if(order.hold) return has('quality')?button('Revisar retención','quality',order.id):'';
  if(['received','scheduled'].includes(order.stage)&&has('advance')) return button(order.stage==='received'?'Programar':'Iniciar producción','advance',order.id);
  if(order.stage==='production'&&has('production')) return good(order)===order.quantity?button('Enviar a Calidad','advance',order.id):button('Registrar producción','production',order.id);
  if(order.stage==='quality'&&has('quality')) return button('Registrar control','quality',order.id);
  if(['ready','in_transit'].includes(order.stage)&&has('dispatch')) return button(order.stage==='ready'?'Registrar salida':'Confirmar entrega','dispatch',order.id);
  return '';
}
function ordersTable(orders,actions=false) {
  if(!orders.length) return empty('No hay pedidos en esta etapa.');
  return `<div class="table-scroll"><table><thead><tr><th>Pedido / cliente</th><th>Estado</th><th>Producción</th><th>Entrega</th><th>Acciones</th></tr></thead><tbody>${orders.map(o=>`<tr data-search="${h(o.id+' '+o.client+' '+o.lot)}" data-stage="${o.stage}" data-hold="${o.hold}"><td><button class="order-link" data-open="${o.id}">${o.id}</button><small>${h(o.client)}</small></td><td>${badge(o)}</td><td>${progress(o)}</td><td>${date(o.due)}</td><td><div class="actions"><button data-open="${o.id}">Ver pedido</button>${actions?stageAction(o):''}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function activity(events) {
  return events.length?events.map(e=>`<div class="activity"><strong>${h(e.orderId)} · ${h(e.area)}</strong><p>${h(e.message)}</p><small>${date(e.at)} · ${h(e.actor)}${e.palletId?' · '+h(e.palletId):''}</small></div>`).join(''):empty('Todavía no hay eventos.');
}
function documentsTable(documents) {
  return documents.length?`<div class="table-scroll"><table><thead><tr><th>Documento</th><th>Pedido</th><th>Área</th><th>Fecha</th><th></th></tr></thead><tbody>${documents.map(d=>`<tr data-search="${h(d.name+' '+d.orderId+' '+d.kind)}"><td>${h(d.name)}<small>${h(d.kind)}</small></td><td><button data-open="${h(d.orderId)}">${h(d.orderId)}</button></td><td>${h(d.area)}</td><td>${date(d.at)}</td><td><a href="/api/documents?id=${encodeURIComponent(d.id)}">Descargar</a></td></tr>`).join('')}</tbody></table></div>`:empty('Adjunta los documentos de este pedido para reunir su expediente.');
}
function overview() {
  const orders=model.state.orders, active=orders.filter(o=>o.stage!=='delivered'), held=orders.filter(o=>o.hold), ready=orders.filter(o=>o.stage==='ready');
  return heading('Resumen de operaciones','Todo el equipo trabaja con los mismos pedidos.',has('create')?button('+ Nuevo pedido','create','',true):'')+
    `<div class="stats">${[['Pedidos activos',active.length],['Cajas conformes en curso',active.reduce((sum,o)=>sum+good(o),0)],['Lotes retenidos',held.length],['Listos para despacho',ready.length]].map(([label,value])=>`<div class="stat"><span>${label}</span><strong>${n(value)}</strong></div>`).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-heading"><h2>Pedidos en seguimiento</h2></div>${ordersTable(active.slice(0,5))}</section><section class="panel"><div class="panel-heading"><h2>Atención de Calidad</h2></div>${held.length?held.map(o=>`<div class="notice"><strong>${o.id} · ${h(o.client)}</strong><small>${h(o.holdReason)}</small><div class="actions"><button data-open="${o.id}">Revisar pedido</button></div></div>`).join(''):empty('Sin retenciones activas.')}</section></div><section class="panel"><div class="panel-heading"><h2>Última actividad</h2></div>${activity(model.state.events.slice(0,4))}</section>`;
}
function detail() {
  const order=orderById(selectedId); if(!order)return empty('Pedido no encontrado.');
  const index=stages.indexOf(order.stage), highlighted=new URLSearchParams(location.search).get('pallet');
  const controls=stageAction(order)+(has('quality')&&['production','quality','ready'].includes(order.stage)?button('Control de calidad','quality',order.id):'');
  return `<button class="back" data-view="pedidos">← Todos los pedidos</button>`+heading(`${order.id} · ${h(order.client)}`,`${h(order.format)} · ${n(order.quantity)} cajas`,controls)+
    (order.hold?`<div class="warning"><strong>Pedido retenido:</strong> ${h(order.holdReason)}</div>`:'')+
    `<div class="detail-grid"><section class="panel"><div class="panel-heading"><h2>Avance de producción</h2>${badge(order)}</div><div class="big-number">${percent(order)} %</div>${progress(order)}<div class="mini-metrics"><div><span>Conformes</span><strong>${n(good(order))}</strong></div><div><span>Por completar</span><strong>${n(order.quantity-good(order))}</strong></div><div><span>Scrap</span><strong>${n(discarded(order))}</strong></div></div><p class="muted">Lote: ${h(order.lot)} · Entrega prevista: ${date(order.due)}</p><p class="muted">Liberación final: ${order.qualityApproved?'Aprobada por Calidad':'Pendiente'}</p>${order.guide?`<p class="muted">Guía: ${h(order.guide)} · Transportista: ${h(order.carrier)}</p>`:''}${order.receiver?`<p class="muted">Recibido por: ${h(order.receiver)}</p>`:''}<div class="actions">${has('note')?button('Agregar observación','note',order.id):''}</div></section><section class="panel"><div class="panel-heading"><h2>Recorrido del pedido</h2></div><ol class="timeline">${stages.map((s,i)=>`<li class="${i<index?'done':i===index?'current':''}">${names[s]}<small>${i<index?'Completada':i===index?'Etapa actual':'Pendiente'}</small></li>`).join('')}</ol></section></div><section class="panel"><div class="panel-heading"><h2>Pallets y códigos QR</h2><a href="/api/labels?pedido=${order.id}" target="_blank" rel="noopener">Imprimir etiquetas</a></div><div class="pallets">${order.pallets.map(p=>`<article class="pallet ${highlighted===p.id?'highlight':''}"><img src="/api/qr?pallet=${encodeURIComponent(p.id)}" alt="QR del pallet ${p.id}"><strong>${p.id}</strong><span>${n(p.good)} / ${n(p.planned)} conformes</span><small>${n(p.scrap)} descartadas</small></article>`).join('')}</div></section><section class="panel"><div class="panel-heading"><h2>Documentos del pedido</h2>${has('document')?button('Adjuntar documento','document',order.id):''}</div>${documentsTable(model.state.documents.filter(d=>d.orderId===order.id))}</section><section class="panel"><div class="panel-heading"><h2>Historial de ${order.id}</h2></div>${activity(model.state.events.filter(e=>e.orderId===order.id))}</section>`;
}
function finances() {
  const orders=model.state.orders;
  const totals=['sale','invoiced','received'].map(key=>orders.reduce((sum,o)=>sum+(o.finance[key]??0),0));
  return heading('Costos e ingresos','Importes en pesos chilenos.',`<a href="/api/export?tipo=finanzas">Exportar CSV</a>`)+`<div class="stats">${['Venta registrada','Facturado','Cobrado'].map((label,i)=>`<div class="stat"><span>${label}</span><strong>${money(totals[i])}</strong></div>`).join('')}</div><section class="panel"><div class="table-scroll"><table><thead><tr><th>Pedido</th><th>Venta</th><th>Facturado</th><th>Cobrado</th><th>Margen estimado</th><th></th></tr></thead><tbody>${orders.map(o=>{const f=o.finance,costs=[f.material,f.labor,f.transport,f.other],margin=f.sale!==null&&costs.every(v=>v!==null)?f.sale-costs.reduce((a,b)=>a+b,0):null;return `<tr><td><button data-open="${o.id}">${o.id}</button><small>${h(o.client)}</small></td><td>${money(f.sale)}</td><td>${money(f.invoiced)}</td><td>${money(f.received)}</td><td>${margin===null?'Faltan costos':money(margin)}</td><td>${button('Editar','finance',o.id)}</td></tr>`;}).join('')}</tbody></table></div><p class="muted">Margen estimado = venta − material − mano de obra − transporte − otros costos registrados.</p></section>`;
}
function usersView() {
  return heading('Usuarios y permisos','Gerencia crea las cuentas y asigna el área de trabajo.',button('+ Crear usuario','user','',true))+`<section class="panel"><div class="table-scroll"><table class="users"><thead><tr><th>Nombre</th><th>Correo</th><th>Perfil</th></tr></thead><tbody>${users.map(user=>`<tr><td>${h(user.name)}${user.owner?'<small>Propietario</small>':''}</td><td>${h(user.email)}</td><td><select data-user="${user.id}" aria-label="Perfil de ${h(user.name)}" ${user.owner?'disabled':''}>${Object.entries(roles).map(([value,label])=>`<option value="${value}" ${user.role===value?'selected':''}>${label}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div></section>`;
}
function renderBase() {
  $('#profile-name').textContent=me.name; $('#profile-role').textContent=roles[me.role];
  $('#navigation').innerHTML=Object.entries(areas).filter(([id])=>(id!=='finanzas'||has('finance'))&&(id!=='usuarios'||me.role==='admin')).map(([id,label])=>`<button data-view="${id}" class="${view===id||view==='detalle'&&id==='pedidos'?'active':''}">${label}</button>`).join('');
  const orders=model.state.orders;
  let html='';
  if(view==='resumen') html=overview();
  if(view==='pedidos') html=heading('Pedidos','Consulta el avance y el historial de cada orden.',has('create')?button('+ Nuevo pedido','create','',true):'')+`<section class="panel"><div class="panel-heading"><h2>Listado de pedidos</h2><a href="/api/export">Exportar CSV</a></div>${toolbar()}${ordersTable(orders,true)}</section>`;
  if(view==='produccion') html=heading('Producción','Registra cajas conformes y descartadas por pallet.')+`<section class="panel">${toolbar()}${ordersTable(orders.filter(o=>['received','scheduled','production','quality'].includes(o.stage)),true)}</section>`;
  if(view==='calidad') html=heading('Calidad','Las retenciones bloquean el avance y el despacho.')+`<section class="panel">${toolbar()}<div class="table-scroll"><table><thead><tr><th>Pedido</th><th>Estado</th><th>Observación</th><th></th></tr></thead><tbody>${orders.filter(o=>['production','quality','ready'].includes(o.stage)).map(o=>`<tr data-search="${h(o.id+' '+o.client+' '+o.lot)}" data-stage="${o.stage}" data-hold="${o.hold}"><td><button data-open="${o.id}">${o.id}</button><small>${h(o.client)}</small></td><td>${badge(o)}</td><td>${h(o.hold?o.holdReason:o.qualityApproved?'Liberación final aprobada.':'Liberación final pendiente.')}</td><td>${has('quality')?button('Registrar control','quality',o.id):''}</td></tr>`).join('')}</tbody></table></div></section>`;
  if(view==='despacho') html=heading('Despacho','Registra la salida y la recepción del pedido.')+`<section class="panel">${toolbar()}${ordersTable(orders.filter(o=>['ready','in_transit','delivered'].includes(o.stage)),true)}</section>`;
  if(view==='documentos') html=heading('Documentos','Un expediente compartido por pedido.',has('document')?button('+ Adjuntar','document','',true):'')+`<section class="panel">${toolbar(false)}${documentsTable(model.state.documents)}</section>`;
  if(view==='finanzas'&&has('finance')) html=finances();
  if(view==='historial') html=heading('Historial','Cada cambio conserva su fecha y responsable.')+`<section class="panel">${activity(model.state.events)}</section>`;
  if(view==='usuarios'&&me.role==='admin') html=usersView();
  if(view==='detalle') html=detail();
  $('#content').innerHTML=html;
}
function openModalBase(kind,id='') {
  const order=orderById(id), form=$('#operation-form'); form.dataset.kind=kind; form.dataset.orderId=id;
  let fields='',title='';
  if(kind==='create') {title='Crear pedido';fields=field('Cliente',input('client','text','','required maxlength="100"'))+field('Formato de caja',input('format','text','','required maxlength="120"'))+`<div class="form-grid">${field('Cantidad de cajas',input('quantity','number','','required min="1" max="50000"'))}${field('Cajas por pallet',input('capacity','number',500,'required min="50" max="2000"'))}${field('Entrega prevista',input('due','date','','required'))}${field('Prioridad','<select name="priority"><option value="normal">Normal</option><option value="high">Alta</option></select>')}</div>`+field('Valor de venta en CLP · Opcional',input('sale','number','','min="0" max="10000000000"'));}
  if(kind==='production') {title='Registrar producción';fields=field('Pallet',`<select name="palletId" id="production-pallet">${order.pallets.map(p=>`<option value="${p.id}" ${p.id===order.pallets.find(v=>v.good<v.planned)?.id?'selected':''}>${p.id} · ${p.planned-p.good} pendientes</option>`).join('')}</select>`)+`<div class="form-grid">${field('Nuevas cajas conformes',input('good','number',0,'required min="0" max="50000"'))}${field('Nuevas cajas descartadas',input('scrap','number',0,'required min="0" max="50000"'))}</div>`+field('Observación · Opcional','<textarea name="note" maxlength="400"></textarea>');}
  if(kind==='quality') {title='Control de calidad';fields=(order.hold?`<p class="warning">${h(order.holdReason)}</p>`:'')+field('Acción',`<select name="result">${order.hold?'<option value="resolve">Resolver retención</option>':`<option value="hold">Retener lote</option>${order.stage==='quality'?'<option value="release">Aprobar control final y liberar</option>':''}`}</select>`)+field('Resultado de revisión o motivo','<textarea name="note" required maxlength="500"></textarea>');}
  if(kind==='dispatch') {const delivered=order.stage==='in_transit';title=delivered?'Confirmar entrega':'Registrar salida';fields=input('step','hidden',delivered?'deliver':'ship')+(delivered?field('Recibido por',input('receiver','text','','required maxlength="120"')):field('Transportista',input('carrier','text','','required maxlength="120"'))+field('Número de guía',input('guide','text','','required maxlength="80"')));}
  if(kind==='note') {title='Agregar observación';fields=field('Observación para el equipo','<textarea name="note" required maxlength="600"></textarea>');}
  if(kind==='finance') {title='Costos e ingresos';fields='<p class="form-note">Importes en CLP. Deja vacíos los datos que aún falten.</p><div class="form-grid">'+Object.entries({sale:'Valor de venta',invoiced:'Facturado',received:'Cobrado',material:'Material',labor:'Mano de obra',transport:'Transporte',other:'Otros costos'}).map(([key,label])=>field(label,input(key,'number',order.finance[key]??'','min="0" max="10000000000"'))).join('')+'</div>';}
  if(kind==='document') {title='Adjuntar documento';fields=field('Pedido',`<select name="orderId" required><option value="">Selecciona un pedido</option>${model.state.orders.map(o=>`<option value="${o.id}" ${o.id===id?'selected':''}>${o.id} · ${h(o.client)}</option>`).join('')}</select>`)+field('Tipo de documento',`<select name="kind">${['Orden de compra','Orden de producción','Control de calidad','Guía de despacho',...(has('finance')?['Factura']:[]),'Otro'].map(v=>`<option>${v}</option>`).join('')}</select>`)+field('Archivo · Máximo 8 MB','<input name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.csv,.xls,.xlsx,.doc,.docx,.txt">');}
  if(kind==='user') {title='Crear usuario';fields=field('Nombre',input('name','text','','required maxlength="100"'))+field('Correo',input('email','email','','required maxlength="150"'))+field('Contraseña inicial',input('password','password','','required minlength="10" maxlength="200" autocomplete="new-password"'))+field('Perfil',`<select name="role">${Object.entries(roles).map(([key,label])=>`<option value="${key}" ${key==='viewer'?'selected':''}>${label}</option>`).join('')}</select>`);}
  $('#modal-title').textContent=title+(order?' · '+order.id:'');
  form.innerHTML=fields+'<p id="form-error" class="error" role="alert"></p><div class="form-footer"><button type="submit" class="primary">Guardar</button></div>';
  $('#modal').showModal();
}

$('#auth-form').addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.currentTarget, submit=$('#auth-submit'); submit.disabled=true; $('#auth-error').textContent='';
  try {await api(setup?'/api/setup':'/api/login',{method:'POST',data:Object.fromEntries(new FormData(form))});form.reset();await authenticate();}
  catch(error){$('#auth-error').textContent=error.message;}finally{submit.disabled=false;}
});
$('#operation-form').addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.currentTarget, submit=form.querySelector('[type="submit"]'); submit.disabled=true; $('#form-error').textContent='';
  try {
    const values=new FormData(form), kind=form.dataset.kind;
    for(const key of ['occurredAt','start','end']) if(values.get(key)) values.set(key,new Date(values.get(key)).toISOString());
    if(kind==='document'){values.set('revision',model.revision);await api('/api/documents',{method:'POST',form:values});await load();}
    else if(kind==='user'){await api('/api/users',{method:'POST',data:Object.fromEntries(values)});await load();}
    else await mutate(kind,{...Object.fromEntries(values),orderId:form.dataset.orderId || values.get('orderId') || ''});
    $('#modal').close(); toast('Cambio guardado para todas las áreas.');
  } catch(error){if(error.status===409)await load();$('#form-error').textContent=error.message;}finally{submit.disabled=false;}
});
$('#close-modal').addEventListener('click',()=>$('#modal').close());
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-view],[data-open],[data-action]'); if(!target)return;
  try {
    if(target.dataset.view){view=target.dataset.view;if(simulationActive){render();return;}await load();return;}
    if(target.dataset.open){selectedId=target.dataset.open;view='detalle';render();return;}
    const action=target.dataset.action;
    if(action?.startsWith('sim-')){simulationAction(action,target);if(action==='sim-exit')await load();return;}
    if(simulationActive&&!['logout','refresh'].includes(action))throw new Error('Sal de la simulación para registrar operaciones.');
    if(action==='logout'){stopSimulationPlayback();simulationActive=false;simulationRun=null;simulationUserId='';await api('/api/logout',{method:'POST',data:{}});me=null;view='resumen';await authenticate();}
    else if(action==='refresh'){if(simulationActive){render();toast('El reloj del ejemplo avanza con sus controles.');}else{await load();toast('Datos actualizados.');}}
    else if(action==='advance'){target.disabled=true;await mutate('advance',{orderId:target.dataset.id});toast('Etapa actualizada.');}
    else if(action==='demo'){target.disabled=true;await mutate('demo',{});view='incidentes';render();toast('Ejemplo Caso 2 cargado sin reemplazar tus pedidos.');}
    else openModal(action,target.dataset.id);
  }catch(error){toast(error.message);target.disabled=false;}
});
function filterRows(){const text=($('#search')?.value??'').toLowerCase(),status=$('#filter')?.value??'all';document.querySelectorAll('#content tr[data-search]').forEach(row=>row.hidden=!row.dataset.search.toLowerCase().includes(text)||!(status==='all'||status==='hold'&&row.dataset.hold==='true'||row.dataset.stage===status));}
document.addEventListener('input',event=>{if(event.target.id==='search')filterRows();});
document.addEventListener('change',async event=>{
  if(event.target.id==='filter')filterRows();
  if(event.target.dataset.user){try{await api('/api/users',{method:'POST',data:{id:event.target.dataset.user,role:event.target.value}});await load();toast('Permisos actualizados.');}catch(error){toast(error.message);await load();}}
});
authenticate().catch(error=>$('#auth-error').textContent=error.message);
setInterval(()=>{if(me&&!simulationActive&&!$('#modal').open&&document.visibilityState==='visible')load().catch(error=>toast(error.message));},30000);

// Extensiones del demostrador Caso 2. Las reglas se vuelven a validar en el servidor.
Object.assign(permissions, {
  inspection:['admin','quality'], trace_review:['admin','quality'],
  incident:['admin','quality','dispatch'], incident_update:['admin','quality'],
  maintenance:['admin','maintenance'], sample:['admin','production','quality','maintenance'],
  sample_review:['admin','quality'], pilot_config:['admin'], demo:['admin'],
});
let metricSource='pilot';
const shiftLabels={day:'Diurno',night:'Nocturno'};
const incidentLabels={open:'Abierta',contained:'Contenida',investigation:'En investigación',closed:'Cerrada'};
const selects=(name,options,current='',required=true)=>`<select name="${name}" ${required?'required':''}>${options.map(([value,label])=>`<option value="${h(value)}" ${value===current?'selected':''}>${h(label)}</option>`).join('')}</select>`;
const equipmentInput=(current='TRQ-01')=>field('Equipo utilizado',selects('equipmentId',model.state.equipment.map(e=>[e.id,e.id+' · '+e.name]),current));
const shiftInput=()=>field('Turno',selects('shift',Object.entries(shiftLabels),'day'));
const orderInput=()=>field('Pedido y lote',selects('orderId',[['','Selecciona un pedido'],...model.state.orders.map(o=>[o.id,o.id+' · '+o.lot])],''));
const textarea=(name,required=true,value='',max=700)=>`<textarea name="${name}" ${required?'required':''} maxlength="${max}">${h(value)}</textarea>`;
const recordFields=r=>({...r,...(r.review?.fields||{})});
const recordComplete=r=>Boolean(recordFields(r).at&&recordFields(r).equipmentId&&recordFields(r).shift&&(r.captureMode==='online'||r.review));
const formatMetric=(value,suffix='')=>value==null?'Sin dato':Number(value).toLocaleString('es-CL',{maximumFractionDigits:2})+suffix;
function inspectionsTable(items){
  return items.length?`<div class="table-scroll"><table><thead><tr><th>Fecha / lote</th><th>Equipo / turno</th><th>Ensayo y criterio</th><th>Resultado</th><th>Revisó</th></tr></thead><tbody>${items.map(i=>`<tr><td>${date(i.at)}<small>${h(i.lot)}</small></td><td>${h(i.equipmentId)}<small>${shiftLabels[i.shift]}</small></td><td>${h(i.parameter)}<small>${h(i.criterionRef)} · Muestra ${n(i.sampleSize)}</small></td><td><span class="badge ${i.passed?'ready':'hold'}">${i.passed?'Conforme':'No conforme'}</span><small>${h(i.value)} ${h(i.unit)} · Límites ${i.lower??'—'} / ${i.upper??'—'}</small></td><td>${h(i.actor)}</td></tr>`).join('')}</tbody></table></div>`:empty('Todavía no hay ensayos con criterio y medición registrados.');
}
function incidentsTable(items){
  return items.length?`<div class="table-scroll"><table><thead><tr><th>Lote / origen</th><th>Incidencia</th><th>Cajas</th><th>Responsable</th><th>Estado</th><th>Respuesta</th></tr></thead><tbody>${items.map(i=>`<tr data-search="${h(i.orderId+' '+i.lot+' '+i.description)}"><td><button data-open="${h(i.orderId)}">${h(i.lot)}</button><small>${i.source==='client'?'Cliente':i.source==='quality'?'Calidad':'Despacho'} · ${date(i.at)}</small></td><td>${h(i.description)}</td><td>${n(i.affected)}</td><td>${h(i.assignedTo)}</td><td><span class="badge ${i.status==='closed'?'ready':'hold'}">${incidentLabels[i.status]}</span></td><td>${h(i.containment||'Contención pendiente')}${i.verification?`<small>Verificación: ${h(i.verification)}</small>`:''}${i.status!=='closed'&&has('incident_update')?button('Registrar respuesta','incident_update',i.id):''}</td></tr>`).join('')}</tbody></table></div>`:empty('No hay incidencias registradas.');
}
function tracePanel(order){
  const records=model.state.productionRecords.filter(r=>r.orderId===order.id),pending=records.filter(r=>!recordComplete(r));
  const controls=model.state.inspections.filter(i=>i.orderId===order.id);
  return `<section class="panel"><div class="panel-heading"><div><h2>Trazabilidad y auditoría</h2><p class="muted">Lote, fecha real, equipo, turno y resultado por registro.</p></div><div class="actions"><a href="/api/audit?pedido=${order.id}" target="_blank" rel="noopener">Expediente imprimible</a><a href="/api/audit?pedido=${order.id}&formato=json">Descargar JSON</a></div></div>${pending.length?`<p class="warning">${n(pending.length)} registros pendientes de revisión. Los datos anteriores no se completan automáticamente.</p>`:'<p class="success-note">Los registros de producción presentes tienen sus campos de trazabilidad completos.</p>'}${has('inspection')?button('Registrar ensayo de calidad','inspection',order.id):''}${has('incident')?button('Registrar incidencia o reclamo','incident',order.id):''}<div class="table-scroll"><table><thead><tr><th>Pallet / fecha real</th><th>Equipo / turno</th><th>Conformes / scrap</th><th>Origen y revisión</th><th></th></tr></thead><tbody>${records.slice(0,30).map(r=>{const e=recordFields(r);return `<tr><td>${h(r.palletId)}<small>${e.at?date(e.at):'Sin fecha original'}</small></td><td>${h(e.equipmentId||'Pendiente')}<small>${shiftLabels[e.shift]||'Turno pendiente'}</small></td><td>${n(r.good)} / ${n(r.scrap)}</td><td>${r.captureMode==='legacy'?'Registro anterior':r.captureMode==='manual'?'Contingencia manual':'Captura directa'}<small>${h(r.sourceRef||'')}${r.review?' · Revisó '+h(r.review.actor):''}</small></td><td>${!recordComplete(r)&&has('trace_review')?button('Revisar con evidencia','trace_review',r.id):recordComplete(r)?'Completo':'Pendiente'}</td></tr>`;}).join('')}</tbody></table></div>${records.length>30?`<p class="muted">Se muestran 30 de ${n(records.length)} registros. El expediente descargable incluye todos.</p>`:''}</section><section class="panel"><h2>Controles y resultados</h2>${inspectionsTable(controls)}</section><section class="panel"><h2>Incidencias del lote</h2>${incidentsTable(model.state.incidents.filter(i=>i.orderId===order.id))}</section>`;
}
function maintenanceView(){
  const items=model.state.maintenanceRecords;
  return heading('Mantenimiento','Registro de detenciones y respuesta del equipo.',has('maintenance')?button('+ Registrar detención','maintenance','',true):'')+`<section class="panel"><p>Catálogo: ${model.state.equipment.map(e=>h(e.id+' · '+e.name)).join(' / ')}</p><p class="muted">Las detenciones se contrastan con la hoja del turno. La disponibilidad del piloto usa minutos programados y detenidos validados, sin sumar dos veces un mismo intervalo.</p>${items.length?`<div class="table-scroll"><table><thead><tr><th>Equipo / turno</th><th>Intervalo</th><th>Minutos</th><th>Motivo y respuesta</th><th>Responsable</th></tr></thead><tbody>${items.map(i=>`<tr><td>${h(i.equipmentId)}<small>${shiftLabels[i.shift]}</small></td><td>${date(i.start)}<small>${date(i.end)}</small></td><td>${formatMetric(i.minutes)}</td><td>${h(i.reason)}<small>${h(i.intervention)}</small></td><td>${h(i.actor)}</td></tr>`).join('')}</tbody></table></div>`:empty('Todavía no hay detenciones registradas.')}</section>`;
}
function pilotView(){
  const metric=model.state.metrics[metricSource],v=metric.values,cfg=model.state.pilotConfig;
  const definitions=[['Ciclo medio',v.cycle,' h','10,5 h','≤ 8,5 h','≤ 10,1 h','Suma de ciclos de lotes terminados / lotes terminados'],['Scrap',v.scrap,' %','7,6 %','≤ 5 %','≤ 7,6 %','Cajas descartadas / total de cajas producidas × 100'],['OTIF',v.otif,' %','89 %','≥ 95 %','≥ 91,5 %','Pedidos completos y a tiempo / pedidos comprometidos de la cohorte × 100'],['Disponibilidad',v.availability,' %','80 %','≥ 94 %','≥ 80 %','(Minutos programados − detenidos) / programados × 100 en troqueladora'],['Reclamos',v.claims,' / 10.000','12 / 10.000','≤ 6 / 10.000','≤ 12 / 10.000','Reclamos / cajas embarcadas de la misma cohorte × 10.000'],['Trazabilidad',v.trace,' %','Sin dato','96 % estimado C','≥ 96 %','Registros completos / registros de producción del alcance × 100']];
  return heading('Piloto e indicadores','Mediciones validadas y fórmulas visibles. Los umbrales del piloto son una propuesta del equipo.',has('sample')?button('+ Registrar medición','sample','',true):'')+`<section class="panel"><div class="panel-heading"><label>Fuente de las mediciones<select id="metric-source"><option value="pilot" ${metricSource==='pilot'?'selected':''}>Piloto observado</option><option value="simulation" ${metricSource==='simulation'?'selected':''}>Ejemplo simulado</option></select></label><a href="/api/pilot-export?fuente=${metricSource}">Exportar mediciones CSV</a></div><p class="${metricSource==='simulation'?'warning':'form-note'}">${metricSource==='simulation'?'Ejemplo simulado. Estas cifras no prueban mejoras en planta.':'Se excluyen mediciones simuladas, anuladas y pendientes de validación.'}</p><div class="decision-box"><strong>${h(metric.decision)}</strong><p>${h(metric.reasons.join(' '))}</p></div><p>${n(metric.sampleCount)} mediciones validadas · Diurno ${n(metric.shifts.day)} · Nocturno ${n(metric.shifts.night)} · ${n(metric.pending)} pendientes.</p><div class="table-scroll"><table><thead><tr><th>Indicador</th><th>Resultado</th><th>Base Caso 2</th><th>Meta global</th><th>Umbral para continuar</th><th>Cálculo</th></tr></thead><tbody>${definitions.map(([name,value,suffix,base,target,gate,formula])=>`<tr><td>${name}</td><td><strong>${formatMetric(value,suffix)}</strong></td><td>${base}</td><td>${target}</td><td>${gate}</td><td>${formula}</td></tr>`).join('')}</tbody></table></div><p class="muted">Denominadores: ${n(metric.denominators.lots)} lotes, ${n(metric.denominators.boxes)} cajas producidas, ${n(metric.denominators.orders)} pedidos, ${n(metric.denominators.minutes)} minutos programados y ${n(metric.denominators.shipped)} cajas embarcadas. La trazabilidad usa ${n(metric.denominators.records)} registros del alcance y se informa por separado de la cohorte de indicadores.</p></section><section class="panel"><div class="panel-heading"><h2>Condiciones del piloto</h2>${has('pilot_config')?button('Registrar condiciones','pilot_config'):''}</div><p>Inspección mantenida: <b>${cfg.inspectionMaintained==='yes'?'Sí, documentada':cfg.inspectionMaintained==='no'?'No':'Sin verificar'}</b> · Ausencia de desvinculaciones por automatización: <b>${cfg.noLayoffs==='yes'?'Documentada':cfg.noLayoffs==='no'?'No se cumple':'Sin verificar'}</b></p><p>Detención consecutiva: ${cfg.stopDays==null?'Sin verificar':n(cfg.stopDays)+' días'}${has('finance')?' · Costo año 1: '+money(cfg.costYear1):''}</p><p class="muted">${h(cfg.evidence||'Falta registrar la evidencia de las condiciones.')} Se exige un mínimo propuesto de cinco mediciones validadas por turno antes de decidir. Continuar el piloto no equivale a acreditar todas las metas ni autoriza automáticamente el escalamiento.</p></section><section class="panel"><h2>Mediciones de la fuente seleccionada</h2><div class="table-scroll"><table><thead><tr><th>Día / turno</th><th>Fuente y folio</th><th>Estado</th><th>Revisión</th></tr></thead><tbody>${model.state.pilotSamples.filter(s=>s.source===metricSource).map(s=>`<tr><td>${h(s.day)}<small>${shiftLabels[s.shift]}</small></td><td>${h(s.sourceRef)}</td><td>${s.voided?'Anulada':s.validated?'Validada':'Pendiente'}</td><td>${!s.voided&&!s.validated&&has('sample_review')?button('Revisar medición','sample_review',s.id):h(s.reviewedBy||'Pendiente')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function projectView(){
  return heading('Evaluación del Caso 2','Datos del caso y supuestos propuestos. No son resultados medidos del prototipo.')+`<section class="panel"><h2>Alternativas del anexo original</h2><div class="table-scroll"><table><thead><tr><th>Opción</th><th>Inversión</th><th>Soporte anual</th><th>Año 1</th><th>Semanas</th><th>Detención</th><th>Riesgo integración</th></tr></thead><tbody>${[['A · IoT',15800000,2400000,18200000,12,4,65],['B · Visión artificial',21500000,3100000,24600000,11,3,54],['C · QR y trazabilidad',13200000,1800000,15000000,9,2,72]].map(r=>`<tr><td>${r[0]}</td><td>${money(r[1])}</td><td>${money(r[2])}</td><td>${money(r[3])}</td><td>${r[4]}</td><td>${r[5]} días</td><td>${r[6]} / 100</td></tr>`).join('')}</tbody></table></div><p class="muted">Mayor índice implica mayor riesgo. Fuente: Anexos_Caso_2_AustralPack.xlsx, Alternativas_Caso2 y Diccionario.</p></section><section class="panel"><h2>Escenarios propuestos para C</h2><div class="table-scroll"><table><thead><tr><th>Escenario</th><th>Captura de efecto estimado</th><th>Ciclo</th><th>Scrap</th><th>OTIF</th><th>Disponibilidad</th></tr></thead><tbody><tr><td>Base sin inversión</td><td>0 %</td><td>10,5 h</td><td>7,6 %</td><td>89 %</td><td>80 %</td></tr><tr><td>Conservador</td><td>50 %</td><td>10,1 h</td><td>7,45 %</td><td>91,5 %</td><td>81 %</td></tr><tr><td>Adopción parcial</td><td>25 %</td><td>10,3 h</td><td>7,525 %</td><td>90,25 %</td><td>80,5 %</td></tr></tbody></table></div><p>Los factores 50 % y 25 % son supuestos de sensibilidad del equipo, no probabilidades. Fórmula: situación actual + factor × efecto preliminar del anexo. C no tiene una reducción de reclamos cuantificada en las fuentes.</p></section><section class="panel"><h2>Presupuesto de planificación</h2><p>Proveedor año 1: ${money(15000000)}. Recursos internos estimados: ${money(2880000)}. Contingencia propuesta del 15 %: ${money(2682000)}. Total de planificación: <strong>${money(20562000)}</strong>.</p><p class="muted">Los recursos internos y la contingencia son supuestos sin cotización. El costo económico de la detención está pendiente; debe agregarse antes de autorizar una inversión real. El presupuesto máximo del caso es ${money(48000000)}.</p></section><section class="panel"><h2>Plan de doce semanas</h2><ol class="plan-list"><li><b>Semanas 1 y 2</b> · Línea base, participación de ambos turnos, catálogo y diccionario. Responsables: Operaciones y Calidad.</li><li><b>Semanas 3 y 4</b> · Configuración, limpieza y pruebas fuera de línea. Responsable: Transformación digital.</li><li><b>Semanas 5 y 6</b> · Integración y ensayo de contingencia. Responsables: Calidad y Mantenimiento.</li><li><b>Semanas 7 y 8</b> · Capacitación y operación paralela en ambos turnos. Responsables: Producción y representante de trabajadores.</li><li><b>Semana 9</b> · Instalación y aceptación técnica; ventana máxima propuesta de dos días consecutivos.</li><li><b>Semanas 10 y 11</b> · Medición validada, revisión de alertas y recuperación. Responsables: Calidad y Operaciones.</li><li><b>Semana 12</b> · Auditoría del expediente y decisión de continuar, corregir o detener. Responsable: Gerencia.</li></ol><div class="actions"><a href="/api/manual" target="_blank" rel="noopener">Formulario de contingencia</a>${me.role==='admin'?'<a href="/api/backup">Descargar respaldo de datos JSON</a>':''}</div></section>`;
}
function render(){
  if(simulationActive){renderSimulation();return;}
  $('#portal .nav-label').textContent='OPERACIONES';$('#portal .banner').hidden=false;$('#simulation-banner').hidden=true;
  renderBase();
  const content=$('#content');
  if(view==='simulaciones')content.innerHTML=simulationHome(simulationRun);
  if(view==='detalle'&&orderById(selectedId)) {
    const order=orderById(selectedId),lead=content.querySelector('.detail-grid');
    if(lead)lead.insertAdjacentHTML('afterend',tracePanel(order));
    else content.insertAdjacentHTML('beforeend',tracePanel(order));
    const incidents=model.state.incidents.filter(i=>i.orderId===order.id&&i.status!=='closed');
    if(incidents.length&&lead)lead.insertAdjacentHTML('beforebegin',`<p class="warning">Este pedido tiene ${n(incidents.length)} incidencia(s) abierta(s). Su estado histórico de entrega se conserva; revisa la respuesta de Calidad en el expediente.</p>`);
    const pallets=content.querySelector('.pallets');
    if(pallets&&order.pallets.length>12){
      const disclosure=document.createElement('details'),summary=document.createElement('summary');
      summary.textContent=`Mostrar ${order.pallets.length} pallets y sus etiquetas QR`;
      pallets.before(disclosure);disclosure.append(summary,pallets);
    }
  }
  if(view==='calidad') content.insertAdjacentHTML('beforeend',`<section class="panel"><h2>Ensayos registrados</h2>${inspectionsTable(model.state.inspections)}</section>`);
  if(view==='incidentes') content.innerHTML=heading('Incidencias y reclamos','Conserva el estado del despacho y documenta la respuesta al cliente.',(has('incident')?button('+ Registrar incidencia','incident','',true):'')+(has('demo')&&!model.state.orders.some(o=>o.scenario==='case2')?button('Cargar ejemplo Caso 2','demo') : ''))+`<section class="panel">${toolbar(false)}${incidentsTable(model.state.incidents)}</section>`;
  if(view==='mantenimiento') content.innerHTML=maintenanceView();
  if(view==='piloto') content.innerHTML=pilotView();
  if(view==='proyecto') content.innerHTML=projectView();
  if(view==='resumen') content.insertAdjacentHTML('beforeend',`<section class="panel"><div class="panel-heading"><h2>Demostrador del Caso 2</h2>${has('demo')&&!model.state.orders.some(o=>o.scenario==='case2')?button('Cargar ejemplo de 48.000 cajas','demo','',true):''}</div><p>${n(model.state.incidents.filter(i=>i.status!=='closed').length)} incidencias abiertas. Los registros anteriores sin equipo o fecha se mantienen pendientes de revisión.</p><div class="actions"><button data-view="incidentes">Ver incidencias</button><button data-view="piloto">Revisar indicadores</button><a href="/api/manual" target="_blank" rel="noopener">Contingencia manual</a></div></section>`);
  document.querySelectorAll('.pallet img').forEach(img=>img.loading='lazy');
}
function openModal(kind,id=''){
  const extended=['inspection','trace_review','incident','incident_update','maintenance','sample','sample_review','pilot_config'];
  if(!extended.includes(kind)){
    openModalBase(kind,id);
    const footer=$('#operation-form .form-footer');
    if(kind==='production') footer.insertAdjacentHTML('beforebegin',`<div class="form-grid">${equipmentInput()}${shiftInput()}</div>${field('Modo de captura',selects('captureMode',[['online','Registro directo'],['manual','Desde formulario de contingencia']],'online'))}<div id="manual-fields" hidden>${field('Fecha y hora real del formulario',input('occurredAt','datetime-local'))}${field('Folio de contingencia',input('sourceRef','text','','maxlength="160"'))}<p class="form-note">El registro manual requiere revisión posterior de Calidad y respaldo del folio.</p></div>`);
    if(kind==='quality'&&orderById(id)?.hold) footer.insertAdjacentHTML('beforebegin',field('Acción correctiva',textarea('corrective',true,'',180))+field('Evidencia de verificación',textarea('verification',true,'',180))+'<p class="form-note">Antes de resolver, registra un nuevo ensayo conforme desde el expediente del pedido.</p>');
    if(kind==='quality'&&!orderById(id)?.hold) footer.insertAdjacentHTML('beforebegin','<p class="form-note">La liberación exige un ensayo conforme, trazabilidad completa e incidencias resueltas.</p>');
    return;
  }
  const form=$('#operation-form');form.dataset.kind=kind;form.dataset.orderId='';
  let fields='',title='';
  const order=orderById(id);
  if(order) form.dataset.orderId=order.id;
  if(kind==='inspection'){
    title='Registrar ensayo y criterio';
    fields=(order?'':orderInput())+`<div class="form-grid">${equipmentInput()}${shiftInput()}</div>`+field('Ensayo o parámetro',input('parameter','text','','required maxlength="120"'))+field('Especificación o criterio aprobado',input('criterionRef','text','','required maxlength="180"'))+`<div class="form-grid">${field('Resultado medido',input('value','number','','required step="any"'))}${field('Unidad',input('unit','text','','required maxlength="30"'))}${field('Límite inferior',input('lower','number','','step="any"'))}${field('Límite superior',input('upper','number','','step="any"'))}${field('Tamaño de muestra',input('sampleSize','number',1,'required min="1" max="50000"'))}</div>`+field('Observación',textarea('note',false,'',500))+'<p class="form-note">El resultado se compara con los límites. Un valor fuera de rango retiene el lote en planta; después del despacho abre una incidencia. Los límites del ejemplo académico no reemplazan una especificación aprobada.</p>';
  }
  if(kind==='trace_review'){
    const r=model.state.productionRecords.find(v=>v.id===id);form.dataset.orderId=r.orderId;title='Revisar trazabilidad pendiente';
    fields=input('recordId','hidden',id)+`<p>${h(r.palletId)} · ${r.captureMode==='legacy'?'Registro previo sin detalle':'Captura manual con folio '+h(r.sourceRef)}</p>`;
    if(r.captureMode==='legacy') fields+=`<div class="form-grid">${equipmentInput()}${shiftInput()}</div>`+field('Fecha y hora real según respaldo',input('occurredAt','datetime-local','','required'))+field('Responsable del registro original',input('originalActor','text','','required maxlength="100"'));
    fields+=field('Documento y evidencia de revisión',textarea('evidence',true,'',500))+'<p class="form-note">Completa datos solo con evidencia. Si no existe, conserva el pendiente. La revisión no borra el registro original.</p>';
  }
  if(kind==='incident'){
    title='Registrar incidencia o reclamo';fields=(order?'':orderInput())+field('Origen',selects('source',[['client','Cliente'],['quality','Calidad'],['dispatch','Despacho']],'client'))+field('Cajas potencialmente afectadas',input('affected','number',order?.quantity||'','required min="1" max="50000"'))+field('Descripción del problema',textarea('description'))+field('Persona responsable de responder',input('assignedTo','text','','required maxlength="100"'))+'<p class="form-note">Un reclamo posterior al despacho conserva el historial de salida y entrega del pedido.</p>';
  }
  if(kind==='incident_update'){
    const i=model.state.incidents.find(v=>v.id===id);form.dataset.orderId=i.orderId;title='Registrar respuesta a incidencia';
    fields=input('incidentId','hidden',id)+`<p>${h(i.description)}</p>`+field('Estado de la respuesta',selects('status',[['contained','Contenida'],['investigation','En investigación'],['closed','Cerrada']],i.status==='open'?'contained':i.status))+field('Contención y comunicación',textarea('containment',true,i.containment))+field('Análisis de causa',textarea('analysis',false,i.analysis))+field('Acción correctiva',textarea('corrective',false,i.corrective))+field('Evidencia de verificación del cierre',textarea('verification',false,i.verification))+'<p class="form-note">Para investigar se exige causa y acción; para cerrar también se exige verificación. Cerrar una incidencia no libera automáticamente el lote.</p>';
  }
  if(kind==='maintenance'){
    title='Registrar detención';fields=field('Pedido asociado · Opcional',selects('orderId',[['','Sin pedido específico'],...model.state.orders.map(o=>[o.id,o.id+' · '+o.lot])],'',false))+`<div class="form-grid">${equipmentInput()}${shiftInput()}${field('Inicio real',input('start','datetime-local','','required'))}${field('Fin real',input('end','datetime-local','','required'))}</div>`+field('Motivo de detención',textarea('reason',true,'',500))+field('Intervención o respuesta',textarea('intervention',true,'',500));
  }
  if(kind==='sample'){
    title='Registrar medición del turno';fields=field('Día de medición',input('day','date','','required'))+shiftInput()+field('Tipo de evidencia',selects('source',[['pilot','Piloto observado'],['simulation','Ejemplo simulado']],'pilot'))+field('Folio de hoja y cohorte de pedidos',input('sourceRef','text','','required maxlength="180"'))+'<p class="form-note">Usa una hoja por día y turno para la troqueladora. Excluye solapamientos. OTIF y reclamos deben tener numerador y denominador de la misma cohorte.</p><div class="form-grid">'+Object.entries({plannedMinutes:'Minutos programados troqueladora',downMinutes:'Minutos detenida',good:'Cajas conformes',scrap:'Cajas descartadas',completedLots:'Lotes terminados',cycleHoursTotal:'Suma de ciclos de esos lotes en horas',dueOrders:'Pedidos comprometidos',otifOrders:'Pedidos completos y a tiempo',shippedBoxes:'Cajas embarcadas de la cohorte',claims:'Reclamos de esa cohorte'}).map(([key,label])=>field(label,input(key,'number',0,`required min="0" step="${key==='cycleHoursTotal'?'any':'1'}"`))).join('')+'</div>';
  }
  if(kind==='sample_review'){
    title='Revisar medición';const s=model.state.pilotSamples.find(v=>v.id===id);fields=input('sampleId','hidden',id)+`<p>${h(s.day)} · ${shiftLabels[s.shift]} · ${h(s.sourceRef)}</p><p>${n(s.good)} conformes, ${n(s.scrap)} descartadas, ${s.cycleHoursTotal} h / ${s.completedLots} lotes, ${s.otifOrders} / ${s.dueOrders} pedidos OTIF, ${s.downMinutes} / ${s.plannedMinutes} minutos detenidos, ${s.claims} reclamos / ${s.shippedBoxes} cajas de la cohorte.</p>`+field('Decisión',selects('decision',[['validate','Validar contra la fuente'],['void','Anular y volver a registrar']],'validate'))+field('Evidencia y motivo de revisión',textarea('review',true,'',500));
  }
  if(kind==='pilot_config'){
    title='Documentar condiciones del piloto';const c=model.state.pilotConfig;fields=field('Se mantuvo la inspección',selects('inspectionMaintained',[['unverified','Sin verificar'],['yes','Sí, con evidencia'],['no','No']],c.inspectionMaintained))+field('Sin desvinculaciones por automatización',selects('noLayoffs',[['unverified','Sin verificar'],['yes','Sí, con evidencia'],['no','No']],c.noLayoffs))+field('Costo total comprometido año 1 en CLP',input('costYear1','number',c.costYear1??'','required min="0"'))+field('Máxima detención consecutiva en días',input('stopDays','number',c.stopDays??'','required min="0" step="any"'))+field('Acta o evidencia que respalda las condiciones',textarea('evidence',true,c.evidence));
  }
  $('#modal-title').textContent=title;
  form.innerHTML=fields+'<p id="form-error" class="error" role="alert"></p><div class="form-footer"><button type="submit" class="primary">Guardar</button></div>';
  $('#modal').showModal();
}
document.addEventListener('change',event=>{
  if(event.target.name==='captureMode') $('#manual-fields').hidden=event.target.value!=='manual';
  if(event.target.id==='metric-source'){metricSource=event.target.value;render();}
});