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
});

let S = inicial();
let ym = hoy().slice(0, 7);
let tab = 'inicio';
const guardar = () => db.set('estado', S).catch(() => toast('No se pudo guardar'));

/* ---------- cálculos ---------- */
// Devuelve cómo aparece un compromiso en un mes dado, o null si no corresponde.
function enMes(c, m) {
  const d = ymIdx(m) - ymIdx(c.inicio);
  if (d < 0) return null;
  if (c.tipo === 'unico' && d !== 0) return null;
  if (c.tipo === 'cuotas' && d >= c.total) return null;
  if (c.tipo === 'mensual' && c.fin && m > c.fin) return null;
  const monto = c.ajuste ? Math.round(c.monto * Math.pow(1 + c.ajuste / 100, ymIdx(m) - ymIdx(c.base || c.inicio))) : c.monto;
  const etiqueta = c.tipo === 'cuotas' ? `${d + 1}/${c.total}` : c.tipo === 'mensual' ? 'Fijo' : '1 pago';
  return { c, monto, etiqueta, ultima: c.tipo === 'cuotas' && d + 1 === c.total };
}
const compsMes = m => S.compromisos.map(c => enMes(c, m)).filter(Boolean);
const ingresosMes = m => S.ingresos.map(i => enMes(i, m)).filter(Boolean);
const gastosMes = m => S.gastos.filter(g => g.fecha.startsWith(m));
const totalComps = m => sum(compsMes(m), x => x.monto);
const totalIngresos = m => sum(ingresosMes(m), x => x.monto);
const totalGastos = m => sum(gastosMes(m), g => g.monto);
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
  for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('#view').innerHTML = ({ inicio: vInicio, mensual: vMensual, resumen: vResumen, ajustes: vAjustes })[tab]();
}

function vInicio() {
  const ing = totalIngresos(ym), comp = totalComps(ym), gas = totalGastos(ym);
  const queda = ing - comp - gas;
  const gs = gastosMes(ym).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id.localeCompare(a.id));
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
      const tot = sum(gs.filter(x => x.fecha === dia), x => x.monto);
      lista += `${lista ? '</div>' : ''}<h2><span>${etiquetaDia(dia)}</span><span class="num">${fmt(tot)}</span></h2><div class="card">`;
    }
    const cat = categoria(g.cat);
    lista += `<button class="row" data-act="editar-gasto" data-id="${g.id}">
      <span class="emoji">${esc(cat.emoji)}</span>
      <span class="grow"><div class="t">${esc(g.desc || cat.nombre)}</div><div class="s">${esc(cuenta(g.cuentaId).nombre)}${g.img ? ' · 📎' : ''}</div></span>
      <span class="amt num">${fmt(g.monto)}</span></button>`;
  }
  lista = lista ? lista + '</div>' : `<div class="empty">Todavía no anotaste gastos este mes.<br>Tocá <b>+</b> para cargar el primero.</div>`;
  return `<section class="hero">
      <div class="lbl">Te queda este mes</div>
      <div class="big num ${queda < 0 ? 'neg' : ''}">${fmt(queda)}</div>
      <div class="sub">Ingresos ${fmt(ing)} · Fijos y cuotas ${fmt(comp)}</div>
    </section>${presu}${lista}`;
}

function etiquetaDia(f) {
  const d = new Date(f + 'T12:00'), h = hoy();
  if (f === h) return 'Hoy';
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
  if (f === `${ayer.getFullYear()}-${pad(ayer.getMonth() + 1)}-${pad(ayer.getDate())}`) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
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
    html += `<h2><span>${esc(cta.nombre)}</span><span class="num">${fmt(sum(its, x => x.monto))}</span></h2><div class="card">`;
    for (const x of its) {
      const ok = !!pagos[x.c.id];
      html += `<div class="row ${ok ? 'done' : ''}">
        <button class="check ${ok ? 'on' : ''}" data-act="pagar" data-id="${x.c.id}" aria-label="Marcar pagado">✓</button>
        <button class="grow" data-act="editar-comp" data-id="${x.c.id}" style="text-align:left"><div class="t" style="white-space:normal">${esc(x.c.nombre)}</div></button>
        <span class="badge ${x.ultima ? 'last' : ''}">${x.etiqueta}</span>
        <span class="amt num">${fmt(x.monto)}</span></div>`;
    }
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

  const porCat = S.categorias.map(c => ({ c, t: sum(gastosMes(ym).filter(g => g.cat === c.id), g => g.monto) })).filter(x => x.t > 0).sort((a, b) => b.t - a.t);
  if (porCat.length) {
    html += `<h2><span>En qué se fue</span><span class="num">${fmt(gas)}</span></h2><div class="card pad">` + porCat.map(x => `
      <div class="kv"><span style="color:var(--text)">${esc(x.c.emoji)} ${esc(x.c.nombre)}</span><span class="num">${fmt(x.t)} · ${Math.round(x.t / gas * 100)}%</span></div>
      <div class="bar"><div style="width:${x.t / porCat[0].t * 100}%"></div></div>`).join('') + '</div>';
  }

  html += `<h2><span>Próximos meses</span></h2><div class="card pad"><table><tr><th>Mes</th><th>Ingresos</th><th>A pagar</th><th>Queda</th></tr>`;
  for (let i = 0; i < 6; i++) {
    const m = addYm(ym, i), a = totalIngresos(m), b = totalComps(m), q = a - b - S.presupuesto;
    html += `<tr><td>${mesCorto(m)}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(b)}</td><td class="num ${q < 0 ? 'neg' : ''}"><b>${fmt(q)}</b></td></tr>`;
  }
  html += `</table><div class="hint">"Queda" descuenta también el tope de gastos del día a día${S.presupuesto ? ` (${fmt(S.presupuesto)})` : ''}.</div></div>`;

  html += `<h2><span>Deuda en cuotas</span></h2><div class="card">
    <div class="row"><span class="grow">Falta pagar desde ${mesNombre(ym)}</span><span class="amt num">${fmt(deudaDesde(ym))}</span></div>
    <div class="row"><span class="grow">Va a faltar desde ${mesNombre(addYm(ym, 1))}</span><span class="amt num">${fmt(deudaDesde(addYm(ym, 1)))}</span></div></div>`;
  return html;
}

function vAjustes() {
  return `<h2><span>Tope mensual del día a día</span></h2>
    <div class="card"><button class="row" data-act="editar-presu"><span class="grow">Tope</span><span class="amt num">${S.presupuesto ? fmt(S.presupuesto) : 'Sin tope'}</span></button></div>
    <h2><span>Tarjetas y medios de pago</span></h2><div class="card">
    ${S.cuentas.map(c => `<button class="row" data-act="editar-cuenta" data-id="${c.id}"><span class="grow t">${esc(c.nombre)}</span><span class="badge">${c.tipo === 'credito' ? 'Crédito' : 'Contado'}</span></button>`).join('')}
    <button class="row" data-act="nueva-cuenta"><span class="grow" style="color:var(--accent);font-weight:600">+ Agregar</span></button></div>
    <div class="hint">Lo que cargues con un medio de <b>crédito</b> va a la pestaña Mensual desde el mes siguiente. Lo de <b>contado</b> cuenta como gasto del día.</div>
    <h2><span>Categorías</span></h2><div class="card">
    ${S.categorias.map(c => `<button class="row" data-act="editar-cat" data-id="${c.id}"><span class="emoji">${esc(c.emoji)}</span><span class="grow t">${esc(c.nombre)}</span></button>`).join('')}
    <button class="row" data-act="nueva-cat"><span class="grow" style="color:var(--accent);font-weight:600">+ Agregar</span></button></div>
    <h2><span>Tus datos</span></h2>
    <div class="hint">Todo queda guardado solo en este teléfono. Hacé un respaldo cada tanto.</div>
    <div class="btns">
      <button class="btn ghost" data-act="exportar">Guardar respaldo (JSON)</button>
      <label class="btn ghost">Cargar respaldo<input type="file" id="importar" accept="application/json,.json" hidden></label>
      <button class="btn ghost" data-act="csv">Exportar gastos a planilla (CSV)</button>
      <button class="btn danger" data-act="borrar-todo">Borrar todo</button>
    </div>`;
}

/* ---------- formularios (hoja inferior) ---------- */
let hoja = null;
function abrir(cfg) {
  hoja = cfg;
  const campo = f => {
    const lab = f.label ? `<span class="lab">${esc(f.label)}</span>` : '';
    if (f.type === 'money') return `<div class="f money" data-f="${f.name}"><span>$</span><input name="${f.name}" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="${miles(f.value)}" aria-label="${esc(f.label || 'Monto')}"></div>`;
    if (f.type === 'chips') return `<div class="f" data-f="${f.name}">${lab}<div class="chips">${f.options.map(o => `<label class="chip"><input type="radio" name="${f.name}" value="${esc(o.v)}" ${String(o.v) === String(f.value) ? 'checked' : ''}><span>${esc(o.l)}</span></label>`).join('')}</div></div>`;
    return `<div class="f" data-f="${f.name}">${lab}<input name="${f.name}" type="${f.type}" value="${esc(f.value ?? '')}" ${f.type === 'number' ? 'inputmode="decimal" step="any"' : ''} placeholder="${esc(f.placeholder || '')}" autocomplete="off"></div>`;
  };
  $('#sheet').innerHTML = `<form id="form" novalidate>
    <div class="sheet-head"><h3>${esc(cfg.title)}</h3><button type="button" data-act="cerrar" aria-label="Cerrar">✕</button></div>
    ${cfg.fields.map(campo).join('')}
    ${cfg.adjunto ? `<div class="f">${cfg.setImg ? '<label class="attach">📎 Adjuntar comprobante<input type="file" id="adjunto" accept="image/*,application/pdf"></label>' : ''}<img class="thumb" id="thumb" hidden alt="Comprobante"> <a class="attach" id="pdf" hidden target="_blank" rel="noopener">📄 Ver comprobante (PDF)</a></div>` : ''}
    <div class="btns"><button class="btn" type="submit">Guardar</button>
    ${cfg.onDelete ? `<button class="btn danger" type="button" data-act="eliminar">${esc(cfg.deleteLabel || 'Eliminar')}</button>` : ''}</div></form>`;
  $('#overlay').hidden = false;
  visibilidad();
  if (cfg.imagen) mostrarThumb(cfg.imagen);
  const primero = $('#sheet input[type=text]');
  if (primero && cfg.foco !== false) setTimeout(() => primero.focus(), 60);
}
function cerrar() { $('#overlay').hidden = true; $('#sheet').innerHTML = ''; hoja = null; }
function valores() {
  const v = {};
  for (const f of hoja.fields) {
    if (f.type === 'chips') v[f.name] = $(`#form input[name="${f.name}"]:checked`)?.value ?? '';
    else if (f.type === 'money') v[f.name] = soloNum($(`#form [name="${f.name}"]`).value);
    else if (f.type === 'number') v[f.name] = Number($(`#form [name="${f.name}"]`).value.replace(',', '.')) || 0;
    else v[f.name] = $(`#form [name="${f.name}"]`).value.trim();
  }
  return v;
}
function visibilidad() {
  const v = valores();
  for (const f of hoja.fields) if (f.showIf) $(`#form [data-f="${f.name}"]`).hidden = !f.showIf(v);
}
function mostrarThumb(blob) {
  const pdf = blob.type === 'application/pdf', t = $(pdf ? '#pdf' : '#thumb'), otro = $(pdf ? '#thumb' : '#pdf');
  if (!t) return;
  t[pdf ? 'href' : 'src'] = URL.createObjectURL(blob); t.hidden = false; otro.hidden = true;
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

const opCuentas = () => S.cuentas.map(c => ({ v: c.id, l: c.nombre }));
const esCredito = id => cuenta(id).tipo === 'credito';

async function formGasto(g, extra = {}) {
  const ed = !!g;
  g = g || { monto: extra.monto || 0, cat: S.categorias[0]?.id, cuentaId: S.ultimaCuenta && S.cuentas.some(c => c.id === S.ultimaCuenta) ? S.ultimaCuenta : S.cuentas[0]?.id, desc: extra.desc || '', fecha: hoy() };
  let img = extra.img || (ed && g.img ? await db.get('img:' + g.id).catch(() => null) : null);
  abrir({
    title: ed ? 'Editar gasto' : 'Nuevo gasto', adjunto: true, imagen: img,
    fields: [
      { name: 'monto', type: 'money', value: g.monto },
      { name: 'cat', type: 'chips', label: 'Categoría', value: g.cat, options: S.categorias.map(c => ({ v: c.id, l: `${c.emoji} ${c.nombre}` })) },
      { name: 'cuentaId', type: 'chips', label: 'Pagué con', value: g.cuentaId, options: opCuentas() },
      { name: 'cuotas', type: 'chips', label: 'Cuotas', value: 1, options: [1, 2, 3, 6, 9, 12, 18, 24].map(n => ({ v: n, l: n === 1 ? '1 pago' : String(n) })), showIf: v => !ed && esCredito(v.cuentaId) },
      { name: 'primer', type: 'chips', label: 'Primer pago', value: 1, options: [{ v: 1, l: `En ${mesNombre(addYm(hoy().slice(0, 7), 1))}` }, { v: 0, l: `En ${mesNombre(hoy().slice(0, 7))}` }], showIf: v => !ed && esCredito(v.cuentaId) },
      { name: 'desc', type: 'text', label: 'Detalle (opcional)', value: g.desc, placeholder: 'Ej: almuerzo, nafta…' },
      { name: 'fecha', type: 'date', label: 'Fecha', value: g.fecha },
    ],
    setImg: b => { img = b; },
    onSave: async v => {
      if (!v.monto) return 'Poné un monto';
      if (!v.cuentaId) return 'Elegí con qué pagaste';
      S.ultimaCuenta = v.cuentaId;
      const id = ed ? g.id : uid();
      if (img) await db.set('img:' + id, img);
      if (!ed && esCredito(v.cuentaId)) {
        // Compra con crédito: pasa a la pestaña Mensual, repartida en cuotas.
        const n = Number(v.cuotas) || 1, inicio = addYm((v.fecha || hoy()).slice(0, 7), Number(v.primer));
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
      ...(esIngreso ? [] : [{ name: 'ajuste', type: 'number', label: 'Aumento estimado por mes, en % (opcional, ej. préstamo UVA)', value: c?.ajuste || '', showIf: v => v.tipo !== 'unico' }]),
    ],
    onSave: v => {
      if (!v.monto) return 'Poné un monto';
      if (!v.nombre) return 'Ponele un nombre';
      const total = Math.max(1, Math.round(v.total)), n = Math.min(total, Math.max(1, Math.round(v.n)));
      const base = { nombre: v.nombre, monto: v.monto, tipo: v.tipo, ...(esIngreso ? {} : { cuentaId: v.cuentaId }) };
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
      { name: 'tipo', type: 'chips', label: 'Cómo se paga', value: c?.tipo || 'credito', options: [{ v: 'credito', l: 'Crédito (resumen mensual)' }, { v: 'contado', l: 'Contado (débito, efectivo)' }] },
    ],
    onSave: v => {
      if (!v.nombre) return 'Ponele un nombre';
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
function formPresu() {
  abrir({
    title: 'Tope mensual del día a día',
    fields: [{ name: 'presupuesto', type: 'money', value: S.presupuesto }],
    onSave: v => { S.presupuesto = v.presupuesto; },
  });
}

/* ---------- respaldo ---------- */
function descargar(nombre, texto, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo }));
  a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportarCsv() {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const filas = [['Fecha', 'Tipo', 'Detalle', 'Categoría', 'Medio', 'Cuota', 'Monto']];
  for (const g of [...S.gastos].sort((a, b) => a.fecha.localeCompare(b.fecha))) filas.push([g.fecha, 'Gasto', g.desc, categoria(g.cat).nombre, cuenta(g.cuentaId).nombre, '', g.monto]);
  for (const x of compsMes(ym)) filas.push([ym, 'Mensual', x.c.nombre, '', cuenta(x.c.cuentaId).nombre, x.etiqueta, x.monto]);
  for (const x of ingresosMes(ym)) filas.push([ym, 'Ingreso', x.c.nombre, '', '', '', x.monto]);
  descargar(`gastos-${ym}.csv`, '﻿' + filas.map(f => f.map(q).join(',')).join('\n'), 'text/csv');
}
async function importar(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.cuentas) || !Array.isArray(d.compromisos) || !Array.isArray(d.gastos)) throw 0;
    if (!confirm('Esto reemplaza todo lo que hay cargado en la app por el contenido del respaldo. ¿Seguimos?')) return;
    S = { ...inicial(), ...d };
    await guardar(); render(); toast('Respaldo cargado');
  } catch { toast('Ese archivo no es un respaldo válido'); }
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
    const m = texto.match(/\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?/);
    formGasto(null, { monto: m ? soloNum(m[1]) : 0, img, desc: '' });
    if (!m && img) toast('Comprobante adjunto: completá el monto');
  } catch { formGasto(); }
}

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
  'pagar': id => { const p = S.pagos[ym] ??= {}; if (p[id]) delete p[id]; else p[id] = true; guardar(); },
  'nueva-cuenta': () => formCuenta(),
  'editar-cuenta': id => formCuenta(S.cuentas.find(c => c.id === id)),
  'nueva-cat': () => formCat(),
  'editar-cat': id => formCat(S.categorias.find(c => c.id === id)),
  'editar-presu': () => formPresu(),
  'exportar': () => descargar(`gastos-respaldo-${hoy()}.json`, JSON.stringify(S, null, 1), 'application/json'),
  'csv': exportarCsv,
  'borrar-todo': () => { if (confirm('¿Borrar TODOS los datos de la app? No se puede deshacer.')) { S = inicial(); guardar(); } },
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
  await guardar(); cerrar(); render();
});
document.addEventListener('input', e => {
  if (e.target.closest('.f.money')) e.target.value = miles(soloNum(e.target.value));
});
document.addEventListener('change', async e => {
  if (e.target.id === 'importar' && e.target.files[0]) return importar(e.target.files[0]);
  if (e.target.id === 'adjunto' && e.target.files[0] && hoja?.setImg) {
    const b = await achicar(e.target.files[0]); hoja.setImg(b); mostrarThumb(b); return;
  }
  if (hoja && e.target.closest('#form')) visibilidad();
});

/* ---------- arranque ---------- */
(async () => {
  try { const g = await db.get('estado'); if (g) S = { ...inicial(), ...g }; } catch { toast('No se pudo leer lo guardado'); }
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const p = new URLSearchParams(location.search);
  if (p.has('compartido')) { history.replaceState(null, '', './'); levantarCompartido(); }
  else if (p.has('nuevo')) { history.replaceState(null, '', './'); formGasto(); }
})();
