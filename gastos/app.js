'use strict';

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n < 0 ? '−' : '') + '$ ' + Math.abs(Math.round(n)).toLocaleString('es-AR');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ymIdx = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + m - 1; };
const idxYm = i => `${Math.floor(i / 12)}-${pad(i % 12 + 1)}`;
const addYm = (ym, n) => idxYm(ymIdx(ym) + n);
const mesNombre = ym => MESES[ymIdx(ym) % 12];
const mesCorto = ym => mesNombre(ym).slice(0, 3) + ' ' + ym.slice(2, 4);
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const soloNum = s => Number(String(s).replace(/\D/g, '')) || 0;
const miles = n => n ? Number(n).toLocaleString('es-AR') : '';
const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
// Dentro de la app Android, la parte nativa se ve como window.Android; en el navegador no existe.
const NATIVO = window.Android || null;
const VERSION = 18; // subir junto con el nombre del caché en sw.js
const NATIVO_ULTIMA = 2; // última versión publicada de la parte Android (Puente.version)
const APK = 'https://github.com/SantiiBurgos/claude/releases/download/apk/';
const RE_MONTO = /\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?/;

/* ---------- almacenamiento (IndexedDB, queda en el teléfono) ---------- */
const db = {
  _p: null,
  open() {
    return this._p ??= new Promise((ok, err) => {
      const r = indexedDB.open('gastos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => err(r.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((ok, err) => {
      const t = d.transaction('kv', mode);
      const q = fn(t.objectStore('kv'));
      t.oncomplete = () => ok(q.result);
      t.onerror = () => err(t.error);
    });
  },
  get: k => db.tx('readonly', s => s.get(k)),
  set: (k, v) => db.tx('readwrite', s => s.put(v, k)),
  del: k => db.tx('readwrite', s => s.delete(k)),
};

const inicial = () => ({
  v: 1,
  cuentas: [
    { id: 'debito', nombre: 'Débito', tipo: 'contado' },
    { id: 'efectivo', nombre: 'Efectivo', tipo: 'contado' },
    { id: 'credito', nombre: 'Tarjeta de crédito', tipo: 'credito' },
  ],
  categorias: [
    { id: 'comida', nombre: 'Comida', emoji: '🍔' },
    { id: 'super', nombre: 'Súper', emoji: '🛒' },
    { id: 'transporte', nombre: 'Transporte', emoji: '🚌' },
    { id: 'servicios', nombre: 'Servicios', emoji: '💡' },
    { id: 'salidas', nombre: 'Salidas', emoji: '🍻' },
    { id: 'salud', nombre: 'Salud', emoji: '💊' },
    { id: 'otros', nombre: 'Otros', emoji: '📦' },
  ],
  compromisos: [], // cuotas, fijos mensuales y pagos únicos, por tarjeta/cuenta
  gastos: [],      // gastos del día a día pagados al contado
  ingresos: [],
  pagos: {},       // { 'AAAA-MM': { idCompromiso: true } }
  presupuesto: 0,  // tope mensual para gastos del día a día
  meta: null,      // { nombre, total, minimo }
  deudores: [],    // plata que te deben: [{ id, nombre, movs: [{ id, fecha, monto, nota }] }] (monto + te deben más, − te devolvieron)
  ahorros: {},     // { 'AAAA-MM': lo que se guardó de verdad ese mes }
  dolares: {},     // { 'AAAA-MM': cotización } — vale desde ese mes hasta que se cargue otra
});

let S = inicial();
let ym = hoy().slice(0, 7);
let tab = 'inicio';
let deudorSel = null; // persona abierta en "Me deben"
let evoSel = null; // mes elegido en el gráfico de evolución
const guardar = () => db.set('estado', S).catch(() => toast('No se pudo guardar'));

/* ---------- cálculos ---------- */
// Cotización del dólar que rige en un mes: la última cargada hasta ese mes.
function dolarMes(m) {
  const ks = Object.keys(S.dolares || {}).sort();
  if (!ks.length) return 0;
  return S.dolares[ks.filter(k => k <= m).pop() || ks[0]];
}
// Trae el dólar tarjeta (ya incluye impuestos) y lo deja como cotización del mes en curso.
// Solo consulta si hay algo cargado en dólares, y como mucho una vez por día.
async function actualizarDolar(forzar) {
  if (S.dolarAuto === false) return;
  if (!forzar && (S.dolarFecha === hoy() || !S.compromisos.some(c => c.usd))) return;
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/tarjeta', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    const v = Math.round(Number((await r.json()).venta));
    if (!r.ok || !(v > 0)) throw 0;
    (S.dolares ??= {})[hoy().slice(0, 7)] = v; S.dolarFecha = hoy(); S.dolarError = false;
    await guardar();
  } catch { S.dolarError = true; }
  if (!hoja) render();
}
const fmtUsd = n => 'US$ ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
// Devuelve cómo aparece un compromiso en un mes dado, o null si no corresponde.
function enMes(c, m) {
  const d = ymIdx(m) - ymIdx(c.inicio);
  if (d < 0) return null;
  if (c.tipo === 'unico' && d !== 0) return null;
  if (c.tipo === 'cuotas' && d >= c.total) return null;
  if (c.tipo === 'mensual' && c.fin && m > c.fin) return null;
  const monto = c.usd ? Math.round(c.usd * dolarMes(m)) : c.ajuste ? Math.round(c.monto * Math.pow(1 + c.ajuste / 100, ymIdx(m) - ymIdx(c.base || c.inicio))) : c.monto;
  const etiqueta = c.tipo === 'cuotas' ? `${d + 1}/${c.total}` : c.tipo === 'mensual' ? 'Fijo' : '1 pago';
  return { c, monto, etiqueta, ultima: c.tipo === 'cuotas' && d + 1 === c.total };
}
const compsMes = m => S.compromisos.map(c => enMes(c, m)).filter(Boolean);
const ingresosMes = m => S.ingresos.map(i => enMes(i, m)).filter(Boolean);
const gastosMes = m => S.gastos.filter(g => g.fecha.startsWith(m));
const totalComps = m => sum(compsMes(m), x => x.monto);
const totalIngresos = m => sum(ingresosMes(m), x => x.monto);
// Lo pagado con un medio "ajeno" (ej. la tarjeta de comida del trabajo) se anota pero no cuenta como gasto propio.
const propio = g => (S.cuentas.find(c => c.id === g.cuentaId) || {}).tipo !== 'ajeno';
const totalGastos = m => sum(gastosMes(m).filter(propio), g => g.monto);
const cuenta = id => S.cuentas.find(c => c.id === id) || { id, nombre: 'Sin cuenta', tipo: 'contado' };
const categoria = id => S.categorias.find(c => c.id === id) || { id, nombre: 'Otros', emoji: '📦' };
// Lo que falta pagar de todas las cuotas desde el mes m en adelante.
function deudaDesde(m) {
  let t = 0;
  for (const c of S.compromisos) {
    if (c.tipo !== 'cuotas') continue;
    for (let i = Math.max(ymIdx(m), ymIdx(c.inicio)); i < ymIdx(c.inicio) + c.total; i++) t += enMes(c, idxYm(i)).monto;
  }
  return t;
}

/* ---------- vistas ---------- */
function render() {
  const actual = ym === hoy().slice(0, 7);
  $('#mes-label').innerHTML = `${mesNombre(ym)} ${ym.slice(0, 4)}${actual ? '' : '<small>volver a hoy</small>'}`;
  for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.tab === (tab === 'deudor' ? 'plan' : tab));
  $('#view').innerHTML = ({ inicio: vInicio, mensual: vMensual, resumen: vResumen, plan: vPlan, ajustes: vAjustes, buscar: vBuscar, deudor: vDeudor })[tab]();
}

// Gastos que se repiten (mismo detalle, categoría y medio), para cargarlos en un toque.
function frecuentes() {
  const m = new Map();
  for (const g of S.gastos) {
    if (!g.desc) continue;
    const k = [g.desc.toLowerCase(), g.cat, g.cuentaId].join('|'), x = m.get(k) || { n: 0, g };
    x.n++; if (g.fecha >= x.g.fecha) x.g = g;
    m.set(k, x);
  }
  return [...m.values()].filter(x => x.n >= 2).sort((a, b) => b.n - a.n || b.g.fecha.localeCompare(a.g.fecha)).slice(0, 5).map(x => x.g);
}
const diasSinRespaldo = () => S.ultimoRespaldo ? Math.round((Date.parse(hoy()) - Date.parse(S.ultimoRespaldo)) / 864e5) : Infinity;

// Compras hechas con tarjeta: se pagan en Mensual, pero se muestran el día en que se hicieron.
const comprasCredito = () => S.compromisos.filter(c => c.fecha).map(c => ({ id: c.id, fecha: c.fecha, cat: c.cat, desc: c.nombre, cuentaId: c.cuentaId, img: c.img, credito: true, monto: c.monto * (c.tipo === 'cuotas' ? c.total : 1), plan: `${c.tipo === 'cuotas' ? c.total + ' cuotas' : '1 pago'} desde ${mesCorto(c.inicio)}` }));
function filaMov(g, conFecha) {
  const cat = categoria(g.cat);
  return `<button class="row" data-act="${g.credito ? 'editar-comp' : 'editar-gasto'}" data-id="${g.id}">
    <span class="emoji">${esc(cat.emoji)}</span>
    <span class="grow"><div class="t">${esc(g.desc || cat.nombre)}</div><div class="s">${conFecha ? etiquetaDia(g.fecha) + ' · ' : ''}${marca(cuenta(g.cuentaId), 14)}${esc(cuenta(g.cuentaId).nombre)}${g.credito ? ' · ' + g.plan : ''}${propio(g) ? '' : ' · no cuenta'}${g.img ? ' · 📎' : ''}</div></span>
    <span class="amt num" ${g.credito || !propio(g) ? 'style="color:var(--muted)"' : ''}>${fmt(g.monto)}</span></button>`;
}
// Movimientos que la app Android detectó en notificaciones y todavía no confirmaste.
function detectados() {
  if (!NATIVO || !CON_LECTOR) return [];
  try {
    return JSON.parse(NATIVO.pendientes()).map(d => {
      const todo = `${d.titulo} ${d.texto}`, m = todo.match(RE_MONTO), f = new Date(d.hora);
      return { ...d, monto: m ? soloNum(m[1]) : 0, ingreso: /recibiste|te envi|te transfiri|acredit|ingres[oó]|cobraste|te pagaron/i.test(todo),
        desc: todo.replace(RE_MONTO, '').replace(/\s+/g, ' ').trim().slice(0, 60), fecha: `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}` };
    }).filter(d => d.monto).reverse();
  } catch { return []; }
}
// La variante básica de la app Android no trae la lectura de notificaciones.
const CON_LECTOR = !!NATIVO && (NATIVO.tieneLector ? NATIVO.tieneLector() : true);
function vDetectados() {
  if (!CON_LECTOR) return '';
  if (!NATIVO.permiso()) {
    return S.sinLector ? '' : `<div class="card pad aviso"><p><b>Anotá los pagos sin tipear.</b> Si le das permiso, la app lee las notificaciones de pago (Mercado Pago, bancos) y te las deja listas para confirmar. Solo guarda las que tienen un importe, y nada sale del teléfono.</p>
      <p class="s">Si Android no te deja activarlo: Ajustes del teléfono → Aplicaciones → Gastos → ⋮ → Permitir ajustes restringidos.</p>
      <div class="btns"><button class="btn" data-act="det-permiso">Activar lectura de pagos</button><button class="btn ghost" data-act="det-no">Ahora no</button></div></div>`;
  }
  const ds = detectados();
  if (!ds.length) return '';
  return `<h2><span>Detectados en notificaciones</span><span class="num">${ds.length}</span></h2><div class="card">${ds.slice(0, 20).map(d => `<div class="row">
    <button class="grow" data-act="det-usar" data-id="${esc(d.id)}" style="text-align:left"><div class="t" style="white-space:normal">${esc(d.desc || d.app)}</div><div class="s">${esc(d.app)} · ${etiquetaDia(d.fecha)} · ${d.ingreso ? 'ingreso' : 'gasto'}</div></button>
    <span class="amt num">${fmt(d.monto)}</span><button class="x" data-act="det-quitar" data-id="${esc(d.id)}" aria-label="Descartar">✕</button></div>`).join('')}</div>
    <div class="hint">Tocá uno para revisarlo y anotarlo. La ✕ lo descarta.</div>`;
}
// Tarjetas con algo sin pagar que vencen en los próximos 7 días (o ya vencieron).
function vencimientos() {
  const act = hoy().slice(0, 7), dia = Number(hoy().slice(8)), pagos = S.pagos[act] || {};
  return S.cuentas.filter(c => c.vence).map(c => {
    const falta = sum(compsMes(act).filter(x => x.c.cuentaId === c.id && !pagos[x.c.id]), x => x.monto);
    return { c, falta, dias: c.vence - dia };
  }).filter(v => v.falta > 0 && v.dias <= 7).sort((a, b) => a.dias - b.dias);
}

function vInicio() {
  const ing = totalIngresos(ym), comp = totalComps(ym), gas = totalGastos(ym);
  const queda = ing - comp - gas;
  const gs = [...gastosMes(ym), ...comprasCredito().filter(g => g.fecha.startsWith(ym))].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id.localeCompare(a.id));
  let presu = '';
  if (S.presupuesto > 0) {
    const pct = Math.min(100, gas / S.presupuesto * 100), libre = S.presupuesto - gas;
    let porDia = '';
    if (ym === hoy().slice(0, 7) && libre > 0) {
      const d = new Date(), dias = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
      porDia = `<div class="kv"><span>Podés gastar por día</span><span class="num">${fmt(libre / dias)}</span></div>`;
    }
    presu = `<div class="card pad">
      <div class="kv"><span>Gastos del día a día</span><span class="num"><b>${fmt(gas)}</b> de ${fmt(S.presupuesto)}</span></div>
      <div class="bar ${libre < 0 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      <div class="kv"><span>${libre < 0 ? 'Te pasaste por' : 'Te queda del tope'}</span><span class="num">${fmt(Math.abs(libre))}</span></div>
      ${porDia}</div>`;
  }
  let lista = '', dia = '';
  for (const g of gs) {
    if (g.fecha !== dia) {
      dia = g.fecha;
      const tot = sum(gs.filter(x => x.fecha === dia && !x.credito && propio(x)), x => x.monto);
      lista += `${lista ? '</div>' : ''}<h2><span>${etiquetaDia(dia)}</span><span class="num">${fmt(tot)}</span></h2><div class="card">`;
    }
    lista += filaMov(g);
  }
  lista = lista ? lista + '</div>' : `<div class="empty">Todavía no anotaste gastos este mes.<br>Tocá <b>+</b> para cargar el primero.</div>`;
  const dias = diasSinRespaldo(), hayDatos = S.gastos.length + S.compromisos.length + S.ingresos.length > 0;
  const aviso = hayDatos && dias >= 30 ? `<div class="card pad aviso"><p>${dias === Infinity ? 'Todavía no guardaste ningún respaldo.' : `Hace ${dias} días que no guardás un respaldo.`} Tus datos viven solo en este teléfono.</p><button class="btn" data-act="respaldar">Guardar respaldo ahora</button></div>` : '';
  const frec = frecuentes();
  const rep = frec.length ? `<div class="rep">${frec.map(g => `<button data-act="repetir" data-id="${g.id}">${esc(categoria(g.cat).emoji)} ${esc(g.desc)}</button>`).join('')}</div>` : '';
  const venc = ym === hoy().slice(0, 7) ? vencimientos().map(v => `<button class="card pad aviso vto" data-act="ir-mensual"><span>⚠</span><span class="grow"><b>${esc(v.c.nombre)}</b> ${v.dias < 0 ? `venció hace ${-v.dias} ${v.dias === -1 ? 'día' : 'días'}` : v.dias === 0 ? 'vence hoy' : v.dias === 1 ? 'vence mañana' : `vence en ${v.dias} días`}</span><span class="num"><b>${fmt(v.falta)}</b></span></button>`).join('') : '';
  const buscar = S.gastos.length + S.compromisos.length ? `<button class="btn line" data-act="ir-buscar">Buscar en todos los movimientos</button>` : '';
  return `${aviso}${venc}${ym === hoy().slice(0, 7) ? vDetectados() : ''}<section class="hero">
      <div class="lbl">Te queda este mes</div>
      <div class="big num ${queda < 0 ? 'neg' : ''}">${fmt(queda)}</div>
      <div class="sub">Ingresos ${fmt(ing)} · Fijos y cuotas ${fmt(comp)}</div>
    </section>${rep}${presu}${lista}${buscar}`;
}

const filtro = { q: '', cat: '', cta: '' };
function vBuscar() {
  const op = (lista, sel, todos) => `<option value="">${todos}</option>` + lista.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('');
  return `<div class="f"><input type="text" id="q" placeholder="Buscar por detalle…" value="${esc(filtro.q)}" autocomplete="off"></div>
    <div class="filtros"><select id="f-cat" aria-label="Categoría">${op(S.categorias, filtro.cat, 'Todas las categorías')}</select>
    <select id="f-cta" aria-label="Medio de pago">${op(S.cuentas, filtro.cta, 'Todos los medios')}</select></div>
    <div id="res">${resultados()}</div>`;
}
function resultados() {
  const q = filtro.q.trim().toLowerCase();
  const r = [...S.gastos, ...comprasCredito()].filter(g => (!q || (g.desc || categoria(g.cat).nombre).toLowerCase().includes(q)) && (!filtro.cat || g.cat === filtro.cat) && (!filtro.cta || g.cuentaId === filtro.cta))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id.localeCompare(a.id));
  if (!r.length) return `<div class="empty">No hay movimientos que coincidan.</div>`;
  return `<h2><span>${r.length} ${r.length === 1 ? 'movimiento' : 'movimientos'}</span><span class="num">${fmt(sum(r.filter(propio), g => g.monto))}</span></h2>
    <div class="card">${r.slice(0, 200).map(g => filaMov(g, true)).join('')}</div>${r.length > 200 ? '<div class="hint">Se muestran los 200 más recientes: afiná la búsqueda para ver el resto.</div>' : ''}`;
}

function etiquetaDia(f) {
  const d = new Date(f + 'T12:00'), h = hoy();
  if (f === h) return 'Hoy';
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
  if (f === `${ayer.getFullYear()}-${pad(ayer.getMonth() + 1)}-${pad(ayer.getDate())}`) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', ...(f.slice(0, 4) !== h.slice(0, 4) ? { year: '2-digit' } : {}) });
}

function vMensual() {
  const items = compsMes(ym), sig = addYm(ym, 1), pagos = S.pagos[ym] || {};
  const total = sum(items, x => x.monto), pagado = sum(items.filter(x => pagos[x.c.id]), x => x.monto);
  const ing = totalIngresos(ym);
  let html = `<section class="hero">
      <div class="lbl">Total a pagar en ${mesNombre(ym)}</div>
      <div class="big num">${fmt(total)}</div>
      <div class="sub">${ing ? Math.round(total / ing * 100) + '% de tus ingresos · ' : ''}Pagado ${fmt(pagado)} · Falta ${fmt(total - pagado)}</div>
    </section>`;
  for (const cta of S.cuentas) {
    const its = items.filter(x => x.c.cuentaId === cta.id);
    if (!its.length) continue;
    const enSig = sum(compsMes(sig).filter(x => x.c.cuentaId === cta.id), x => x.monto);
    html += `<h2><span class="hm">${marca(cta, 24)}${esc(cta.nombre)}${cta.vence ? ` · vence el ${cta.vence}` : ''}</span><span class="num">${fmt(sum(its, x => x.monto))}</span></h2><div class="card" ${esColor(cta.color) ? `style="box-shadow:inset 4px 0 0 ${cta.color}"` : ''}>`;
    for (const x of its) {
      const ok = !!pagos[x.c.id];
      html += `<div class="row ${ok ? 'done' : ''}">
        <button class="check ${ok ? 'on' : ''}" data-act="pagar" data-id="${x.c.id}" aria-label="Marcar pagado">✓</button>
        <button class="grow" data-act="editar-comp" data-id="${x.c.id}" style="text-align:left"><div class="t" style="white-space:normal">${esc(x.c.nombre)}</div>${x.c.usd ? `<div class="s">${fmtUsd(x.c.usd)} a ${fmt(dolarMes(ym))}</div>` : ''}</button>
        <span class="badge ${x.ultima ? 'last' : ''}">${x.etiqueta}</span>
        <span class="amt num">${fmt(x.monto)}</span></div>`;
    }
    const todo = its.every(x => pagos[x.c.id]);
    if (its.length > 1) html += `<button class="row" data-act="pagar-cuenta" data-id="${cta.id}"><span class="check ${todo ? 'on' : ''}">✓</span><span class="grow s">${todo ? 'Todo pagado' : 'Marcar todo como pagado'}</span></button>`;
    html += `<div class="row"><span class="grow s">Sigue en ${mesNombre(sig)}</span><span class="num s">${fmt(enSig)}</span></div></div>`;
  }
  const huerfanos = items.filter(x => !S.cuentas.some(c => c.id === x.c.cuentaId));
  if (huerfanos.length) {
    html += `<h2><span>Sin cuenta</span></h2><div class="card">` + huerfanos.map(x => `<button class="row" data-act="editar-comp" data-id="${x.c.id}"><span class="grow t">${esc(x.c.nombre)}</span><span class="badge">${x.etiqueta}</span><span class="amt num">${fmt(x.monto)}</span></button>`).join('') + '</div>';
  }
  if (!items.length) html += `<div class="empty">No hay cuotas ni gastos fijos en ${mesNombre(ym)}.</div>`;
  return html + `<button class="btn line" data-act="nuevo-comp">+ Agregar cuota o gasto fijo</button>`;
}

function vResumen() {
  const ings = ingresosMes(ym), ing = sum(ings, x => x.monto), comp = totalComps(ym), gas = totalGastos(ym);
  let html = `<h2><span>Ingresos de ${mesNombre(ym)}</span><span class="num">${fmt(ing)}</span></h2><div class="card">`;
  html += ings.map(x => `<button class="row" data-act="editar-ing" data-id="${x.c.id}"><span class="grow t">${esc(x.c.nombre)}</span><span class="badge">${x.c.tipo === 'mensual' ? 'Fijo' : 'Único'}</span><span class="amt num">${fmt(x.monto)}</span></button>`).join('');
  html += `<button class="row" data-act="nuevo-ing"><span class="grow" style="color:var(--accent);font-weight:600">+ Agregar ingreso</span></button></div>`;

  html += `<h2><span>Balance del mes</span></h2><div class="card">
    <div class="row"><span class="grow">Ingresos</span><span class="amt num">${fmt(ing)}</span></div>
    <div class="row"><span class="grow">Fijos y cuotas</span><span class="amt num">${fmt(-comp)}</span></div>
    <div class="row"><span class="grow">Gastos del día a día</span><span class="amt num">${fmt(-gas)}</span></div>
    <div class="row total"><span class="grow">Te queda</span><span class="amt num" ${ing - comp - gas < 0 ? 'style="color:var(--bad)"' : ''}>${fmt(ing - comp - gas)}</span></div></div>`;

  const porCat = S.categorias.map(c => ({ c, t: sum(gastosMes(ym).filter(g => g.cat === c.id && propio(g)), g => g.monto) })).filter(x => x.t > 0 || x.c.tope > 0).sort((a, b) => b.t - a.t);
  if (porCat.length) {
    const max = Math.max(1, porCat[0].t);
    html += `<h2><span>En qué se fue</span><span class="num">${fmt(gas)}</span></h2><div class="card pad">` + porCat.map(x => `
      <div class="kv"><span style="color:var(--text)">${esc(x.c.emoji)} ${esc(x.c.nombre)}</span><span class="num">${fmt(x.t)}${x.c.tope ? ' de ' + fmt(x.c.tope) + (x.t > x.c.tope ? ' ⚠' : '') : gas ? ' · ' + Math.round(x.t / gas * 100) + '%' : ''}</span></div>
      <div class="bar ${x.c.tope && x.t > x.c.tope ? 'over' : ''}"><div style="width:${Math.min(100, x.t / (x.c.tope || max) * 100)}%"></div></div>`).join('') + '<div class="hint">El tope de cada categoría se pone en Ajustes → Categorías.</div></div>';
  }

  // Evolución: columnas apiladas de los últimos 6 meses (fijos y cuotas + día a día).
  const meses = Array.from({ length: 6 }, (_, i) => addYm(ym, i - 5)).map(m => ({ m, f: totalComps(m), d: totalGastos(m) }));
  const tope = Math.max(...meses.map(x => x.f + x.d));
  if (tope > 0) {
    const sel = meses.find(x => x.m === evoSel) || meses[5];
    html += `<h2><span>Últimos 6 meses</span></h2><div class="card pad">
      <div class="leyenda"><span><i class="s1"></i>Fijos y cuotas</span><span><i class="s2"></i>Día a día</span></div>
      <div class="evo" role="img" aria-label="Gasto total por mes, últimos 6 meses">${meses.map(x => `<button data-act="evo" data-id="${x.m}" class="${x.m === sel.m ? 'on' : ''}" aria-label="${mesNombre(x.m)}: ${fmt(x.f + x.d)}">
        <span class="col">${x.d ? `<i class="s2" style="height:${x.d / tope * 100}%"></i>` : ''}${x.f ? `<i class="s1" style="height:${x.f / tope * 100}%"></i>` : ''}</span><span class="ml">${mesNombre(x.m).slice(0, 3)}</span></button>`).join('')}</div>
      <div class="kv"><span style="text-transform:capitalize">${mesNombre(sel.m)} ${sel.m.slice(0, 4)}</span><span class="num"><b>${fmt(sel.f + sel.d)}</b></span></div>
      <div class="kv"><span>Fijos y cuotas</span><span class="num">${fmt(sel.f)}</span></div>
      <div class="kv"><span>Día a día</span><span class="num">${fmt(sel.d)}</span></div>
      <div class="hint">Tocá una columna para ver ese mes.</div></div>`;
  }

  return html;
}

/* ---------- plan: meta de ahorro, próximos meses y deudas ---------- */
// Lo que se proyecta ahorrar en un mes: ingresos menos compromisos y gastos del día a día.
function ahorroEstimado(m) {
  const variables = m === hoy().slice(0, 7) ? Math.max(S.presupuesto, totalGastos(m)) : S.presupuesto;
  return totalIngresos(m) - totalComps(m) - variables;
}
const ahorroReal = m => (S.ahorros || {})[m];
// Ahorrado de verdad hasta el mes m inclusive.
const ahorradoHasta = m => sum(Object.keys(S.ahorros || {}).filter(k => k <= m), k => S.ahorros[k]);
// Primer mes en que el acumulado (real + estimado a futuro) alcanza un objetivo.
function mesQueLlega(objetivo) {
  const act = hoy().slice(0, 7);
  let acum = ahorradoHasta(addYm(act, -1));
  for (let i = 0; i < 60; i++) {
    const m = addYm(act, i);
    acum += ahorroReal(m) ?? ahorroEstimado(m);
    if (acum >= objetivo) return m;
  }
  return null;
}
function deudas(m) {
  return S.compromisos.filter(c => c.tipo === 'cuotas' && ymIdx(c.inicio) + c.total > ymIdx(m)).map(c => {
    const desde = Math.max(ymIdx(m), ymIdx(c.inicio)), fin = ymIdx(c.inicio) + c.total - 1;
    let saldo = 0;
    for (let i = desde; i <= fin; i++) saldo += enMes(c, idxYm(i)).monto;
    return { c, restantes: fin - desde + 1, saldo, cuota: enMes(c, idxYm(desde)).monto, termina: idxYm(fin) };
  }).sort((a, b) => b.saldo - a.saldo);
}

function vPlan() {
  const act = hoy().slice(0, 7), M = S.meta;
  let html = '';
  if (!M) {
    html += `<div class="empty">Definí una meta de ahorro (por ejemplo, la mudanza) y la app te muestra cuánto llevás y cuándo llegás.</div>
      <button class="btn line" data-act="editar-meta">+ Crear meta de ahorro</button>`;
  } else {
    const llevo = ahorradoHasta('9999-12'), pct = Math.min(100, llevo / M.total * 100);
    const mMin = M.minimo ? mesQueLlega(M.minimo) : null, mTot = mesQueLlega(M.total);
    const estado = llevo >= M.total ? 'Meta completa' : M.minimo && llevo >= M.minimo ? 'Ya llegaste al mínimo' : 'Ahorrando';
    const cuando = m => m ? mesCorto(m) : 'más de 5 años';
    html += `<section class="hero">
        <div class="lbl">${esc(M.nombre)} · ${estado}</div>
        <div class="big num">${fmt(llevo)}</div>
        <div class="sub">de ${fmt(M.total)} · ${Math.round(llevo / M.total * 100)}%</div>
      </section>
      <div class="card pad">
        <div class="bar meta"><div style="width:${pct}%"></div>${M.minimo && M.minimo < M.total ? `<i style="left:${M.minimo / M.total * 100}%"></i>` : ''}</div>
        ${M.minimo ? `<div class="kv"><span>Mínimo de ${fmt(M.minimo)}</span><span class="num">${llevo >= M.minimo ? 'alcanzado' : 'llegás en ' + cuando(mMin)}</span></div>` : ''}
        <div class="kv"><span>Meta total</span><span class="num">${llevo >= M.total ? 'alcanzada' : 'llegás en ' + cuando(mTot)}</span></div>
        <div class="hint">La fecha sale de lo que ya guardaste más lo que se estima que te queda cada mes.</div>
        <button class="btn ghost" data-act="editar-meta">Editar meta</button>
      </div>
      <h2><span>Ahorro mes a mes</span></h2><div class="card pad"><table><tr><th>Mes</th><th>Estimado</th><th>Guardado</th><th>Acumulado</th></tr>`;
    let acum = ahorradoHasta(addYm(ym, -1));
    for (let i = 0; i < 6; i++) {
      const m = addYm(ym, i), est = ahorroEstimado(m), real = ahorroReal(m), futuro = m >= act;
      acum += real ?? (futuro ? est : 0);
      html += `<tr><td>${mesCorto(m)}</td><td class="num ${est < 0 ? 'neg' : ''}">${fmt(est)}</td>
        <td class="num"><button class="celda" data-act="editar-ahorro" data-id="${m}">${real == null ? 'Anotar' : fmt(real)}</button></td>
        <td class="num ${real == null && futuro ? 'est' : ''}"><b>${fmt(acum)}</b></td></tr>`;
    }
    html += `</table><div class="hint">Tocá "Guardado" para anotar lo que apartaste de verdad ese mes. El acumulado en gris usa el estimado.</div></div>`;
  }

  html += `<h2><span>Próximos meses</span></h2><div class="card pad"><table><tr><th>Mes</th><th>Ingresos</th><th>A pagar</th><th>Queda</th></tr>`;
  for (let i = 0; i < 6; i++) {
    const m = addYm(ym, i), a = totalIngresos(m), b = totalComps(m), q = a - b - S.presupuesto;
    html += `<tr><td>${mesCorto(m)}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(b)}</td><td class="num ${q < 0 ? 'neg' : ''}"><b>${fmt(q)}</b></td></tr>`;
  }
  html += `</table><div class="hint">"Queda" descuenta también el tope de gastos del día a día${S.presupuesto ? ` (${fmt(S.presupuesto)})` : ''}.</div></div>`;


  const dd = S.deudores || [];
  html += `<h2><span>Me deben</span><span class="num">${fmt(sum(dd, saldoDeudor))}</span></h2><div class="card">
    ${dd.map(p => `<button class="row" data-act="ver-deudor" data-id="${p.id}"><span class="grow"><div class="t">${esc(p.nombre)}</div><div class="s">${p.movs.length} ${p.movs.length === 1 ? 'movimiento' : 'movimientos'}</div></span><span class="amt num">${saldoDeudor(p) === 0 ? 'Saldado' : fmt(saldoDeudor(p))}</span></button>`).join('')}
    <button class="row" data-act="nuevo-deudor"><span class="grow" style="color:var(--accent);font-weight:600">+ Agregar persona</span></button></div>
    <div class="hint">Para préstamos y pagos que hacés por otros. Es una cuenta aparte: no cambia tus gastos ni lo que te queda del mes.</div>`;

  const ds = deudas(ym);
  html += `<h2><span>Deudas en cuotas</span><span class="num">${fmt(sum(ds, d => d.saldo))}</span></h2>`;
  if (ds.length) {
    html += `<div class="card">` + ds.map(d => `<button class="row" data-act="editar-comp" data-id="${d.c.id}">
      <span class="grow"><div class="t">${esc(d.c.nombre)}</div><div class="s" style="white-space:normal">${d.restantes === 1 ? 'Última cuota' : d.restantes + ' cuotas de ' + fmt(d.cuota)} · termina ${mesCorto(d.termina)} · ${esc(cuenta(d.c.cuentaId).nombre)}</div></span>
      <span class="amt num">${fmt(d.saldo)}</span></button>`).join('') + `</div>
      <div class="hint">Saldo que falta pagar contando desde ${mesNombre(ym)}. Dentro de un mes va a ser ${fmt(sum(deudas(addYm(ym, 1)), d => d.saldo))}.</div>`;
  } else html += `<div class="empty">No tenés cuotas pendientes.</div>`;
  return html;
}

const saldoDeudor = p => sum(p.movs, m => m.monto);
function vDeudor() {
  const p = (S.deudores || []).find(x => x.id === deudorSel);
  if (!p) { tab = 'plan'; return vPlan(); }
  const saldo = saldoDeudor(p), movs = [...p.movs].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id.localeCompare(a.id));
  const debe = sum(p.movs.filter(m => m.monto > 0), m => m.monto), dio = -sum(p.movs.filter(m => m.monto < 0), m => m.monto);
  return `<button class="btn ghost" data-act="ir-plan" style="margin-bottom:6px">‹ Volver a Plan</button>
    <section class="hero">
      <div class="lbl">${esc(p.nombre)} ${saldo < 0 ? 'te dio de más' : 'te debe'}</div>
      <div class="big num">${fmt(Math.abs(saldo))}</div>
      <div class="sub">Le prestaste o pagaste ${fmt(debe)} · Te devolvió ${fmt(dio)}</div>
    </section>
    <div class="btns" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
      <button class="btn ghost" data-act="mov-deudor" data-id="1">+ Me debe más</button>
      <button class="btn" data-act="mov-deudor" data-id="-1">+ Me devolvió</button>
    </div>
    ${movs.length ? `<div class="card">${movs.map(m => `<button class="row" data-act="editar-mov-deudor" data-id="${m.id}">
      <span class="grow"><div class="t">${esc(m.nota || (m.monto > 0 ? 'Le presté / pagué por él' : 'Me devolvió'))}</div><div class="s">${etiquetaDia(m.fecha)}</div></span>
      <span class="amt num" ${m.monto < 0 ? 'style="color:var(--accent)"' : ''}>${m.monto < 0 ? '−' : '+'} ${fmt(Math.abs(m.monto))}</span></button>`).join('')}</div>` : '<div class="empty">Todavía no hay movimientos.</div>'}
    <button class="btn line" data-act="editar-deudor">Cambiar nombre o eliminar</button>`;
}
function formDeudor(p) {
  abrir({
    title: p ? 'Editar persona' : 'Quién te debe',
    fields: [{ name: 'nombre', type: 'text', label: 'Nombre', value: p?.nombre, placeholder: 'Ej: papás' }],
    onSave: v => {
      if (!v.nombre) return 'Ponele un nombre';
      if (p) p.nombre = v.nombre;
      else { const n = { id: uid(), nombre: v.nombre, movs: [] }; (S.deudores ??= []).push(n); deudorSel = n.id; tab = 'deudor'; }
    },
    deleteLabel: 'Eliminar persona y sus movimientos',
    onDelete: p ? () => { S.deudores = S.deudores.filter(x => x.id !== p.id); tab = 'plan'; } : null,
  });
}
function formMovDeudor(m, signo) {
  const p = S.deudores.find(x => x.id === deudorSel);
  abrir({
    title: m ? 'Editar movimiento' : (signo > 0 ? 'Me debe más' : 'Me devolvió'),
    fields: [
      { name: 'monto', type: 'money', value: m ? Math.abs(m.monto) : 0 },
      { name: 'tipo', type: 'chips', value: m ? (m.monto > 0 ? '1' : '-1') : String(signo), options: [{ v: '1', l: 'Le presté o pagué por él' }, { v: '-1', l: 'Me devolvió' }] },
      { name: 'nota', type: 'text', label: 'Detalle (opcional)', value: m?.nota, placeholder: 'Ej: préstamo, cuota Visa…' },
      { name: 'fecha', type: 'date', label: 'Fecha', value: m?.fecha || hoy() },
    ],
    onSave: v => {
      if (!v.monto) return 'Poné un monto';
      const n = { id: m?.id || uid(), fecha: v.fecha || hoy(), monto: v.monto * Number(v.tipo), nota: v.nota };
      if (m) p.movs[p.movs.findIndex(x => x.id === m.id)] = n; else p.movs.push(n);
    },
    onDelete: m ? () => { p.movs = p.movs.filter(x => x.id !== m.id); } : null,
  });
}
function formMeta() {
  const M = S.meta;
  abrir({
    title: M ? 'Editar meta' : 'Nueva meta de ahorro',
    fields: [
      { name: 'total', type: 'money', value: M?.total, label: 'Meta total' },
      { name: 'nombre', type: 'text', label: 'Para qué es', value: M?.nombre, placeholder: 'Ej: mudanza' },
      { name: 'minimo', type: 'pesos', label: 'Mínimo para arrancar (opcional)', value: M?.minimo || 0, placeholder: 'Ej: 2.675.000' },
    ],
    onSave: v => {
      if (!v.total) return 'Poné el monto de la meta';
      S.meta = { nombre: v.nombre || 'Meta de ahorro', total: v.total, minimo: Math.min(Math.round(v.minimo) || 0, v.total) };
    },
    deleteLabel: 'Eliminar meta',
    onDelete: M ? () => { S.meta = null; } : null,
  });
}
function formAhorro(m) {
  const tiene = ahorroReal(m) != null;
  abrir({
    title: `Guardado en ${mesNombre(m)}`,
    fields: [{ name: 'monto', type: 'money', value: ahorroReal(m) || 0 }],
    onSave: v => { (S.ahorros ??= {})[m] = v.monto; },
    deleteLabel: 'Quitar lo anotado',
    onDelete: tiene ? () => { delete S.ahorros[m]; } : null,
  });
}

function vAjustes() {
  return `<h2><span>Tope mensual del día a día</span></h2>
    <div class="card"><button class="row" data-act="editar-presu"><span class="grow">Tope</span><span class="amt num">${S.presupuesto ? fmt(S.presupuesto) : 'Sin tope'}</span></button></div>
    <h2><span>Dólar de referencia</span></h2>
    <div class="card"><button class="row" data-act="editar-dolar"><span class="grow">Valor en ${mesNombre(ym)}</span><span class="amt num">${dolarMes(ym) ? fmt(dolarMes(ym)) : 'Sin cargar'}</span></button></div>
    <div class="hint">Se usa para pasar a pesos lo que cargues en dólares (suscripciones). ${S.dolarAuto === false ? 'Lo cargás vos a mano.' : `Se actualiza solo con el dólar tarjeta, que ya incluye impuestos. ${S.dolarError ? '<b>No se pudo actualizar la última vez</b>; se usa el último valor guardado.' : S.dolarFecha ? `Última actualización: ${new Date(S.dolarFecha + 'T12:00').toLocaleDateString('es-AR')}.` : 'Se consulta cuando cargues algo en dólares.'}`}</div>
    <h2><span>Tarjetas y medios de pago</span></h2><div class="card">
    ${S.cuentas.map(c => `<button class="row" data-act="editar-cuenta" data-id="${c.id}">${marca(c, 28)}<span class="grow t">${esc(c.nombre)}</span><span class="badge">${c.tipo === 'credito' ? (c.cierre ? `Cierra el ${c.cierre}` : 'Crédito') : c.tipo === 'ajeno' ? 'No cuenta' : 'Contado'}</span></button>`).join('')}
    <button class="row" data-act="nueva-cuenta"><span class="grow" style="color:var(--accent);font-weight:600">+ Agregar</span></button></div>
    <div class="hint">Lo que cargues con un medio de <b>crédito</b> va a la pestaña Mensual. Si le ponés el día de cierre a la tarjeta, la app calcula sola en qué mes entra cada compra. Lo de un medio que <b>paga otro</b> (la tarjeta de comida del trabajo) queda anotado pero no suma a tus gastos. Lo de <b>contado</b> cuenta como gasto del día.</div>
    <h2><span>Categorías</span></h2><div class="card">
    ${S.categorias.map(c => `<button class="row" data-act="editar-cat" data-id="${c.id}"><span class="emoji">${esc(c.emoji)}</span><span class="grow t">${esc(c.nombre)}</span></button>`).join('')}
    <button class="row" data-act="nueva-cat"><span class="grow" style="color:var(--accent);font-weight:600">+ Agregar</span></button></div>
    ${CON_LECTOR ? `<h2><span>Lectura de pagos</span></h2><div class="card"><button class="row" data-act="det-permiso"><span class="grow">Leer notificaciones de pago</span><span class="badge">${NATIVO.permiso() ? 'Activada' : 'Desactivada'}</span></button></div><div class="hint">Se cambia desde los Ajustes del teléfono; tocá para abrirlos.</div>` : ''}
    <h2><span>Tus datos</span></h2>
    <div class="hint">Todo queda guardado solo en este teléfono. Último respaldo: <b>${S.ultimoRespaldo ? new Date(S.ultimoRespaldo + 'T12:00').toLocaleDateString('es-AR') : 'nunca'}</b>. El respaldo no incluye las fotos de los comprobantes.</div>
    <div class="btns">
      <button class="btn" data-act="respaldar">Guardar respaldo (Drive, WhatsApp, mail…)</button>
      <button class="btn ghost" data-act="exportar">Descargar respaldo al teléfono</button>
      <label class="btn ghost">Cargar respaldo<input type="file" id="importar" ${NATIVO ? '' : 'accept="application/json,text/plain,.json,.txt"'} hidden></label>
      <button class="btn ghost" data-act="csv">Exportar gastos a planilla (CSV)</button>
      <button class="btn danger" data-act="borrar-todo">Borrar todo</button>
    </div>
    <h2><span>Versión</span></h2>
    <div class="hint">Estás en la versión <b>${VERSION}</b>${NATIVO ? ` · app Android ${NATIVO.version()}` : ''}. La app se actualiza sola al abrirla; con este botón lo forzás. No toca tus datos.</div>
    <div class="btns">
      <button class="btn ghost" data-act="actualizar">Buscar actualización</button>
      ${NATIVO ? `<a class="btn ghost" href="${APK}${CON_LECTOR ? 'gastos-con-lector.apk' : 'gastos.apk'}">Descargar la app Android más reciente${NATIVO.version() < NATIVO_ULTIMA ? ' (hay una nueva)' : ''}</a>` : ''}
    </div>
    ${NATIVO ? '<div class="hint">La app Android casi nunca hace falta reinstalarla: lo que cambia seguido es lo de arriba. Si la bajás, se instala encima de la actual sin borrar datos.</div>' : ''}`;
}

/* ---------- formularios (hoja inferior) ---------- */
let hoja = null;
function abrir(cfg) {
  hoja = cfg;
  const campo = f => {
    if (f.type === 'nota') return `<div class="f hint" data-f="${f.name}"></div>`;
    const lab = f.label ? `<span class="lab">${esc(f.label)}</span>` : '';
    if (f.type === 'money') return `<div class="f money" data-f="${f.name}"><span>$</span><input name="${f.name}" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="${miles(f.value)}" aria-label="${esc(f.label || 'Monto')}"></div>`;
    if (f.type === 'pesos') return `<div class="f" data-f="${f.name}">${lab}<input name="${f.name}" type="text" inputmode="numeric" data-miles autocomplete="off" placeholder="${esc(f.placeholder || '')}" value="${miles(f.value)}"></div>`;
    if (f.type === 'chips') return `<div class="f" data-f="${f.name}">${lab}<div class="chips">${f.options.map(o => `<label class="chip"><input type="radio" name="${f.name}" value="${esc(o.v)}" ${String(o.v) === String(f.value) ? 'checked' : ''}><span>${o.h || ''}${esc(o.l)}</span></label>`).join('')}</div></div>`;
    if (f.type === 'color') {
      const v = esColor(f.value) ? f.value.toLowerCase() : '', otro = v && !COLORES.includes(v);
      return `<div class="f" data-f="${f.name}">${lab}<div class="chips colores">
        <label class="chip"><input type="radio" name="${f.name}" value="" ${v ? '' : 'checked'}><span>Sin color</span></label>
        ${COLORES.map(c => `<label class="chip sw"><input type="radio" name="${f.name}" value="${c}" ${c === v ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}
        <label class="chip sw"><input type="radio" name="${f.name}" value="otro" ${otro ? 'checked' : ''}><span class="otro" ${otro ? `style="background:${v}"` : ''}><input type="color" id="color-otro" value="${otro ? v : '#1e63d6'}" aria-label="Otro color"></span></label></div></div>`;
    }
    if (f.type === 'logo') return `<div class="f" data-f="${f.name}">${lab}<div class="logo-f"><img id="logo-prev" class="logo" alt="Logo" hidden>
      <label class="attach">Elegir imagen<input type="file" id="logo-in" accept="image/*"></label><button type="button" class="attach" id="logo-quitar" data-act="logo-quitar" hidden>Quitar</button></div></div>`;
    return `<div class="f" data-f="${f.name}">${lab}<input name="${f.name}" type="${f.type === 'number' ? 'text' : f.type}" value="${esc(String(f.value ?? '').replace('.', f.type === 'number' ? ',' : '.'))}" ${f.type === 'number' ? 'inputmode="decimal"' : ''} placeholder="${esc(f.placeholder || '')}" autocomplete="off"></div>`;
  };
  $('#sheet').innerHTML = `<form id="form" novalidate>
    <div class="sheet-head"><h3>${esc(cfg.title)}</h3><button type="button" data-act="cerrar" aria-label="Cerrar">✕</button></div>
    ${cfg.fields.map(campo).join('')}
    ${cfg.adjunto ? `<div class="f">${cfg.setImg ? '<label class="attach">📎 Adjuntar comprobante<input type="file" id="adjunto" ' + (NATIVO ? '' : 'accept="image/*,application/pdf"') + '></label>' : ''}<img class="thumb" id="thumb" hidden alt="Comprobante"> <a class="attach" id="pdf" hidden target="_blank" rel="noopener">📄 Ver comprobante (PDF)</a></div>` : ''}
    <div class="btns"><button class="btn" type="submit">${esc(cfg.okLabel || 'Guardar')}</button>
    ${cfg.onDelete ? `<button class="btn danger" type="button" data-act="eliminar">${esc(cfg.deleteLabel || 'Eliminar')}</button>` : ''}</div></form>`;
  $('#overlay').hidden = false;
  hoja.logo = cfg.fields.find(f => f.type === 'logo')?.value || '';
  pintarLogo();
  visibilidad();
  if (cfg.imagen) mostrarThumb(cfg.imagen);
  const primero = $('#sheet input[type=text]');
  if (primero && cfg.foco !== false) setTimeout(() => { primero.focus(); primero.select(); }, 60);
}
function cerrar() { $('#overlay').hidden = true; $('#sheet').innerHTML = ''; hoja = null; }
function valores() {
  const v = {};
  for (const f of hoja.fields) {
    if (f.type === 'nota') continue;
    if (f.type === 'chips') v[f.name] = $(`#form input[name="${f.name}"]:checked`)?.value ?? '';
    else if (f.type === 'color') { const c = $(`#form input[name="${f.name}"]:checked`)?.value ?? ''; v[f.name] = c === 'otro' ? $('#color-otro').value : c; }
    else if (f.type === 'logo') v[f.name] = hoja.logo || '';
    else if (f.type === 'money' || f.type === 'pesos') v[f.name] = soloNum($(`#form [name="${f.name}"]`).value);
    else if (f.type === 'number') v[f.name] = Number($(`#form [name="${f.name}"]`).value.replace(',', '.')) || 0;
    else v[f.name] = $(`#form [name="${f.name}"]`).value.trim();
  }
  return v;
}
function visibilidad() {
  const v = valores();
  for (const f of hoja.fields) {
    const el = $(`#form [data-f="${f.name}"]`);
    if (f.showIf) el.hidden = !f.showIf(v);
    if (f.type === 'nota' && !el.hidden) el.textContent = f.texto(v);
  }
}
function mostrarThumb(blob) {
  const pdf = blob.type === 'application/pdf', t = $(pdf ? '#pdf' : '#thumb'), otro = $(pdf ? '#thumb' : '#pdf');
  if (!t) return;
  if (pdf && NATIVO) t.textContent = '📄 PDF adjunto'; else t[pdf ? 'href' : 'src'] = URL.createObjectURL(blob);
  t.hidden = false; otro.hidden = true;
}
// Achica la foto del comprobante para que no ocupe mucho lugar.
async function achicar(file) {
  if (!file.type.startsWith('image/')) return file; // los PDF se guardan tal cual
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.75));
}

// Mes en que se paga una compra con tarjeta, según el día de cierre y de vencimiento del resumen.
function mesDePago(cta, fecha) {
  const m = fecha.slice(0, 7);
  if (!cta.cierre) return addYm(m, 1);
  const mesCierre = Number(fecha.slice(8)) <= cta.cierre ? m : addYm(m, 1);
  return cta.vence > cta.cierre ? mesCierre : addYm(mesCierre, 1);
}
const primerPago = v => v.primer === 'auto' ? mesDePago(cuenta(v.cuentaId), v.fecha || hoy()) : addYm((v.fecha || hoy()).slice(0, 7), Number(v.primer));
const opCuentas = () => S.cuentas.map(c => ({ v: c.id, l: c.nombre, h: marca(c, 18) }));
const COLORES = ['#e53935', '#f57c00', '#f9c80e', '#2e9e4f', '#00a3c4', '#1e63d6', '#7b4bd6', '#d6418a', '#6b7280', '#111827'];
const esColor = c => /^#[0-9a-f]{6}$/i.test(c || '');
// Logo de la tarjeta, o un punto de su color si no tiene logo.
function marca(c, tam = 22) {
  if (c?.logo?.startsWith('data:image/')) return `<img class="logo" src="${c.logo}" alt="" style="width:${tam}px;height:${tam}px">`;
  return esColor(c?.color) ? `<i class="punto" style="background:${c.color};width:${Math.round(tam * .55)}px;height:${Math.round(tam * .55)}px"></i>` : '';
}
// Recorta los bordes vacíos del logo, lo achica a 128 px y calcula su color predominante.
async function procesarLogo(file) {
  const bmp = await createImageBitmap(file), k = Math.min(1, 400 / Math.max(bmp.width, bmp.height));
  const a = document.createElement('canvas');
  a.width = Math.max(1, Math.round(bmp.width * k)); a.height = Math.max(1, Math.round(bmp.height * k));
  const ca = a.getContext('2d', { willReadFrequently: true });
  ca.drawImage(bmp, 0, 0, a.width, a.height);
  const px = ca.getImageData(0, 0, a.width, a.height).data;
  let x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  const cuenta = new Map();
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
    if (px[i + 3] < 40) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) continue; // blancos, grises y negros no definen el color
    const q = (r >> 4 << 8) | (g >> 4 << 4) | (b >> 4);
    cuenta.set(q, (cuenta.get(q) || 0) + 1);
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = a.width - 1; y1 = a.height - 1; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, e = Math.min(1, 128 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  c.getContext('2d').drawImage(a, x0, y0, w, h, (128 - w * e) / 2, (128 - h * e) / 2, w * e, h * e);
  let color = '';
  if (cuenta.size) {
    const q = [...cuenta].sort((p, r) => r[1] - p[1])[0][0];
    color = '#' + [q >> 8, q >> 4 & 15, q & 15].map(n => (n * 17).toString(16).padStart(2, '0')).join('');
  }
  return { url: c.toDataURL('image/png'), color };
}
function pintarLogo() {
  const img = $('#logo-prev'); if (!img) return;
  img.hidden = !hoja.logo; if (hoja.logo) img.src = hoja.logo;
  $('#logo-quitar').hidden = !hoja.logo;
}
const esCredito = id => cuenta(id).tipo === 'credito';

async function formGasto(g, extra = {}) {
  const ed = !!g;
  g = g || { monto: extra.monto || 0, cat: extra.cat || S.categorias[0]?.id, cuentaId: extra.cuentaId || (S.ultimaCuenta && S.cuentas.some(c => c.id === S.ultimaCuenta) ? S.ultimaCuenta : S.cuentas[0]?.id), desc: extra.desc || '', fecha: extra.fecha || hoy() };
  let img = extra.img || (ed && g.img ? await db.get('img:' + g.id).catch(() => null) : null);
  abrir({
    title: ed ? 'Editar gasto' : 'Nuevo gasto', adjunto: true, imagen: img, despues: extra.despues,
    fields: [
      { name: 'monto', type: 'money', value: g.monto },
      ...(ed ? [] : [{ name: 'clase', type: 'chips', value: extra.clase || 'gasto', options: [{ v: 'gasto', l: 'Gasté' }, { v: 'ingreso', l: 'Me entró plata' }] }]),
      { name: 'cat', type: 'chips', label: 'Categoría', value: g.cat, options: S.categorias.map(c => ({ v: c.id, l: `${c.emoji} ${c.nombre}` })), showIf: v => v.clase !== 'ingreso' },
      { name: 'cuentaId', type: 'chips', label: 'Pagué con', value: g.cuentaId, options: opCuentas(), showIf: v => v.clase !== 'ingreso' },
      { name: 'cuotas', type: 'chips', label: 'Cuotas', value: 1, options: [1, 2, 3, 6, 9, 12, 18, 24].map(n => ({ v: n, l: n === 1 ? '1 pago' : String(n) })), showIf: v => !ed && v.clase !== 'ingreso' && esCredito(v.cuentaId) },
      { name: 'primer', type: 'chips', label: 'Primer pago', value: 'auto', options: [{ v: 'auto', l: 'Automático' }, { v: 0, l: 'Mismo mes' }, { v: 1, l: 'Mes siguiente' }, { v: 2, l: 'A los 2 meses' }], showIf: v => !ed && v.clase !== 'ingreso' && esCredito(v.cuentaId) },
      { name: 'cuando', type: 'nota', showIf: v => !ed && v.clase !== 'ingreso' && esCredito(v.cuentaId), texto: v => {
        const c = cuenta(v.cuentaId), n = Number(v.cuotas) || 1, m = primerPago(v);
        return `${n > 1 ? 'La primera cuota entra' : 'Entra'} en ${mesNombre(m)}${v.primer === 'auto' ? (c.cierre ? ` (${c.nombre} cierra el ${c.cierre})` : '. Cargá el día de cierre de la tarjeta en Ajustes para que se calcule solo') : ''}.`;
      } },
      { name: 'desc', type: 'text', label: 'Detalle (opcional)', value: g.desc, placeholder: 'Ej: almuerzo, nafta…' },
      { name: 'fecha', type: 'date', label: 'Fecha', value: g.fecha },
    ],
    setImg: b => { img = b; },
    onSave: async v => {
      if (!v.monto) return 'Poné un monto';
      const id = ed ? g.id : uid();
      if (img) await db.set('img:' + id, img);
      if (v.clase === 'ingreso') {
        // Plata que entró (ej. una transferencia recibida): va a los ingresos de ese mes.
        const mes = (v.fecha || hoy()).slice(0, 7);
        S.ingresos.push({ id, nombre: v.desc || 'Ingreso', monto: v.monto, tipo: 'unico', inicio: mes, total: 1, fecha: v.fecha, img: !!img });
        toast(`Ingreso de ${fmt(v.monto)} anotado en ${mesNombre(mes)}`);
        return;
      }
      if (!v.cuentaId) return 'Elegí con qué pagaste';
      S.ultimaCuenta = v.cuentaId;
      if (!ed && esCredito(v.cuentaId)) {
        // Compra con crédito: pasa a la pestaña Mensual, repartida en cuotas.
        const n = Number(v.cuotas) || 1, inicio = primerPago(v);
        S.compromisos.push({ id, nombre: v.desc || categoria(v.cat).nombre, cuentaId: v.cuentaId, monto: Math.round(v.monto / n), tipo: n > 1 ? 'cuotas' : 'unico', inicio, total: n, fecha: v.fecha, cat: v.cat, img: !!img });
        toast(`${cuenta(v.cuentaId).nombre}: ${n > 1 ? n + ' cuotas de ' + fmt(v.monto / n) : fmt(v.monto)} desde ${mesNombre(inicio)}`);
      } else {
        const nuevo = { id, fecha: v.fecha || hoy(), monto: v.monto, desc: v.desc, cat: v.cat, cuentaId: v.cuentaId, img: !!img };
        if (ed) S.gastos[S.gastos.findIndex(x => x.id === id)] = nuevo; else S.gastos.push(nuevo);
        if (!ed) toast('Gasto anotado');
      }
    },
    onDelete: ed ? () => { S.gastos = S.gastos.filter(x => x.id !== g.id); db.del('img:' + g.id); } : null,
  });
}

// Compromisos (cuotas / fijos) e ingresos comparten forma: nombre, monto, tipo y desde cuándo.
async function formComp(c, esIngreso) {
  const ed = !!c, lista = esIngreso ? 'ingresos' : 'compromisos';
  const nAct = ed && c.tipo === 'cuotas' ? Math.min(c.total, Math.max(1, ymIdx(ym) - ymIdx(c.inicio) + 1)) : 1;
  const vis = ed ? enMes(c, ym) : null;
  const img = ed && c.img ? await db.get('img:' + c.id).catch(() => null) : null;
  const tipos = esIngreso ? [{ v: 'mensual', l: 'Todos los meses' }, { v: 'unico', l: 'Solo este mes' }]
    : [{ v: 'cuotas', l: 'En cuotas' }, { v: 'mensual', l: 'Fijo mensual' }, { v: 'unico', l: 'Un solo pago' }];
  abrir({
    title: (ed ? 'Editar ' : 'Nuevo ') + (esIngreso ? 'ingreso' : 'cuota o fijo'), imagen: img, adjunto: !!img,
    fields: [
      { name: 'monto', type: 'money', value: ed ? (vis ? vis.monto : c.monto) : 0, label: 'Monto' },
      { name: 'nombre', type: 'text', label: esIngreso ? 'De dónde viene' : 'Qué es', value: c?.nombre, placeholder: esIngreso ? 'Ej: sueldo' : 'Ej: alquiler, teclado…' },
      ...(esIngreso ? [] : [{ name: 'cuentaId', type: 'chips', label: 'Tarjeta o cuenta', value: c?.cuentaId || S.cuentas.find(x => x.tipo === 'credito')?.id || S.cuentas[0]?.id, options: opCuentas() }]),
      { name: 'tipo', type: 'chips', label: 'Se repite', value: c?.tipo || (esIngreso ? 'mensual' : 'cuotas'), options: tipos },
      { name: 'n', type: 'number', label: `Cuota que toca en ${mesNombre(ym)}`, value: nAct, showIf: v => v.tipo === 'cuotas' },
      { name: 'total', type: 'number', label: 'Cantidad total de cuotas', value: c?.total || 3, showIf: v => v.tipo === 'cuotas' },
      ...(esIngreso ? [] : [{ name: 'usd', type: 'number', label: 'Precio en dólares (opcional: reemplaza el monto en pesos)', value: c?.usd || '', placeholder: 'Ej: 9,99' }]),
      ...(esIngreso ? [] : [{ name: 'ajuste', type: 'number', label: 'Aumento estimado por mes, en % (opcional, ej. préstamo UVA)', value: c?.ajuste || '', showIf: v => v.tipo !== 'unico' }]),
    ],
    onSave: async v => {
      if (v.usd > 0) {
        if (!dolarMes(ym)) await actualizarDolar(true);
        if (!dolarMes(ym)) return 'No pude traer el dólar: cargalo a mano en Ajustes';
        v.monto = Math.round(v.usd * dolarMes(ym)); v.ajuste = 0;
      }
      if (!v.monto) return 'Poné un monto';
      if (!v.nombre) return 'Ponele un nombre';
      const total = Math.max(1, Math.round(v.total)), n = Math.min(total, Math.max(1, Math.round(v.n)));
      const base = { nombre: v.nombre, monto: v.monto, tipo: v.tipo, ...(esIngreso ? {} : { cuentaId: v.cuentaId, usd: v.usd > 0 ? v.usd : 0 }) };
      if (v.ajuste) { base.ajuste = v.ajuste; base.base = ym; } else { base.ajuste = 0; }
      if (v.tipo === 'cuotas') { base.total = total; base.inicio = addYm(ym, -(n - 1)); }
      if (!ed) { S[lista].push({ id: uid(), inicio: ym, total: 1, ...base }); return; }
      const cambioMonto = v.monto !== (vis ? vis.monto : c.monto);
      if (v.tipo === 'mensual' && c.tipo === 'mensual' && cambioMonto && ymIdx(c.inicio) < ymIdx(ym)) {
        // Cambió el monto de algo mensual: vale desde este mes, los meses anteriores quedan como estaban.
        S[lista].push({ ...c, ...base, id: uid(), inicio: ym, base: ym });
        c.fin = addYm(ym, -1);
      } else {
        if (v.tipo !== 'cuotas' && c.tipo === 'cuotas') base.inicio = ym;
        Object.assign(c, base);
        if (!cambioMonto && c.ajuste && vis) { c.monto = vis.monto; c.base = ym; }
      }
    },
    deleteLabel: ed && c.tipo === 'mensual' && ymIdx(c.inicio) < ymIdx(ym) ? `Terminar desde ${mesNombre(ym)}` : 'Eliminar',
    onDelete: ed ? () => {
      if (c.tipo === 'mensual' && ymIdx(c.inicio) < ymIdx(ym)) c.fin = addYm(ym, -1);
      else { S[lista] = S[lista].filter(x => x.id !== c.id); db.del('img:' + c.id); }
    } : null,
  });
}

function formCuenta(c) {
  abrir({
    title: c ? 'Editar medio de pago' : 'Nuevo medio de pago',
    fields: [
      { name: 'nombre', type: 'text', label: 'Nombre', value: c?.nombre, placeholder: 'Ej: Amex, Mercado Pago…' },
      { name: 'tipo', type: 'chips', label: 'Cómo se paga', value: c?.tipo || 'credito', options: [{ v: 'credito', l: 'Crédito (resumen mensual)' }, { v: 'contado', l: 'Contado (débito, efectivo)' }, { v: 'ajeno', l: 'Lo paga otro (ej. tarjeta del trabajo)' }] },
      { name: 'color', type: 'color', label: 'Color', value: c?.color },
      { name: 'logo', type: 'logo', label: 'Logo (opcional)', value: c?.logo },
      { name: 'cierre', type: 'number', label: 'Día del mes en que cierra el resumen (opcional)', value: c?.cierre || '', placeholder: 'Ej: 25', showIf: v => v.tipo === 'credito' },
      { name: 'vence', type: 'number', label: 'Día del mes en que vence el pago (opcional)', value: c?.vence || '', placeholder: 'Ej: 10', showIf: v => v.tipo === 'credito' },
    ],
    onSave: v => {
      if (!v.nombre) return 'Ponele un nombre';
      const dia = x => Math.min(31, Math.max(0, Math.round(x)));
      v.cierre = v.tipo === 'credito' ? dia(v.cierre) : 0; v.vence = v.tipo === 'credito' && v.cierre ? dia(v.vence) : 0;
      if (c) Object.assign(c, v); else S.cuentas.push({ id: uid(), ...v });
    },
    onDelete: c ? () => {
      if (S.compromisos.some(x => x.cuentaId === c.id) || S.gastos.some(x => x.cuentaId === c.id)) return 'Tiene movimientos cargados: no se puede eliminar';
      S.cuentas = S.cuentas.filter(x => x.id !== c.id);
    } : null,
  });
}
function formCat(c) {
  abrir({
    title: c ? 'Editar categoría' : 'Nueva categoría',
    fields: [
      { name: 'nombre', type: 'text', label: 'Nombre', value: c?.nombre },
      { name: 'emoji', type: 'text', label: 'Emoji', value: c?.emoji || '📦' },
      { name: 'tope', type: 'pesos', label: 'Tope mensual para esta categoría (opcional)', value: c?.tope || 0 },
    ],
    onSave: v => {
      if (!v.nombre) return 'Ponele un nombre';
      v.emoji = v.emoji || '📦';
      if (c) Object.assign(c, v); else S.categorias.push({ id: uid(), ...v });
    },
    onDelete: c ? () => {
      if (S.categorias.length < 2) return 'Tiene que quedar al menos una categoría';
      const otra = S.categorias.find(x => x.id !== c.id).id;
      S.gastos.forEach(g => { if (g.cat === c.id) g.cat = otra; });
      S.categorias = S.categorias.filter(x => x.id !== c.id);
    } : null,
  });
}
function formDolar() {
  abrir({
    title: 'Dólar de referencia', foco: false,
    fields: [
      { name: 'modo', type: 'chips', value: S.dolarAuto === false ? 'manual' : 'auto', options: [{ v: 'auto', l: 'Automático (dólar tarjeta)' }, { v: 'manual', l: 'Lo cargo yo' }] },
      { name: 'dolar', type: 'money', value: dolarMes(ym), showIf: v => v.modo === 'manual' },
      { name: 'desde', type: 'nota', showIf: v => v.modo === 'manual', texto: () => `Vale desde ${mesNombre(ym)}; los meses anteriores conservan su valor.` },
    ],
    onSave: async v => {
      S.dolarAuto = v.modo === 'auto';
      if (S.dolarAuto) {
        await actualizarDolar(true);
        if (S.dolarError) toast('No pude traer la cotización ahora; se reintenta al abrir la app');
        return;
      }
      if (!v.dolar) return 'Poné un valor';
      (S.dolares ??= {})[ym] = v.dolar;
    },
  });
}
function formPresu() {
  abrir({
    title: 'Tope mensual del día a día',
    fields: [{ name: 'presupuesto', type: 'money', value: S.presupuesto }],
    onSave: v => { S.presupuesto = v.presupuesto; },
  });
}

/* ---------- respaldo ---------- */
function descargar(nombre, texto, tipo) {
  if (NATIVO) { NATIVO.guardar(nombre, tipo, texto); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo }));
  a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// Baja de nuevo los archivos de la app, reemplaza la copia guardada y recarga. Los datos no se tocan.
async function actualizarApp() {
  if (!navigator.onLine) return toast('Necesitás conexión para actualizar');
  toast('Buscando la última versión…');
  try {
    const archivos = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest'];
    const frescos = await Promise.all(archivos.map(f => fetch(f, { cache: 'no-store' })));
    if (frescos.some(r => !r.ok)) throw 0;
    // Deja una sola copia guardada, con lo recién bajado, que es la que va a usar la app al recargar.
    const nombres = (await caches.keys()).filter(k => k.startsWith('gastos-v'));
    const destino = await caches.open(nombres.sort().pop() || 'gastos-v0');
    await Promise.all(frescos.map((r, i) => destino.put(new URL(archivos[i], location.href).href.split('?')[0], r)));
    (await navigator.serviceWorker?.getRegistration?.())?.update().catch(() => {});
    sessionStorage.setItem('venia-de', String(VERSION));
    location.reload();
  } catch { toast('No se pudo actualizar: revisá la conexión'); }
}
async function respaldar(soloDescargar) {
  const texto = JSON.stringify(S, null, 1), n = `gastos-respaldo-${hoy()}`;
  const listo = () => { S.ultimoRespaldo = hoy(); guardar(); toast('Respaldo guardado'); };
  if (NATIVO && !soloDescargar) { if (NATIVO.compartir(n + '.json', 'application/json', texto)) listo(); return; }
  if (!soloDescargar) {
    // En Android abre el menú Compartir para mandarlo a Drive, WhatsApp, mail, etc.
    for (const f of [new File([texto], n + '.json', { type: 'application/json' }), new File([texto], n + '.txt', { type: 'text/plain' })]) {
      if (!navigator.canShare?.({ files: [f] })) continue;
      try { await navigator.share({ files: [f], title: 'Respaldo de Gastos' }); listo(); return; }
      catch (e) { if (e.name === 'AbortError') return; break; }
    }
  }
  descargar(n + '.json', texto, 'application/json'); listo();
}
function exportarCsv() {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const filas = [['Fecha', 'Tipo', 'Detalle', 'Categoría', 'Medio', 'Cuota', 'Monto']];
  for (const g of [...S.gastos].sort((a, b) => a.fecha.localeCompare(b.fecha))) filas.push([g.fecha, 'Gasto', g.desc, categoria(g.cat).nombre, cuenta(g.cuentaId).nombre, '', g.monto]);
  for (const x of compsMes(ym)) filas.push([ym, 'Mensual', x.c.nombre, '', cuenta(x.c.cuentaId).nombre, x.etiqueta, x.monto]);
  for (const x of ingresosMes(ym)) filas.push([ym, 'Ingreso', x.c.nombre, '', '', '', x.monto]);
  descargar(`gastos-${ym}.csv`, '﻿' + filas.map(f => f.map(q).join(',')).join('\n'), 'text/csv');
}
// Pide confirmación con una hoja propia (los diálogos del sistema no son confiables dentro de la app Android).
function confirmar(titulo, texto, boton, alAceptar) {
  abrir({ title: titulo, foco: false, okLabel: boton, fields: [{ name: 'aviso', type: 'nota', texto: () => texto }], onSave: alAceptar });
}
async function importar(file) {
  let d;
  try {
    d = JSON.parse(await file.text());
    if (!Array.isArray(d.cuentas) || !Array.isArray(d.compromisos) || !Array.isArray(d.gastos)) throw 0;
  } catch { return toast('Ese archivo no es un respaldo válido'); }
  confirmar('Cargar respaldo', `El respaldo tiene ${d.gastos.length} gastos, ${d.compromisos.length} cuotas o fijos y ${(d.ingresos || []).length} ingresos. Reemplaza todo lo que hay cargado ahora en la app.`, 'Reemplazar todo', () => {
    S = { ...inicial(), ...d, ultimoRespaldo: hoy() };
    toast('Respaldo cargado');
  });
}

/* ---------- lectura del comprobante (OCR, corre en el teléfono) ---------- */
const OCR = { workerPath: 'ocr/worker.min.js', corePath: 'ocr/', langPath: 'ocr/', workerBlobURL: false };
let ocr = null;
function motorOcr() {
  return ocr ??= (async () => {
    if (!window.Tesseract) await new Promise((ok, err) => { const s = document.createElement('script'); s.src = 'ocr/tesseract.min.js'; s.onload = ok; s.onerror = err; document.head.append(s); });
    const w = await Tesseract.createWorker('spa', 1, OCR);
    await w.setParameters({ tessedit_pageseg_mode: '11' });
    return w;
  })().catch(e => { ocr = null; throw e; });
}
const MES_NUM = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
// Saca monto y fecha de las líneas leídas ({ t: texto, h: alto de letra }).
function interpretar(lineas) {
  // El importe del comprobante es el "$ ..." escrito más grande.
  let mejor = null;
  for (const l of lineas) {
    const m = l.t.match(/\$\s?(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,\d{1,2})?/);
    if (!m) continue;
    const monto = soloNum(m[1]);
    if (monto && (!mejor || l.h > mejor.h)) mejor = { h: l.h, monto };
  }
  let fecha = '';
  const f = lineas.map(l => l.t).join('\n').toLowerCase().match(/\b(\d{1,2})\s*(?:\/|-|de)\s*(\d{1,2}|[a-z]{3,10})\s*(?:\/|-|de)\s*(\d{4})\b/);
  if (f) {
    const mes = Number(f[2]) || MES_NUM[f[2].slice(0, 3)], iso = `${f[3]}-${pad(mes)}-${pad(f[1])}`;
    if (mes >= 1 && mes <= 12 && Number(f[1]) <= 31 && iso <= hoy()) fecha = iso;
  }
  return { monto: mejor?.monto || 0, fecha };
}
async function leerLienzo(c) {
  const { data } = await (await motorOcr()).recognize(c, {}, { blocks: true });
  const lineas = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) lineas.push({ t: l.text, h: l.bbox.y1 - l.bbox.y0 });
  return interpretar(lineas);
}
async function leerImagen(blob) {
  const bmp = await createImageBitmap(blob), k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return leerLienzo(c);
}
// PDF: usa el texto que trae adentro; si es una imagen escaneada, la dibuja y la lee como foto.
async function leerPdf(blob) {
  const pdfjs = await import('./ocr/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'ocr/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const pag = await doc.getPage(1);
  const filas = new Map();
  for (const it of (await pag.getTextContent()).items) {
    if (!it.str?.trim()) continue;
    const y = Math.round(it.transform[5] / 3);
    if (!filas.has(y)) filas.set(y, []);
    filas.get(y).push(it);
  }
  const lineas = [...filas.values()].map(f => ({ t: f.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' '), h: Math.max(...f.map(i => Math.hypot(i.transform[2], i.transform[3]))) }));
  const r = interpretar(lineas);
  if (r.monto) return r;
  const vp = pag.getViewport({ scale: 2 }), c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await pag.render({ canvasContext: c.getContext('2d'), viewport: vp, canvas: c }).promise;
  return leerLienzo(c);
}
const leerComprobante = blob => blob.type === 'application/pdf' ? leerPdf(blob) : leerImagen(blob);
// Lee el comprobante y completa el formulario abierto, sin pisar lo que ya se escribió.
async function autocompletar(blob) {
  if (!blob || !(blob.type.startsWith('image/') || blob.type === 'application/pdf')) return;
  const mia = hoja, campo = () => $('#form [name=monto]');
  if (!campo() || soloNum(campo().value)) return;
  toast('Leyendo el comprobante…');
  try {
    const r = await leerComprobante(blob);
    if (hoja !== mia || !campo()) return;
    if (r.monto && !soloNum(campo().value)) campo().value = miles(r.monto);
    if (r.fecha && $('#form [name=fecha]')) $('#form [name=fecha]').value = r.fecha;
    toast(r.monto ? `Leí ${fmt(r.monto)}: revisá y guardá` : 'No pude leer el monto: completalo a mano');
  } catch { toast('No pude leer el comprobante: completá el monto'); }
}

/* ---------- compartir desde otra app ---------- */
async function levantarCompartido() {
  try {
    const c = await caches.open('gastos-compartido');
    const t = await c.match('compartido-texto'), a = await c.match('compartido-archivo');
    const texto = t ? await t.text() : '';
    let img = null;
    if (a) { const b = await a.blob(); if (b.type.startsWith('image/') || b.type === 'application/pdf') img = await achicar(b); }
    await c.delete('compartido-texto'); await c.delete('compartido-archivo');
    await abrirCompartido(texto, img);
  } catch { formGasto(); }
}
async function abrirCompartido(texto, img) {
  const m = texto.match(RE_MONTO);
  await formGasto(null, { monto: m ? soloNum(m[1]) : 0, img, desc: '' });
  if (!m && img) autocompletar(img);
}

/* ---------- puente con la app Android ---------- */
let arrancado = false;
// La parte nativa avisa que llegó algo por "Compartir"; la página lo pide y abre el formulario.
window.nativoCompartido = async () => {
  if (!arrancado || !NATIVO?.hayCompartido()) return;
  const texto = NATIVO.compartidoTexto(), mime = NATIVO.compartidoMime(), b64 = NATIVO.compartidoDatos();
  NATIVO.compartidoListo();
  try {
    let img = null;
    if (b64 && (mime.startsWith('image/') || mime === 'application/pdf')) {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      img = await achicar(new Blob([bytes], { type: mime }));
    }
    if (hoja) cerrar();
    tab = 'inicio'; render();
    await abrirCompartido(texto, img);
  } catch { toast('No pude abrir lo que compartiste'); }
};
// Al volver a la app: refresca por si se detectaron pagos nuevos.
// Solo redibuja Inicio: en otras pantallas volver a dibujar reemplaza el campo de archivo justo cuando
// Android está por entregarle el archivo elegido, y la carga se pierde sin aviso.
window.nativoVolvio = () => { if (!hoja && tab === 'inicio') render(); };
// Botón Atrás de Android: cierra el formulario o vuelve a Inicio. Devuelve false si no había nada que cerrar.
window.atras = () => {
  if (hoja) { cerrar(); return true; }
  if (tab === 'deudor') { tab = 'plan'; render(); return true; }
  if (tab !== 'inicio') { tab = 'inicio'; render(); return true; }
  return false;
};

/* ---------- eventos ---------- */
let tToast;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(tToast); tToast = setTimeout(() => { t.hidden = true; }, 2800);
}

const acciones = {
  'mes-prev': () => { ym = addYm(ym, -1); },
  'mes-next': () => { ym = addYm(ym, 1); },
  'mes-hoy': () => { ym = hoy().slice(0, 7); },
  'nuevo-gasto': () => formGasto(),
  'editar-gasto': id => formGasto(S.gastos.find(g => g.id === id)),
  'nuevo-comp': () => formComp(null, false),
  'editar-comp': id => formComp(S.compromisos.find(c => c.id === id), false),
  'nuevo-ing': () => formComp(null, true),
  'editar-ing': id => formComp(S.ingresos.find(c => c.id === id), true),
  'pagar-cuenta': id => {
    const p = S.pagos[ym] ??= {}, its = compsMes(ym).filter(x => x.c.cuentaId === id), todo = its.every(x => p[x.c.id]);
    for (const x of its) { if (todo) delete p[x.c.id]; else p[x.c.id] = true; }
    guardar();
  },
  'det-permiso': () => { S.sinLector = false; NATIVO.pedirPermiso(); },
  'det-no': () => { S.sinLector = true; guardar(); },
  'det-usar': id => {
    const d = detectados().find(x => x.id === id);
    if (d) return formGasto(null, { monto: d.monto, desc: d.desc, fecha: d.fecha, clase: d.ingreso ? 'ingreso' : 'gasto', despues: () => NATIVO.descartar(id) });
  },
  'det-quitar': id => {
    const d = detectados().find(x => x.id === id);
    if (!d) return;
    abrir({
      title: 'Descartar', foco: false,
      fields: [{ name: 'que', type: 'chips', value: 'uno', options: [{ v: 'uno', l: 'Solo este aviso' }, { v: 'app', l: `No leer más avisos de ${d.app}` }] }],
      onSave: v => { if (v.que === 'app') NATIVO.bloquear(d.paquete); else NATIVO.descartar(id); },
    });
  },
  'logo-quitar': () => { hoja.logo = ''; pintarLogo(); },
  'ir-mensual': () => { tab = 'mensual'; },
  'ir-buscar': () => { tab = 'buscar'; window.scrollTo(0, 0); },
  'evo': m => { evoSel = m; },
  'pagar': id => { const p = S.pagos[ym] ??= {}; if (p[id]) delete p[id]; else p[id] = true; guardar(); },
  'nueva-cuenta': () => formCuenta(),
  'editar-cuenta': id => formCuenta(S.cuentas.find(c => c.id === id)),
  'nueva-cat': () => formCat(),
  'editar-cat': id => formCat(S.categorias.find(c => c.id === id)),
  'editar-presu': () => formPresu(),
  'editar-dolar': () => formDolar(),
  'actualizar': actualizarApp,
  'editar-meta': () => formMeta(),
  'nuevo-deudor': () => formDeudor(),
  'ver-deudor': id => { deudorSel = id; tab = 'deudor'; window.scrollTo(0, 0); },
  'editar-deudor': () => formDeudor(S.deudores.find(x => x.id === deudorSel)),
  'mov-deudor': signo => formMovDeudor(null, Number(signo)),
  'editar-mov-deudor': id => formMovDeudor(S.deudores.find(x => x.id === deudorSel).movs.find(m => m.id === id)),
  'ir-plan': () => { tab = 'plan'; },
  'editar-ahorro': m => formAhorro(m),
  'exportar': () => respaldar(true),
  'respaldar': () => respaldar(false),
  'repetir': id => { const g = S.gastos.find(x => x.id === id); return formGasto(null, { monto: g.monto, desc: g.desc, cat: g.cat, cuentaId: g.cuentaId }); },
  'csv': exportarCsv,
  'borrar-todo': () => confirmar('Borrar todo', 'Se borran TODOS los datos de la app. No se puede deshacer.', 'Borrar todo', () => { S = inicial(); toast('Datos borrados'); }),
  'cerrar': cerrar,
  'eliminar': async () => {
    const err = await hoja.onDelete();
    if (typeof err === 'string') return toast(err);
    await guardar(); cerrar();
  },
};

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (e.target.id === 'overlay') return cerrar();
  const b = e.target.closest('[data-act]');
  if (!b) return;
  await acciones[b.dataset.act]?.(b.dataset.id);
  if (!hoja) render();
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (!hoja) return;
  const err = await hoja.onSave(valores());
  if (typeof err === 'string') return toast(err);
  hoja.despues?.();
  await guardar(); cerrar(); render();
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { filtro.q = e.target.value; $('#res').innerHTML = resultados(); return; }
  if (e.target.closest('.f.money') || e.target.dataset.miles != null) e.target.value = miles(soloNum(e.target.value));
});
document.addEventListener('change', async e => {
  if (e.target.id === 'importar' && e.target.files[0]) { const f = e.target.files[0]; e.target.value = ''; return importar(f); }
  if (e.target.id === 'color-otro') { $('#form input[value="otro"]').checked = true; e.target.parentElement.style.background = e.target.value; return; }
  if (e.target.id === 'logo-in' && e.target.files[0] && hoja) {
    try {
      const r = await procesarLogo(e.target.files[0]);
      hoja.logo = r.url; pintarLogo();
      // Si todavía no eligió color, propone el del logo.
      if (r.color && !$('#form input[name="color"]:checked')?.value) { $('#color-otro').value = r.color; $('#color-otro').parentElement.style.background = r.color; $('#form input[value="otro"]').checked = true; }
    } catch { toast('No pude leer esa imagen'); }
    return;
  }
  if (e.target.id === 'adjunto' && e.target.files[0] && hoja?.setImg) {
    const f = e.target.files[0];
    if (!f.type.startsWith('image/') && f.type !== 'application/pdf') { toast('Elegí una foto o un PDF'); return; }
    const b = await achicar(f); hoja.setImg(b); mostrarThumb(b); autocompletar(b); return;
  }
  if (e.target.id === 'f-cat' || e.target.id === 'f-cta') { filtro[e.target.id.slice(2)] = e.target.value; $('#res').innerHTML = resultados(); return; }
  if (hoja && e.target.closest('#form')) visibilidad();
});

/* ---------- arranque ---------- */
(async () => {
  try { const g = await db.get('estado'); if (g) S = { ...inicial(), ...g }; } catch { toast('No se pudo leer lo guardado'); }
  render();
  arrancado = true;
  const antes = Number(sessionStorage.getItem('venia-de'));
  if (antes) {
    sessionStorage.removeItem('venia-de');
    tab = 'ajustes'; render();
    toast(VERSION > antes ? `Actualizada: versión ${antes} → ${VERSION}` : `Ya tenías la última versión (${VERSION})`);
  }
  window.nativoCompartido();
  navigator.storage?.persist?.();
  actualizarDolar();
  // Baja en segundo plano lo necesario para leer comprobantes, así después funciona sin conexión.
  setTimeout(() => { if (navigator.onLine) for (const f of ['tesseract.min.js', 'worker.min.js', 'spa.traineddata.gz', 'tesseract-core-relaxedsimd-lstm.wasm.js', 'pdf.min.mjs', 'pdf.worker.min.mjs']) fetch('ocr/' + f).catch(() => {}); }, 6000);
  if ('serviceWorker' in navigator) {
    // Cuando se instala una versión nueva, recarga sola (salvo que haya un formulario abierto) para no quedar con la vieja.
    const habia = !!navigator.serviceWorker.controller;
    let recargada = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!habia || recargada) return;
      recargada = true;
      if (hoja) toast('Hay una versión nueva: cerrá y abrí la app para verla'); else location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const p = new URLSearchParams(location.search);
  if (p.has('compartido')) { history.replaceState(null, '', './'); levantarCompartido(); }
  else if (p.has('nuevo')) { history.replaceState(null, '', './'); formGasto(); }
})();
