import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { CafeApi } from "./api";
import { lotValue, roastMetrics } from "./calculations";
import type { CoffeeLot, EntryKind, OperationsData, Provider, Purchase, RoastBatch, Status, View } from "./types";

const emptyData: OperationsData = { providers: [], purchases: [], lots: [], roasts: [] };
const nav: Array<{ view: View; label: string; icon: string }> = [
  { view: "dashboard", label: "Resumen", icon: "◫" },
  { view: "providers", label: "Proveedores", icon: "P" },
  { view: "purchases", label: "Compras", icon: "$" },
  { view: "lots", label: "Café verde", icon: "L" },
  { view: "roasts", label: "Tostados", icon: "R" },
];
const copy: Record<View, [string, string, string]> = {
  dashboard: ["Resumen operativo", "Todo el café, en orden.", "Compras, inventario y tostados conectados de origen a resultado."],
  providers: ["Directorio", "Proveedores", "Productores y proveedores de café verde."],
  purchases: ["Abastecimiento", "Compras", "Entradas de café y montos pagados, ligados a su proveedor."],
  lots: ["Inventario", "Lotes de café verde", "Peso recibido, procedencia y costo por kilogramo."],
  roasts: ["Producción", "Tostados", "Rendimiento, merma y costo base calculados automáticamente."],
};

function money(value: unknown, code = "MXN") {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(Number(value));
}
function weight(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 }).format(Number(value)) + " kg";
}
function showDate(value: string | null | undefined, time = false) {
  if (!value) return "—";
  const source = value.length === 10 ? value + "T12:00:00" : value;
  return new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(source));
}
function localNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function short(id: string) { return id.slice(0, 8).toUpperCase(); }
function statusText(status: Status) { return status === "draft" ? "Borrador" : status === "confirmed" ? "Confirmado" : "Anulado"; }
function Status({ value }: { value: Status }) { return <span className={"status status--" + value}>{statusText(value)}</span>; }
function Spinner({ text }: { text: string }) { return <div className="spinner-wrap"><span className="spinner" />{text}</div>; }

export default function App({ supabase }: { supabase: SupabaseClient }) {
  const [session, setSession] = useState<Session | null | undefined>();
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [supabase]);
  if (session === undefined) return <main className="full-screen-loader"><Brand /><Spinner text="Preparando operaciones…" /></main>;
  if (!session) return <Login supabase={supabase} />;
  return <Workspace supabase={supabase} session={session} />;
}

function Brand({ light = false }: { light?: boolean }) {
  return <div className={"brand-lockup" + (light ? " brand-lockup--light" : "")}><span className="brand-bean">R</span><span>Cafe OS</span></div>;
}

function Login({ supabase }: { supabase: SupabaseClient }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const result = await supabase.auth.signInWithPassword({ email: String(form.get("email") || "").trim(), password: String(form.get("password") || "") });
    if (result.error) { setError("El correo o la contraseña no coinciden."); setBusy(false); }
  }
  return <main className="login-shell">
    <section className="login-story"><Brand light /><div className="login-story__copy"><p className="eyebrow eyebrow--light">Del grano al tostado</p><h1>La operación diaria, sin ruido.</h1><p>Registra lo esencial. Cafe OS mantiene la trazabilidad y hace las cuentas de cada lote.</p></div><small>Operaciones internas · Acceso restringido</small></section>
    <section className="login-panel"><form className="login-card" onSubmit={submit}><div><p className="eyebrow">Bienvenido</p><h2>Inicia sesión</h2><p className="muted">Usa la cuenta que te proporcionó el administrador.</p></div><label>Correo electrónico<input name="email" type="email" autoComplete="email" placeholder="nombre@cafedelrio.mx" required autoFocus /></label><label>Contraseña<input name="password" type="password" autoComplete="current-password" placeholder="••••••••••••" required /></label>{error && <div className="form-error">{error}</div>}<button className="button button--primary button--wide" disabled={busy}>{busy ? "Ingresando…" : "Entrar a Cafe OS"}</button><p className="login-help">Las cuentas son creadas por un administrador. El registro público está desactivado.</p></form></section>
  </main>;
}

function Workspace({ supabase, session }: { supabase: SupabaseClient; session: Session }) {
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState<OperationsData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [entry, setEntry] = useState<EntryKind | null>(null);
  const [confirm, setConfirm] = useState<{ path: string; title: string; detail: string } | null>(null);
  const api = useMemo(() => new CafeApi(() => session.access_token), [session.access_token]);
  const load = useCallback(async () => {
    setError("");
    try {
      const [providers, purchases, lots, roasts] = await Promise.all([api.list<Provider>("providers"), api.list<Purchase>("purchases"), api.list<CoffeeLot>("green-coffee-lots"), api.list<RoastBatch>("roast-batches")]);
      setData({ providers, purchases, lots, roasts });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron cargar los datos."); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function save(kind: EntryKind, payload: Record<string, unknown>) {
    const endpoint = { provider: "providers", purchase: "purchases/with-green-coffee-lot", lot: "green-coffee-lots", roast: "roast-batches" }[kind];
    await api.create(endpoint, payload); setEntry(null);
    setNotice(kind === "purchase" ? "Compra y lote verde guardados. Revisa la compra antes de confirmarla." : kind === "roast" ? "Borrador guardado. Revísalo antes de confirmarlo." : "Registro guardado.");
    await load(); window.setTimeout(() => setNotice(""), 4000);
  }
  async function confirmRecord() {
    if (!confirm) return;
    await api.action(confirm.path); setConfirm(null); setNotice("Registro confirmado."); await load();
    window.setTimeout(() => setNotice(""), 4000);
  }
  const heading = copy[view];
  return <div className="app-shell">
    <aside className="sidebar"><Brand light /><nav>{nav.map((item) => <button key={item.view} className={"nav-item" + (view === item.view ? " nav-item--active" : "")} onClick={() => setView(item.view)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-profile"><span className="avatar">{(session.user.email?.[0] || "O").toUpperCase()}</span><span><strong>Operador</strong><small>{session.user.email}</small></span><button className="icon-button icon-button--light" aria-label="Cerrar sesión" onClick={() => void supabase.auth.signOut()}>↗</button></div></aside>
    <main className="workspace"><header className="mobile-header"><Brand /><button className="text-button" onClick={() => void supabase.auth.signOut()}>Salir</button></header><div className="workspace-inner">
      <header className="page-header"><div><p className="eyebrow">{heading[0]}</p><h1>{heading[1]}</h1><p>{heading[2]}</p></div>{view !== "dashboard" && <button className="button button--primary" onClick={() => setEntry(view === "providers" ? "provider" : view === "purchases" ? "purchase" : view === "lots" ? "lot" : "roast")}>＋ Nuevo registro</button>}</header>
      {notice && <div className="notice">{notice}</div>}{error && <div className="error-banner">{error}<button onClick={() => void load()}>Reintentar</button></div>}
      {loading ? <section className="panel panel--loading"><Spinner text="Cargando registros…" /></section> : view === "dashboard" ? <Dashboard data={data} setView={setView} setEntry={setEntry} /> : <Records view={view} data={data} onConfirm={setConfirm} />}
    </div><nav className="mobile-nav">{nav.map((item) => <button key={item.view} className={view === item.view ? "mobile-nav__active" : ""} onClick={() => setView(item.view)}><span>{item.icon}</span>{item.label}</button>)}</nav></main>
    {entry && <EntryModal kind={entry} data={data} onClose={() => setEntry(null)} onSave={save} />}
    {confirm && <ConfirmModal title={confirm.title} detail={confirm.detail} onClose={() => setConfirm(null)} onConfirm={confirmRecord} />}
  </div>;
}

function Dashboard({ data, setView, setEntry }: { data: OperationsData; setView: (view: View) => void; setEntry: (kind: EntryKind) => void }) {
  const green = data.lots.reduce((sum, item) => sum + Number(item.received_weight_kg), 0);
  const spend = data.purchases.filter((item) => item.status === "confirmed").reduce((sum, item) => sum + Number(item.total_amount || 0), 0);
  const lossValues = data.roasts.filter((item) => item.status === "confirmed").map((item) => {
    const lot = data.lots.find((candidate) => candidate.id === item.green_coffee_lot_id);
    return roastMetrics(item.green_input_kg, item.roasted_output_kg, lot?.unit_cost_per_kg || null).lossPct;
  }).filter((value): value is number => value !== null);
  const avgLoss = lossValues.length ? lossValues.reduce((a, b) => a + b, 0) / lossValues.length : null;
  const drafts = data.purchases.filter((item) => item.status === "draft").length + data.roasts.filter((item) => item.status === "draft").length;
  return <><section className="stats-grid"><Stat label="Café verde registrado" value={weight(green)} detail={data.lots.length + " lotes"} tone="green" /><Stat label="Compras confirmadas" value={money(spend)} detail="Monto acumulado" tone="clay" /><Stat label="Merma promedio" value={avgLoss === null ? "—" : avgLoss.toFixed(1) + "%"} detail={lossValues.length + " tostados"} tone="gold" /><Stat label="Por revisar" value={String(drafts)} detail="Borradores pendientes" tone="ink" /></section>
    <section className="dashboard-grid"><div className="panel"><div className="panel-heading"><p className="eyebrow">Atajos</p><h2>Registrar movimiento</h2></div><div className="quick-grid">{([["provider","P","Proveedor","Nombre y región"],["purchase","$","Compra","Proveedor, lote y peso"],["lot","L","Lote verde","Peso y costo por kg"],["roast","R","Tostado","Entrada y salida"]] as Array<[EntryKind,string,string,string]>).map((item) => <button className="quick-action" key={item[0]} onClick={() => setEntry(item[0])}><span className="quick-action__icon">{item[1]}</span><span><strong>{item[2]}</strong><small>{item[3]}</small></span><b>→</b></button>)}</div></div>
    <div className="panel"><div className="panel-heading panel-heading--row"><div><p className="eyebrow">Estado</p><h2>Flujo operativo</h2></div><button className="text-button" onClick={() => setView("purchases")}>Ver compras</button></div><div className="flow-list"><Flow n={data.providers.length} label="Proveedores" /><Flow n={data.purchases.length} label="Compras" /><Flow n={data.lots.length} label="Lotes" /><Flow n={data.roasts.length} label="Tostados" /></div></div></section></>;
}
function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <article className={"stat-card stat-card--" + tone}><span className="stat-card__dot" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>; }
function Flow({ n, label }: { n: number; label: string }) { return <div className="flow-item"><span>{label.slice(0,1)}</span><strong>{label}</strong><b>{n}</b></div>; }

function Records({ view, data, onConfirm }: { view: Exclude<View, "dashboard">; data: OperationsData; onConfirm: (value: { path: string; title: string; detail: string }) => void }) {
  const [search, setSearch] = useState("");
  const term = search.toLocaleLowerCase("es").trim();
  const provider = (id: string) => data.providers.find((item) => item.id === id)?.name || "Sin proveedor";
  const purchase = (id: string) => data.purchases.find((item) => item.id === id);
  const lot = (id: string) => data.lots.find((item) => item.id === id);
  const matches = (value: string) => value.toLocaleLowerCase("es").includes(term);
  const items = view === "providers" ? data.providers.filter((x) => matches(x.name + " " + (x.region || ""))) : view === "purchases" ? data.purchases.filter((x) => { const purchasedLot = data.lots.find((item) => item.purchase_id === x.id); return matches(provider(x.provider_id) + " " + x.status + " " + (purchasedLot?.name || "") + " " + (purchasedLot?.origin || "") + " " + (purchasedLot?.variety || "")); }) : view === "lots" ? data.lots.filter((x) => matches((x.name || "") + " " + (x.origin || ""))) : data.roasts.filter((x) => matches((x.name || "") + " " + (lot(x.green_coffee_lot_id)?.name || "") + " " + x.status));
  return <section className="panel records-panel"><div className="records-toolbar"><label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar registros…" /></label><span>{items.length} registros</span></div>{items.length === 0 ? <Empty /> :
    view === "providers" ? <div className="record-list"><Head labels={["Proveedor","Región","Compras","Alta"]} className="provider-row" />{(items as Provider[]).map((x) => <div className="record-row provider-row" key={x.id}><Primary title={x.name} detail={"#" + short(x.id)} initials={x.name.slice(0,2)} /><span data-label="Región">{x.region || "—"}</span><span data-label="Compras">{data.purchases.filter((p) => p.provider_id === x.id).length}</span><span data-label="Alta">{showDate(x.created_at)}</span></div>)}</div> :
    view === "purchases" ? <div className="record-list"><Head labels={["Proveedor","Café comprado","Peso","Monto","Estado",""]} className="purchase-row" />{(items as Purchase[]).map((x) => { const purchasedLot = data.lots.find((item) => item.purchase_id === x.id); return <div className="record-row purchase-row" key={x.id}><Primary title={provider(x.provider_id)} detail={showDate(x.purchased_at) + " · Compra #" + short(x.id)} /><span data-label="Café">{purchasedLot ? [purchasedLot.variety,purchasedLot.origin].filter(Boolean).join(" · ") || purchasedLot.name || "Lote verde" : "Sin lote ligado"}</span><strong data-label="Peso">{purchasedLot ? weight(purchasedLot.received_weight_kg) : "—"}</strong><strong data-label="Monto">{money(x.total_amount, x.currency)}</strong><span data-label="Estado"><Status value={x.status} /></span><span>{x.status === "draft" && <button className="button button--small" onClick={() => onConfirm({ path: "purchases/" + x.id + "/confirm", title: "Confirmar compra", detail: provider(x.provider_id) + " · " + (purchasedLot ? weight(purchasedLot.received_weight_kg) + " de " + (purchasedLot.variety || "café verde") + " · " : "") + money(x.total_amount, x.currency) })}>Revisar</button>}</span></div>; })}</div> :
    view === "lots" ? <div className="record-list"><Head labels={["Lote","Proveedor","Peso recibido","Costo verde","Valor base"]} className="lot-row" />{(items as CoffeeLot[]).map((x) => { const parent = purchase(x.purchase_id); return <div className="record-row lot-row" key={x.id}><Primary title={x.name || "Lote #" + short(x.id)} detail={[x.origin,x.variety].filter(Boolean).join(" · ") || "Sin detalles"} /><span data-label="Proveedor">{parent ? provider(parent.provider_id) : "—"}</span><strong data-label="Peso">{weight(x.received_weight_kg)}</strong><span data-label="Costo">{money(x.unit_cost_per_kg)}/kg</span><span data-label="Valor">{money(lotValue(x.received_weight_kg,x.unit_cost_per_kg))}</span></div>; })}</div> :
    <div className="record-list"><Head labels={["Tostado","Entrada → salida","Merma","Costo base","Estado",""]} className="roast-row" />{(items as RoastBatch[]).map((x) => { const parent = lot(x.green_coffee_lot_id); const m = roastMetrics(x.green_input_kg,x.roasted_output_kg,parent?.unit_cost_per_kg || null); return <div className="record-row roast-row" key={x.id}><Primary title={x.name || parent?.name || "Tostado #" + short(x.id)} detail={showDate(x.roasted_at,true)} /><span data-label="Pesos">{weight(x.green_input_kg)} → {weight(x.roasted_output_kg)}</span><strong data-label="Merma">{m.lossPct === null ? "—" : m.lossPct.toFixed(1) + "%"}</strong><span data-label="Costo">{m.roastedCostPerKg === null ? "—" : money(m.roastedCostPerKg) + "/kg"}</span><span data-label="Estado"><Status value={x.status} /></span><span>{x.status === "draft" && <button className="button button--small" onClick={() => onConfirm({ path: "roast-batches/" + x.id + "/confirm", title: "Confirmar tostado", detail: (parent?.name || "Lote") + " · " + weight(x.green_input_kg) + " → " + weight(x.roasted_output_kg) })}>Revisar</button>}</span></div>; })}</div>}
  </section>;
}
function Head({ labels, className }: { labels: string[]; className: string }) { return <div className={"record-row record-row--head " + className}>{labels.map((label,index) => <span key={label + index}>{label}</span>)}</div>; }
function Primary({ title, detail, initials }: { title: string; detail: string; initials?: string }) { return <span className="primary-cell">{initials && <span className="record-avatar">{initials.toUpperCase()}</span>}<span><strong>{title}</strong><small>{detail}</small></span></span>; }
function Empty() { return <div className="empty-state"><span>○</span><h3>No hay registros</h3><p>Agrega el primero o cambia tu búsqueda.</p></div>; }

function EntryModal({ kind, data, onClose, onSave }: { kind: EntryKind; data: OperationsData; onClose: () => void; onSave: (kind: EntryKind, payload: Record<string, unknown>) => Promise<void> }) {
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const title = { provider: "Nuevo proveedor", purchase: "Nueva compra", lot: "Nuevo lote verde", roast: "Nuevo tostado" }[kind];
  const unavailable = kind === "purchase" && !data.providers.length || kind === "lot" && !data.purchases.length || kind === "roast" && !data.lots.length;
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const raw = Object.fromEntries(new FormData(event.currentTarget).entries()); let value: Record<string, unknown>;
    if (kind === "provider") value = { name: String(raw.name).trim(), ...(raw.region ? { region: String(raw.region).trim() } : {}) };
    else if (kind === "purchase") value = { provider_id: raw.provider_id, purchased_at: raw.purchased_at, total_amount: raw.total_amount, currency: "MXN", ...(raw.payment_method ? { payment_method: raw.payment_method } : {}), green_coffee_lot: { ...(raw.lot_name ? { name: String(raw.lot_name).trim() } : {}), ...(raw.origin ? { origin: String(raw.origin).trim() } : {}), variety: String(raw.variety).trim(), received_weight_kg: raw.received_weight_kg } };
    else if (kind === "lot") value = { purchase_id: raw.purchase_id, ...(raw.name ? { name: String(raw.name).trim() } : {}), ...(raw.origin ? { origin: raw.origin } : {}), ...(raw.variety ? { variety: raw.variety } : {}), received_weight_kg: raw.received_weight_kg, unit_cost_per_kg: raw.unit_cost_per_kg };
    else { if (Number(raw.roasted_output_kg) > Number(raw.green_input_kg)) { setError("La salida tostada no puede superar la entrada verde."); return; } value = { green_coffee_lot_id: raw.green_coffee_lot_id, roasted_at: new Date(String(raw.roasted_at)).toISOString(), green_input_kg: raw.green_input_kg, roasted_output_kg: raw.roasted_output_kg, ...(raw.duration_minutes ? { duration_seconds: Math.round(Number(raw.duration_minutes) * 60) } : {}) }; }
    setProposal(value);
  }
  async function save() { if (!proposal) return; setBusy(true); setError(""); try { await onSave(kind,proposal); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar."); setBusy(false); } }
  return <Modal onClose={onClose} title={title} eyebrow={proposal ? "Revisa antes de guardar" : "Captura esencial"}>{unavailable ? <div className="modal-empty"><b>!</b><h3>Falta un registro anterior</h3><p>Agrega primero el registro del que depende este movimiento.</p><button className="button" onClick={onClose}>Entendido</button></div> : proposal ? <Proposal kind={kind} value={proposal} data={data} busy={busy} error={error} onBack={() => setProposal(null)} onSave={save} /> : <form className="entry-form" onSubmit={prepare}><Fields kind={kind} data={data} />{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">Revisar registro →</button></footer></form>}</Modal>;
}

function Fields({ kind, data }: { kind: EntryKind; data: OperationsData }) {
  const knownVarieties = [...new Set(data.lots.map((lot) => lot.variety).filter((value): value is string => Boolean(value)))].sort();
  const knownOrigins = [...new Set(data.lots.map((lot) => lot.origin).filter((value): value is string => Boolean(value)))].sort();
  if (kind === "provider") return <div className="form-grid"><Field label="Nombre del proveedor" full><input name="name" placeholder="Ej. Finca La Esperanza" required autoFocus /></Field><Field label="Región" optional full><input name="region" placeholder="Ej. Coatepec, Veracruz" /></Field></div>;
  if (kind === "purchase") return <div className="form-grid">
    <Field label="Proveedor" full><select name="provider_id" required defaultValue="" autoFocus><option value="" disabled>Selecciona un proveedor</option>{data.providers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.region ? " · " + x.region : ""}</option>)}</select></Field>
    <Field label="Fecha de compra"><input name="purchased_at" type="date" defaultValue={new Date().toISOString().slice(0,10)} required /></Field>
    <Field label="Total pagado" unit="MXN"><input name="total_amount" type="number" min="0" step="0.01" placeholder="0.00" required /></Field>
    <div className="form-section field--full"><span>Lote de café verde comprado</span><small>Se creará y ligará a esta compra.</small></div>
    <Field label="Peso comprado" unit="kg"><input name="received_weight_kg" type="number" min="0.001" step="0.001" placeholder="0.000" required /></Field>
    <Field label="Variedad"><input name="variety" list="purchase-varieties" placeholder="Ej. bourbon" required /><datalist id="purchase-varieties">{knownVarieties.map((variety) => <option key={variety} value={variety} />)}</datalist></Field>
    <Field label="Origen" optional><input name="origin" list="purchase-origins" placeholder="Ej. Chiapas" /><datalist id="purchase-origins">{knownOrigins.map((origin) => <option key={origin} value={origin} />)}</datalist></Field>
    <Field label="Nombre o referencia del lote" optional><input name="lot_name" placeholder="Ej. Cosecha 2026 · Lote 04" /></Field>
    <Field label="Forma de pago" optional full><select name="payment_method" defaultValue=""><option value="">Sin especificar</option><option value="transferencia">Transferencia</option><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option></select></Field>
    <p className="form-note field--full">La compra se guardará como borrador. El costo verde por kg se calculará con el total pagado y el peso recibido.</p>
  </div>;
  if (kind === "lot") return <div className="form-grid"><Field label="Compra de origen" full><select name="purchase_id" required defaultValue="" autoFocus><option value="" disabled>Selecciona una compra</option>{data.purchases.filter((x) => x.status !== "void").map((x) => <option key={x.id} value={x.id}>{data.providers.find((p) => p.id === x.provider_id)?.name || "Proveedor"} · {showDate(x.purchased_at)} · {money(x.total_amount,x.currency)}</option>)}</select></Field><Field label="Nombre del lote" optional full><input name="name" placeholder="Ej. Cosecha 2026 · Lote 04" /></Field><Field label="Peso recibido" unit="kg"><input name="received_weight_kg" type="number" min="0.001" step="0.001" required /></Field><Field label="Costo café verde" unit="MXN/kg"><input name="unit_cost_per_kg" type="number" min="0" step="0.0001" required /></Field><Field label="Origen" optional><input name="origin" placeholder="Ej. Chiapas" /></Field><Field label="Variedad" optional><input name="variety" placeholder="Ej. Bourbon" /></Field></div>;
  return <div className="form-grid"><Field label="Lote de café verde" full><select name="green_coffee_lot_id" required defaultValue="" autoFocus><option value="" disabled>Selecciona un lote</option>{data.lots.map((x) => <option key={x.id} value={x.id}>{x.name || "Lote #" + short(x.id)} · {weight(x.received_weight_kg)} · {money(x.unit_cost_per_kg)}/kg</option>)}</select></Field><Field label="Fecha y hora" full><input name="roasted_at" type="datetime-local" defaultValue={localNow()} required /></Field><Field label="Entrada verde" unit="kg"><input name="green_input_kg" type="number" min="0.001" step="0.001" required /></Field><Field label="Salida tostada" unit="kg"><input name="roasted_output_kg" type="number" min="0.001" step="0.001" required /></Field><Field label="Duración" unit="min" optional full><input name="duration_minutes" type="number" min="0" step="0.1" /></Field><p className="form-note field--full">Calcularemos merma, rendimiento y costo base. Se guardará como borrador.</p></div>;
}
function Field({ label, unit, optional, full, children }: { label: string; unit?: string; optional?: boolean; full?: boolean; children: ReactNode }) { return <label className={full ? "field--full" : ""}>{label}{unit && <span className="unit">{unit}</span>}{optional && <span className="optional">Opcional</span>}{children}</label>; }

function Proposal({ kind, value, data, busy, error, onBack, onSave }: { kind: EntryKind; value: Record<string, unknown>; data: OperationsData; busy: boolean; error: string; onBack: () => void; onSave: () => void }) {
  const rows: Array<[string,ReactNode]> = []; let calc: ReactNode = null;
  if (kind === "provider") rows.push(["Nombre",String(value.name)],["Región",value.region ? String(value.region) : "Sin especificar"]);
  else if (kind === "purchase") { const purchasedLot = value.green_coffee_lot as Record<string, unknown>; const unitCost = Number(value.total_amount) / Number(purchasedLot.received_weight_kg); rows.push(["Proveedor",data.providers.find((x) => x.id === value.provider_id)?.name || "—"],["Fecha",showDate(String(value.purchased_at))],["Total",money(value.total_amount)],["Peso comprado",weight(purchasedLot.received_weight_kg)],["Variedad",String(purchasedLot.variety)],["Origen",purchasedLot.origin ? String(purchasedLot.origin) : "Sin especificar"],["Lote",purchasedLot.name ? String(purchasedLot.name) : "Sin referencia"],["Estado",<Status value="draft" />]); calc = <Calc label="Costo de café verde" value={money(unitCost) + "/kg"} formula={money(value.total_amount) + " ÷ " + weight(purchasedLot.received_weight_kg)} />; }
  else if (kind === "lot") { const parent = data.purchases.find((x) => x.id === value.purchase_id); rows.push(["Proveedor",data.providers.find((x) => x.id === parent?.provider_id)?.name || "—"],["Nombre",value.name ? String(value.name) : "Sin nombre"],["Peso",weight(value.received_weight_kg)],["Costo verde",money(value.unit_cost_per_kg) + "/kg"],["Origen",value.origin ? String(value.origin) : "Sin especificar"],["Variedad",value.variety ? String(value.variety) : "Sin especificar"]); calc = <Calc label="Valor base del lote" value={money(lotValue(String(value.received_weight_kg),String(value.unit_cost_per_kg)))} formula={weight(value.received_weight_kg) + " × " + money(value.unit_cost_per_kg) + "/kg"} />; }
  else { const parent = data.lots.find((x) => x.id === value.green_coffee_lot_id); const m = roastMetrics(String(value.green_input_kg),String(value.roasted_output_kg),parent?.unit_cost_per_kg || null); rows.push(["Lote",parent?.name || "Lote #" + short(String(value.green_coffee_lot_id))],["Fecha",showDate(String(value.roasted_at),true)],["Entrada",weight(value.green_input_kg)],["Salida",weight(value.roasted_output_kg)],["Estado",<Status value="draft" />]); calc = <div className="calculation-grid"><Calc label="Merma" value={m.lossPct === null ? "—" : m.lossPct.toFixed(2) + "%"} formula="(entrada − salida) ÷ entrada × 100" /><Calc label="Rendimiento" value={m.yieldPct === null ? "—" : m.yieldPct.toFixed(2) + "%"} formula="salida ÷ entrada × 100" /><Calc label="Costo base tostado" value={m.roastedCostPerKg === null ? "—" : money(m.roastedCostPerKg) + "/kg"} formula="(entrada × costo verde) ÷ salida" /></div>; }
  return <div className="proposal"><div className="proposal-list">{rows.map((row) => <div key={row[0]}><span>{row[0]}</span><strong>{row[1]}</strong></div>)}</div>{calc}{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button className="button button--ghost" onClick={onBack} disabled={busy}>← Corregir</button><button className="button button--primary" onClick={onSave} disabled={busy}>{busy ? "Guardando…" : kind === "purchase" || kind === "roast" ? "Guardar borrador" : "Guardar registro"}</button></footer></div>;
}
function Calc({ label, value, formula }: { label: string; value: string; formula: string }) { return <div className="calculation"><span>{label}</span><strong>{value}</strong><small>{formula}</small></div>; }

function Modal({ onClose, title, eyebrow, children, small = false }: { onClose: () => void; title: string; eyebrow: string; children: ReactNode; small?: boolean }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className={"modal" + (small ? " modal--small" : "")} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><header className="modal-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>; }
function ConfirmModal({ title, detail, onClose, onConfirm }: { title: string; detail: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  async function run() { setBusy(true); setError(""); try { await onConfirm(); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo confirmar."); setBusy(false); } }
  return <Modal onClose={onClose} title={title} eyebrow="Cambio de estado" small><div className="confirm-body"><p>Confirma que estos datos ya fueron revisados:</p><strong>{detail}</strong><p className="form-note">El estado cambiará de borrador a confirmado.</p>{error && <div className="form-error">{error}</div>}</div><footer className="modal-actions"><button className="button button--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="button button--primary" onClick={() => void run()} disabled={busy}>{busy ? "Confirmando…" : "Sí, confirmar"}</button></footer></Modal>;
}
