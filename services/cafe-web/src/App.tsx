import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { CafeApi } from "./api";
import { greenCoffeeInventory, roastMetrics, weightedGreenUnitCost } from "./calculations";
import type { CoffeeLot, EntryKind, OperationsData, Provider, Purchase, RoastBatch, View } from "./types";

const emptyData: OperationsData = { providers: [], purchases: [], lots: [], roasts: [] };
const roastDraftStorageKey = "cafe-os:roast-draft:v1";
type RoastCheckpoint = RoastBatch["checkpoints"][number];
type RoastDraft = {
  lotId: string;
  roastDate: string;
  greenInputGrams: string;
  roastedOutputGrams: string;
  chargeTemperatureC: string;
  balancePointTemperatureC: string;
  setupNotes: string;
  tastingNotes: string;
  rating: number;
  checkpoints: RoastCheckpoint[];
  timer: { elapsedSeconds: number; runningSince: number | null; startedAtIso: string | null };
};

function todayLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function emptyRoastDraft(): RoastDraft {
  return {
    lotId: "",
    roastDate: todayLocal(),
    greenInputGrams: "",
    roastedOutputGrams: "",
    chargeTemperatureC: "",
    balancePointTemperatureC: "",
    setupNotes: "",
    tastingNotes: "",
    rating: 0,
    checkpoints: [],
    timer: { elapsedSeconds: 0, runningSince: null, startedAtIso: null },
  };
}
function loadRoastDraft(storageKey: string): RoastDraft {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return emptyRoastDraft();
    const parsed = JSON.parse(stored) as Partial<RoastDraft>;
    const fallback = emptyRoastDraft();
    return {
      ...fallback,
      ...parsed,
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
      timer: { ...fallback.timer, ...(parsed.timer || {}) },
    };
  } catch {
    return emptyRoastDraft();
  }
}
function elapsedAt(draft: RoastDraft, now = Date.now()) {
  return Math.max(0, Math.round(
    draft.timer.elapsedSeconds +
    (draft.timer.runningSince === null ? 0 : (now - draft.timer.runningSince) / 1000),
  ));
}
function formatElapsed(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}
function parseElapsed(value: string) {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0) || numbers.at(-1)! > 59 || (parts.length === 3 && numbers[1] > 59)) return null;
  return parts.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}
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
  lots: ["Inventario", "Lotes de café verde", "Identidades de café reutilizables, compras asociadas y costo promedio."],
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
function localDateTime(value: string | null) {
  if (!value) return localNow();
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function isoFromLocalDateTime(value: unknown) {
  return value ? new Date(String(value)).toISOString() : null;
}
function short(id: string) { return id.slice(0, 8).toUpperCase(); }
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
  const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null);
  const [editingRoast, setEditingRoast] = useState<RoastBatch | null>(null);
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
    setNotice(kind === "purchase" ? "Compra guardada." : kind === "roast" ? "Tostado guardado e inventario actualizado." : "Registro guardado.");
    await load(); window.setTimeout(() => setNotice(""), 4000);
  }
  async function savePurchaseEdit(payload: Record<string, unknown>) {
    if (!editingPurchase) return;
    await api.update(`purchases/${editingPurchase.id}`, payload, "PATCH");
    setEditingPurchase(null); setNotice("Compra actualizada."); await load();
    window.setTimeout(() => setNotice(""), 4000);
  }
  async function saveRoastEdit(payload: Record<string, unknown>) {
    if (!editingRoast) return;
    await api.update(`roast-batches/${editingRoast.id}`, payload, "PATCH");
    setEditingRoast(null); setNotice("Tostado actualizado e inventario recalculado."); await load();
    window.setTimeout(() => setNotice(""), 4000);
  }
  function beginEntry(kind: EntryKind) {
    if (kind === "roast") {
      setView("roasts");
      setEntry(null);
      return;
    }
    setEntry(kind);
  }
  const heading = copy[view];
  return <div className="app-shell">
    <aside className="sidebar"><Brand light /><nav>{nav.map((item) => <button key={item.view} className={"nav-item" + (view === item.view ? " nav-item--active" : "")} onClick={() => setView(item.view)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-profile"><span className="avatar">{(session.user.email?.[0] || "O").toUpperCase()}</span><span><strong>Operador</strong><small>{session.user.email}</small></span><button className="icon-button icon-button--light" aria-label="Cerrar sesión" onClick={() => void supabase.auth.signOut()}>↗</button></div></aside>
    <main className="workspace"><header className="mobile-header"><Brand /><button className="text-button" onClick={() => void supabase.auth.signOut()}>Salir</button></header><div className="workspace-inner">
      <header className="page-header"><div><p className="eyebrow">{heading[0]}</p><h1>{heading[1]}</h1><p>{heading[2]}</p></div>{view !== "dashboard" && view !== "roasts" && <button className="button button--primary" onClick={() => beginEntry(view === "providers" ? "provider" : view === "purchases" ? "purchase" : "lot")}>＋ Nuevo registro</button>}</header>
      {notice && <div className="notice">{notice}</div>}{error && <div className="error-banner">{error}<button onClick={() => void load()}>Reintentar</button></div>}
      {loading ? <section className="panel panel--loading"><Spinner text="Cargando registros…" /></section> : view === "dashboard" ? <Dashboard data={data} setView={setView} setEntry={beginEntry} /> : view === "roasts" ? <RoastWorkspace data={data} storageKey={`${roastDraftStorageKey}:${session.user.id}`} onSave={(payload) => save("roast", payload)} onEditRoast={setEditingRoast} /> : <Records view={view} data={data} onEditPurchase={setEditingPurchase} onEditRoast={setEditingRoast} />}
    </div><nav className="mobile-nav">{nav.map((item) => <button key={item.view} className={view === item.view ? "mobile-nav__active" : ""} onClick={() => setView(item.view)}><span>{item.icon}</span>{item.label}</button>)}</nav></main>
    {entry && <EntryModal kind={entry} data={data} onClose={() => setEntry(null)} onSave={save} />}
    {editingPurchase && <EditPurchaseModal purchase={editingPurchase} data={data} onClose={() => setEditingPurchase(null)} onSave={savePurchaseEdit} />}
    {editingRoast && <EditRoastModal roast={editingRoast} data={data} onClose={() => setEditingRoast(null)} onSave={saveRoastEdit} />}
  </div>;
}

function Dashboard({ data, setView, setEntry }: { data: OperationsData; setView: (view: View) => void; setEntry: (kind: EntryKind) => void }) {
  const green = data.lots.reduce((sum, lot) => sum + greenCoffeeInventory(lot.id, data.purchases, data.roasts).availableKg, 0);
  const spend = data.purchases.reduce((sum, item) => sum + Number(item.total_amount || 0), 0);
  const lossValues = data.roasts.filter((item) => !item.voided_at).map((item) => {
    const lotPurchases = data.purchases.filter((purchase) => purchase.green_coffee_lot_id === item.green_coffee_lot_id);
    return roastMetrics(item.green_input_kg, item.roasted_output_kg, weightedGreenUnitCost(lotPurchases)).lossPct;
  }).filter((value): value is number => value !== null);
  const avgLoss = lossValues.length ? lossValues.reduce((a, b) => a + b, 0) / lossValues.length : null;
  return <><section className="stats-grid"><Stat label="Café verde disponible" value={weight(green)} detail={data.lots.length + " lotes"} tone="green" /><Stat label="Compras" value={money(spend)} detail="Monto acumulado" tone="clay" /><Stat label="Merma promedio" value={avgLoss === null ? "—" : avgLoss.toFixed(1) + "%"} detail={lossValues.length + " tostados con pesos"} tone="gold" /><Stat label="Tostados" value={String(data.roasts.filter((item) => !item.voided_at).length)} detail="Registros activos" tone="ink" /></section>
    <section className="dashboard-grid"><div className="panel"><div className="panel-heading"><p className="eyebrow">Atajos</p><h2>Registrar movimiento</h2></div><div className="quick-grid">{([["provider","P","Proveedor","Nombre y región"],["purchase","$","Compra","Proveedor, lote y peso"],["lot","L","Lote verde","Identidad, origen y variedad"],["roast","R","Tostado","Entrada y salida"]] as Array<[EntryKind,string,string,string]>).map((item) => <button className="quick-action" key={item[0]} onClick={() => setEntry(item[0])}><span className="quick-action__icon">{item[1]}</span><span><strong>{item[2]}</strong><small>{item[3]}</small></span><b>→</b></button>)}</div></div>
    <div className="panel"><div className="panel-heading panel-heading--row"><div><p className="eyebrow">Estado</p><h2>Flujo operativo</h2></div><button className="text-button" onClick={() => setView("purchases")}>Ver compras</button></div><div className="flow-list"><Flow n={data.providers.length} label="Proveedores" /><Flow n={data.purchases.length} label="Compras" /><Flow n={data.lots.length} label="Lotes" /><Flow n={data.roasts.length} label="Tostados" /></div></div></section></>;
}
function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <article className={"stat-card stat-card--" + tone}><span className="stat-card__dot" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>; }
function Flow({ n, label }: { n: number; label: string }) { return <div className="flow-item"><span>{label.slice(0,1)}</span><strong>{label}</strong><b>{n}</b></div>; }

function RoastWorkspace({ data, storageKey, onSave, onEditRoast }: { data: OperationsData; storageKey: string; onSave: (payload: Record<string, unknown>) => Promise<void>; onEditRoast: (roast: RoastBatch) => void }) {
  const [tab, setTab] = useState<"new" | "history" | "panel">("new");
  return <section className="roast-workspace">
    <nav className="roast-tabs" aria-label="Vistas de tostado">
      <button className={tab === "new" ? "roast-tab--active" : ""} onClick={() => setTab("new")}>Nuevo tostado</button>
      <button className={tab === "history" ? "roast-tab--active" : ""} onClick={() => setTab("history")}>Historial</button>
      <button className={tab === "panel" ? "roast-tab--active" : ""} onClick={() => setTab("panel")}>Panel</button>
    </nav>
    {tab === "new" ? <NewRoastForm data={data} storageKey={storageKey} onSave={async (payload) => { await onSave(payload); setTab("history"); }} /> : tab === "history" ? <Records view="roasts" data={data} onEditPurchase={() => undefined} onEditRoast={onEditRoast} /> : <RoastPanel data={data} />}
  </section>;
}

function RoastPanel({ data }: { data: OperationsData }) {
  const active = data.roasts.filter((roast) => !roast.voided_at);
  const rated = active.filter((roast) => roast.sensory_rating !== null);
  const withCheckpoints = active.filter((roast) => roast.checkpoints.length > 0);
  const averageRating = rated.length ? rated.reduce((sum, roast) => sum + Number(roast.sensory_rating), 0) / rated.length : null;
  return <section className="roast-panel-grid">
    <Stat label="Tostados registrados" value={String(active.length)} detail={`${withCheckpoints.length} con puntos de control`} tone="ink" />
    <Stat label="Calificación promedio" value={averageRating === null ? "—" : `${averageRating.toFixed(1)} / 5`} detail={`${rated.length} tostados calificados`} tone="gold" />
    <article className="panel roast-panel-note"><p className="eyebrow">Siguiente iteración</p><h2>Curvas por tostado</h2><p>Los puntos de temperatura, tiro y gas ya quedan estructurados para construir las curvas comparativas del panel.</p></article>
  </section>;
}

function NewRoastForm({ data, storageKey, onSave }: { data: OperationsData; storageKey: string; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [draft, setDraft] = useState<RoastDraft>(() => loadRoastDraft(storageKey));
  const [clockNow, setClockNow] = useState(Date.now());
  const [checkpoint, setCheckpoint] = useState({ time: "", temperature: "", airflow: "", gas: "", note: "" });
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const elapsedSeconds = elapsedAt(draft, clockNow);
  const inventory = draft.lotId ? greenCoffeeInventory(draft.lotId, data.purchases, data.roasts) : null;
  const selectedLot = data.lots.find((lot) => lot.id === draft.lotId);
  const timerEnabled = Boolean(selectedLot);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, storageKey]);
  useEffect(() => {
    if (draft.timer.runningSince === null) return;
    const interval = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [draft.timer.runningSince]);
  useEffect(() => {
    if (selectedLot || draft.timer.runningSince === null) return;
    const now = Date.now();
    setClockNow(now);
    setDraft((current) => ({
      ...current,
      timer: { ...current.timer, elapsedSeconds: elapsedAt(current, now), runningSince: null },
    }));
  }, [selectedLot, draft.timer.runningSince]);

  function update<K extends keyof RoastDraft>(key: K, value: RoastDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  function startTimer() {
    if (!selectedLot) return;
    const now = Date.now();
    setClockNow(now);
    setDraft((current) => current.timer.runningSince !== null ? current : {
      ...current,
      timer: {
        ...current.timer,
        runningSince: now,
        startedAtIso: current.timer.startedAtIso || new Date(now).toISOString(),
      },
    });
  }
  function pauseTimer() {
    if (!selectedLot) return;
    const now = Date.now();
    setClockNow(now);
    setDraft((current) => ({
      ...current,
      timer: { ...current.timer, elapsedSeconds: elapsedAt(current, now), runningSince: null },
    }));
  }
  function resetTimer() {
    if (!selectedLot) return;
    setClockNow(Date.now());
    setDraft((current) => ({
      ...current,
      timer: { elapsedSeconds: 0, runningSince: null, startedAtIso: null },
    }));
  }
  function addCheckpoint() {
    setError("");
    const checkpointSeconds = checkpoint.time.trim() ? parseElapsed(checkpoint.time) : elapsedSeconds;
    if (checkpointSeconds === null) {
      setError("El tiempo debe escribirse como MM:SS o HH:MM:SS.");
      return;
    }
    if (![checkpoint.temperature, checkpoint.airflow, checkpoint.gas, checkpoint.note].some((value) => value.trim())) {
      setError("Agrega al menos temperatura, tiro, gas o una nota para el punto de control.");
      return;
    }
    const next: RoastCheckpoint = {
      elapsed_seconds: checkpointSeconds,
      ...(checkpoint.temperature ? { temperature_c: checkpoint.temperature } : {}),
      ...(checkpoint.airflow ? { airflow_setting: checkpoint.airflow } : {}),
      ...(checkpoint.gas ? { gas_setting: checkpoint.gas } : {}),
      ...(checkpoint.note.trim() ? { note: checkpoint.note.trim() } : {}),
    };
    setDraft((current) => ({
      ...current,
      checkpoints: [...current.checkpoints, next].sort((left, right) => left.elapsed_seconds - right.elapsed_seconds),
    }));
    setCheckpoint({ time: "", temperature: "", airflow: "", gas: "", note: "" });
  }
  function clearForm() {
    const cleared = emptyRoastDraft();
    window.localStorage.removeItem(storageKey);
    setDraft(cleared);
    setCheckpoint({ time: "", temperature: "", airflow: "", gas: "", note: "" });
    setError("");
    setClockNow(Date.now());
  }
  function prepareSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!draft.lotId || !selectedLot) {
      setError("Selecciona el lote de café verde.");
      return;
    }
    const saveNow = Date.now();
    const savedElapsedSeconds = elapsedAt(draft, saveNow);
    const greenInputKg = draft.greenInputGrams ? Number(draft.greenInputGrams) / 1000 : null;
    const roastedOutputKg = draft.roastedOutputGrams ? Number(draft.roastedOutputGrams) / 1000 : null;
    if (greenInputKg !== null && inventory && greenInputKg > inventory.availableKg + 1e-9) {
      setError(`Solo hay ${weight(inventory.availableKg)} disponibles para este lote.`);
      return;
    }
    if (greenInputKg !== null && roastedOutputKg !== null && roastedOutputKg > greenInputKg) {
      setError("El peso final no puede superar la carga verde.");
      return;
    }
    if (draft.timer.runningSince !== null) {
      setClockNow(saveNow);
      setDraft((current) => ({
        ...current,
        timer: { ...current.timer, elapsedSeconds: elapsedAt(current, saveNow), runningSince: null },
      }));
    }
    setPending({
      green_coffee_lot_id: draft.lotId,
      ...(draft.roastDate ? { roast_date: draft.roastDate } : {}),
      ...(draft.timer.startedAtIso ? { roasted_at: draft.timer.startedAtIso } : {}),
      ...(greenInputKg !== null ? { green_input_kg: greenInputKg } : {}),
      ...(roastedOutputKg !== null ? { roasted_output_kg: roastedOutputKg } : {}),
      ...(savedElapsedSeconds > 0 ? { duration_seconds: savedElapsedSeconds } : {}),
      ...(draft.chargeTemperatureC ? { charge_temperature_c: draft.chargeTemperatureC } : {}),
      ...(draft.balancePointTemperatureC ? { balance_point_temperature_c: draft.balancePointTemperatureC } : {}),
      ...(draft.setupNotes.trim() ? { setup_notes: draft.setupNotes.trim() } : {}),
      checkpoints: draft.checkpoints,
      ...(draft.rating > 0 ? { sensory_rating: draft.rating } : {}),
      ...(draft.tastingNotes.trim() ? { tasting_notes: draft.tastingNotes.trim() } : {}),
    });
  }
  async function confirmSave() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await onSave(pending);
      clearForm();
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar el tostado.");
      setBusy(false);
    }
  }

  if (!data.lots.length) return <section className="panel modal-empty"><b>!</b><h3>Primero registra café verde</h3><p>Necesitas al menos un lote con inventario antes de iniciar un tostado.</p></section>;

  return <>
    <form className="panel roast-log" onSubmit={prepareSave}>
      <section className="roast-log-section">
        <div className="roast-section-title"><div><p className="eyebrow">Preparación</p><h2>Configuración del tostado</h2></div><small>El borrador se conserva en este dispositivo.</small></div>
        <div className="roast-config-grid">
          <Field label="Grano / origen" full><select required value={draft.lotId} onChange={(event) => update("lotId", event.target.value)} autoFocus><option value="" disabled>Selecciona un lote</option>{data.lots.map((lot) => <option key={lot.id} value={lot.id}>{[lot.name, lot.variety, lot.origin].filter(Boolean).join(" · ")}</option>)}</select></Field>
          <Field label="Fecha"><input type="date" value={draft.roastDate} onChange={(event) => update("roastDate", event.target.value)} /></Field>
          <Field label="Carga" unit="g" optional><input type="number" min="1" step="1" value={draft.greenInputGrams} onChange={(event) => update("greenInputGrams", event.target.value)} placeholder="120" /></Field>
          <Field label="Temp. de carga" unit="°C" optional><input type="number" min="0" step="0.1" value={draft.chargeTemperatureC} onChange={(event) => update("chargeTemperatureC", event.target.value)} placeholder="180" /></Field>
          <Field label="Punto de equilibrio" unit="°C" optional><input type="number" min="0" step="0.1" value={draft.balancePointTemperatureC} onChange={(event) => update("balancePointTemperatureC", event.target.value)} placeholder="Temperatura mínima" title="Temperatura mínima después de la carga, donde la curva deja de bajar y empieza a subir." /></Field>
          <Field label="Peso final" unit="g" optional><input type="number" min="1" step="1" value={draft.roastedOutputGrams} onChange={(event) => update("roastedOutputGrams", event.target.value)} placeholder="Opcional" /></Field>
          <Field label="Notas previas" optional full><input value={draft.setupNotes} onChange={(event) => update("setupNotes", event.target.value)} placeholder="Algo que valga la pena recordar antes del tostado" /></Field>
        </div>
        {inventory && <p className="inventory-note"><strong>{weight(inventory.availableKg)}</strong> disponibles para {selectedLot?.name}.</p>}
      </section>

      <section className="roast-timer" aria-live="polite">
        <div><span>Tiempo transcurrido</span><strong>{formatElapsed(elapsedSeconds)}</strong><small>{elapsedSeconds >= 3600 ? "HH:MM:SS" : "MM:SS"}</small></div>
        <div className="roast-timer-actions">
          <button type="button" className="button button--primary" onClick={startTimer} disabled={!timerEnabled || draft.timer.runningSince !== null}>{draft.timer.runningSince !== null ? "Corriendo…" : elapsedSeconds > 0 ? "Reanudar" : "Iniciar"}</button>
          <button type="button" className="button" onClick={pauseTimer} disabled={!timerEnabled || draft.timer.runningSince === null}>Pausar</button>
          <button type="button" className="button" onClick={resetTimer} disabled={!timerEnabled}>Reiniciar</button>
        </div>
      </section>
      {!timerEnabled && <p className="timer-requirement">Selecciona primero un lote de café verde para habilitar el cronómetro.</p>}

      <section className="roast-log-section">
        <div className="roast-section-title"><div><p className="eyebrow">Curva manual</p><h2>Puntos de control</h2></div><small>El tiro y el gas usan la escala de tu máquina.</small></div>
        {draft.checkpoints.length > 0 && <div className="checkpoint-table-wrap"><table className="checkpoint-table"><thead><tr><th>Tiempo</th><th>Temp. °C</th><th>Tiro</th><th>Gas</th><th>Nota</th><th /></tr></thead><tbody>{draft.checkpoints.map((point, index) => <tr key={`${point.elapsed_seconds}-${index}`}><td>{formatElapsed(point.elapsed_seconds)}</td><td>{point.temperature_c ?? "—"}</td><td>{point.airflow_setting ?? "—"}</td><td>{point.gas_setting ?? "—"}</td><td>{point.note || "—"}</td><td><button type="button" className="checkpoint-remove" aria-label={`Quitar punto ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, checkpoints: current.checkpoints.filter((_item, itemIndex) => itemIndex !== index) }))}>×</button></td></tr>)}</tbody></table></div>}
        <div className="checkpoint-entry" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCheckpoint(); } }}>
          <Field label="Tiempo"><input value={checkpoint.time} onChange={(event) => setCheckpoint((current) => ({ ...current, time: event.target.value }))} placeholder={formatElapsed(elapsedSeconds)} inputMode="numeric" /></Field>
          <Field label="Temp." unit="°C"><input type="number" step="0.1" value={checkpoint.temperature} onChange={(event) => setCheckpoint((current) => ({ ...current, temperature: event.target.value }))} /></Field>
          <Field label="Tiro"><input type="number" step="0.5" value={checkpoint.airflow} onChange={(event) => setCheckpoint((current) => ({ ...current, airflow: event.target.value }))} /></Field>
          <Field label="Gas"><input type="number" step="0.5" value={checkpoint.gas} onChange={(event) => setCheckpoint((current) => ({ ...current, gas: event.target.value }))} /></Field>
          <Field label="Nota"><input value={checkpoint.note} onChange={(event) => setCheckpoint((current) => ({ ...current, note: event.target.value }))} placeholder="Ej. primer crack" /></Field>
          <button type="button" className="button checkpoint-add" onClick={addCheckpoint}>＋ Agregar</button>
        </div>
      </section>

      <section className="roast-log-section roast-cupping">
        <div className="roast-section-title"><div><p className="eyebrow">Después de la taza</p><h2>Evaluación</h2></div><small>Complétalo después de catarlo o déjalo para después.</small></div>
        <div className="roast-cupping-grid">
          <div><span className="field-label">Calificación <small>Opcional</small></span><div className="star-picker" aria-label="Calificación de una a cinco estrellas">{[1,2,3,4,5].map((rating) => <button key={rating} type="button" className={rating <= draft.rating ? "star-picker--selected" : ""} onClick={() => update("rating", draft.rating === rating ? 0 : rating)} aria-label={`${rating} estrellas`}>★</button>)}</div></div>
          <Field label="Notas de cata" optional><input value={draft.tastingNotes} onChange={(event) => update("tastingNotes", event.target.value)} placeholder="Brillante, achocolatado, subdesarrollado…" /></Field>
        </div>
      </section>
      {error && <div className="form-error roast-form-error">{error}</div>}
      <footer className="roast-actions"><button type="button" className="button button--ghost" onClick={clearForm}>Limpiar formulario</button><button className="button button--primary">Guardar tostado</button></footer>
    </form>
    {pending && <Modal onClose={() => !busy && setPending(null)} title="Confirmar tostado" eyebrow="Revisa antes de guardar"><div className="proposal"><div className="proposal-list">
      <div><span>Lote</span><strong>{selectedLot?.name || "—"}</strong></div>
      <div><span>Fecha</span><strong>{showDate(draft.roastDate)}</strong></div>
      <div><span>Carga verde</span><strong>{draft.greenInputGrams ? `${draft.greenInputGrams} g` : "Pendiente"}</strong></div>
      <div><span>Peso final</span><strong>{draft.roastedOutputGrams ? `${draft.roastedOutputGrams} g` : "Pendiente"}</strong></div>
      <div><span>Duración</span><strong>{pending.duration_seconds ? formatElapsed(Number(pending.duration_seconds)) : "Pendiente"}</strong></div>
      <div><span>Punto de equilibrio</span><strong>{draft.balancePointTemperatureC ? `${draft.balancePointTemperatureC} °C` : "Pendiente"}</strong></div>
      <div><span>Puntos de control</span><strong>{draft.checkpoints.length}</strong></div>
      <div><span>Calificación</span><strong>{draft.rating > 0 ? `${draft.rating} / 5` : "Pendiente"}</strong></div>
    </div>{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button className="button button--ghost" onClick={() => setPending(null)} disabled={busy}>← Corregir</button><button className="button button--primary" onClick={() => void confirmSave()} disabled={busy}>{busy ? "Guardando…" : "Confirmar y guardar"}</button></footer></div></Modal>}
  </>;
}

function Records({ view, data, onEditPurchase, onEditRoast }: { view: Exclude<View, "dashboard">; data: OperationsData; onEditPurchase: (purchase: Purchase) => void; onEditRoast: (roast: RoastBatch) => void }) {
  const [search, setSearch] = useState("");
  const term = search.toLocaleLowerCase("es").trim();
  const provider = (id: string) => data.providers.find((item) => item.id === id)?.name || "Sin proveedor";
  const lot = (id: string) => data.lots.find((item) => item.id === id);
  const lotPurchases = (id: string) => data.purchases.filter((item) => item.green_coffee_lot_id === id);
  const matches = (value: string) => value.toLocaleLowerCase("es").includes(term);
  const items = view === "providers" ? data.providers.filter((x) => matches(x.name + " " + (x.region || ""))) : view === "purchases" ? data.purchases.filter((x) => { const purchasedLot = lot(x.green_coffee_lot_id); return matches(provider(x.provider_id) + " " + (purchasedLot?.name || "") + " " + (purchasedLot?.origin || "") + " " + (purchasedLot?.variety || "")); }) : view === "lots" ? data.lots.filter((x) => matches(x.name + " " + (x.origin || "") + " " + (x.variety || ""))) : data.roasts.filter((x) => matches((x.name || "") + " " + (lot(x.green_coffee_lot_id)?.name || "") + " " + (x.completion?.is_complete ? "completo" : "incompleto") + " " + (x.voided_at ? "anulado" : "")));
  return <section className="panel records-panel"><div className="records-toolbar"><label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar registros…" /></label><span>{items.length} registros</span></div>{items.length === 0 ? <Empty /> :
    view === "providers" ? <div className="record-list"><Head labels={["Proveedor","Región","Compras","Alta"]} className="provider-row" />{(items as Provider[]).map((x) => <div className="record-row provider-row" key={x.id}><Primary title={x.name} detail={"#" + short(x.id)} initials={x.name.slice(0,2)} /><span data-label="Región">{x.region || "—"}</span><span data-label="Compras">{data.purchases.filter((p) => p.provider_id === x.id).length}</span><span data-label="Alta">{showDate(x.created_at)}</span></div>)}</div> :
    view === "purchases" ? <div className="record-list"><Head labels={["Proveedor","Café comprado","Peso","Monto",""]} className="purchase-row" />{(items as Purchase[]).map((x) => { const purchasedLot = lot(x.green_coffee_lot_id); return <div className="record-row purchase-row" key={x.id}><Primary title={provider(x.provider_id)} detail={showDate(x.purchased_at) + " · Compra #" + short(x.id)} /><span data-label="Café">{purchasedLot ? [purchasedLot.name,purchasedLot.variety,purchasedLot.origin].filter(Boolean).join(" · ") : "Sin lote ligado"}</span><strong data-label="Peso">{weight(x.received_weight_kg)}</strong><strong data-label="Monto">{money(x.total_amount, x.currency)}</strong><span><button className="button button--small" onClick={() => onEditPurchase(x)}>Editar</button></span></div>; })}</div> :
    view === "lots" ? <div className="record-list"><Head labels={["Lote","Compras","Disponible","Costo promedio","Proveedores"]} className="lot-row" />{(items as CoffeeLot[]).map((x) => { const associated = lotPurchases(x.id); const inventory = greenCoffeeInventory(x.id,data.purchases,data.roasts); const unitCost = weightedGreenUnitCost(associated); const providers = [...new Set(associated.map((item) => provider(item.provider_id)))].join(", "); return <div className="record-row lot-row" key={x.id}><Primary title={x.name} detail={[x.origin,x.variety].filter(Boolean).join(" · ")} /><span data-label="Compras">{associated.length}</span><strong data-label="Disponible">{weight(inventory.availableKg)} <small>de {weight(inventory.purchasedKg)}</small></strong><span data-label="Costo">{unitCost === null ? "—" : money(unitCost) + "/kg"}</span><span data-label="Proveedores">{providers || "—"}</span></div>; })}</div> :
    <div className="record-list"><Head labels={["Tostado","Entrada → salida","Merma","Costo base",""]} className="roast-row" />{(items as RoastBatch[]).map((x) => { const parent = lot(x.green_coffee_lot_id); const unitCost = weightedGreenUnitCost(lotPurchases(x.green_coffee_lot_id)); const m = roastMetrics(x.green_input_kg,x.roasted_output_kg,unitCost); const state = x.voided_at ? "Anulado" : x.completion?.is_complete ? "Completo" : "Faltan datos"; return <div className="record-row roast-row" key={x.id}><Primary title={x.name || parent?.name || "Tostado #" + short(x.id)} detail={(showDate(x.roast_date || x.roasted_at) + " · " + state)} /><span data-label="Pesos">{weight(x.green_input_kg)} → {weight(x.roasted_output_kg)}</span><strong data-label="Merma">{m.lossPct === null ? "—" : m.lossPct.toFixed(1) + "%"}</strong><span data-label="Costo">{m.roastedCostPerKg === null ? "—" : money(m.roastedCostPerKg) + "/kg"}</span><span>{!x.voided_at && <button className="button button--small" onClick={() => onEditRoast(x)}>Editar</button>}</span></div>; })}</div>}
  </section>;
}
function Head({ labels, className }: { labels: string[]; className: string }) { return <div className={"record-row record-row--head " + className}>{labels.map((label,index) => <span key={label + index}>{label}</span>)}</div>; }
function Primary({ title, detail, initials }: { title: string; detail: string; initials?: string }) { return <span className="primary-cell">{initials && <span className="record-avatar">{initials.toUpperCase()}</span>}<span><strong>{title}</strong><small>{detail}</small></span></span>; }
function Empty() { return <div className="empty-state"><span>○</span><h3>No hay registros</h3><p>Agrega el primero o cambia tu búsqueda.</p></div>; }

function EditPurchaseModal({ purchase, data, onClose, onSave }: { purchase: Purchase; data: OperationsData; onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
    const payload = { provider_id: raw.provider_id, green_coffee_lot_id: raw.green_coffee_lot_id, purchased_at: raw.purchased_at || null, received_weight_kg: raw.received_weight_kg, total_amount: raw.total_amount, currency: purchase.currency || "MXN", payment_method: raw.payment_method || null, notes: raw.notes ? String(raw.notes).trim() : null };
    try { await onSave(payload); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo actualizar la compra."); setBusy(false); }
  }
  return <Modal onClose={onClose} title="Editar compra" eyebrow="Actualiza los datos"><form className="entry-form" onSubmit={submit}><div className="form-grid">
    <Field label="Proveedor" full><select name="provider_id" required defaultValue={purchase.provider_id} autoFocus>{data.providers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.region ? " · " + x.region : ""}</option>)}</select></Field>
    <Field label="Lote de café verde" full><select name="green_coffee_lot_id" required defaultValue={purchase.green_coffee_lot_id}>{data.lots.map((x) => <option key={x.id} value={x.id}>{[x.name,x.variety,x.origin].filter(Boolean).join(" · ")}</option>)}</select></Field>
    <Field label="Fecha de compra" optional><input name="purchased_at" type="date" defaultValue={purchase.purchased_at || ""} /></Field>
    <Field label="Total pagado" unit={purchase.currency || "MXN"}><input name="total_amount" type="number" min="0" step="0.01" defaultValue={purchase.total_amount ?? ""} required /></Field>
    <Field label="Peso comprado" unit="kg"><input name="received_weight_kg" type="number" min="0.001" step="0.001" defaultValue={purchase.received_weight_kg} required /></Field>
    <Field label="Forma de pago" optional><select name="payment_method" defaultValue={purchase.payment_method || ""}><option value="">Sin especificar</option><option value="transferencia">Transferencia</option><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option>{purchase.payment_method && !["transferencia","efectivo","tarjeta"].includes(purchase.payment_method) && <option value={purchase.payment_method}>{purchase.payment_method}</option>}</select></Field>
    <Field label="Notas" optional full><input name="notes" defaultValue={purchase.notes || ""} placeholder="Información adicional" /></Field>
    <p className="form-note field--full">Al guardar, la compra quedará confirmada y entrará al peso y costo promedio del lote.</p>
  </div>{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="button button--primary" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></footer></form></Modal>;
}

function EditRoastModal({ roast, data, onClose, onSave }: { roast: RoastBatch; data: OperationsData; onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [lotId, setLotId] = useState(roast.green_coffee_lot_id);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const inventory = greenCoffeeInventory(lotId,data.purchases,data.roasts,roast.id);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const raw = Object.fromEntries(new FormData(event.currentTarget).entries());
    const greenInput = raw.green_input_kg ? Number(raw.green_input_kg) : null;
    const roastedOutput = raw.roasted_output_kg ? Number(raw.roasted_output_kg) : null;
    if (greenInput !== null && roastedOutput !== null && roastedOutput > greenInput) { setError("La salida tostada no puede superar la entrada verde."); return; }
    if (greenInput !== null && greenInput > inventory.availableKg + 1e-9) { setError(`Solo hay ${weight(inventory.availableKg)} disponibles para este lote.`); return; }
    setBusy(true);
    const payload = { green_coffee_lot_id: lotId, name: raw.name ? String(raw.name).trim() : null, roast_date: raw.roast_date || null, roasted_at: isoFromLocalDateTime(raw.roasted_at), green_input_kg: raw.green_input_kg || null, roasted_output_kg: raw.roasted_output_kg || null, duration_seconds: raw.duration_minutes ? Math.round(Number(raw.duration_minutes) * 60) : null, charge_temperature_c: raw.charge_temperature_c || null, balance_point_temperature_c: raw.balance_point_temperature_c || null, setup_notes: raw.setup_notes ? String(raw.setup_notes).trim() : null, sensory_rating: raw.sensory_rating ? Number(raw.sensory_rating) : null, tasting_notes: raw.tasting_notes ? String(raw.tasting_notes).trim() : null, notes: raw.notes ? String(raw.notes).trim() : null };
    try { await onSave(payload); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo actualizar el tostado."); setBusy(false); }
  }
  return <Modal onClose={onClose} title="Editar tostado" eyebrow="Guardar actualiza inventario"><form className="entry-form" onSubmit={submit}><div className="form-grid">
    <Field label="Lote de café verde" full><select name="green_coffee_lot_id" required value={lotId} onChange={(event) => setLotId(event.target.value)} autoFocus>{data.lots.map((x) => { const available = greenCoffeeInventory(x.id,data.purchases,data.roasts,roast.id).availableKg; return <option key={x.id} value={x.id}>{x.name} · {weight(available)} disponibles</option>; })}</select></Field>
    <p className="inventory-note field--full"><strong>{weight(inventory.availableKg)}</strong> disponibles · {weight(inventory.purchasedKg)} comprados · {weight(inventory.reservedKg)} usados en otros tostados</p>
    <Field label="Nombre" optional full><input name="name" defaultValue={roast.name || ""} placeholder="Ej. Tueste medio" /></Field>
    <Field label="Fecha" optional><input name="roast_date" type="date" defaultValue={roast.roast_date || ""} /></Field>
    <Field label="Inicio exacto" optional><input name="roasted_at" type="datetime-local" defaultValue={roast.roasted_at ? localDateTime(roast.roasted_at) : ""} /></Field>
    <Field label="Entrada verde" unit="kg" optional><input name="green_input_kg" type="number" min="0.001" max={inventory.availableKg} step="0.001" defaultValue={roast.green_input_kg ?? ""} /></Field>
    <Field label="Salida tostada" unit="kg" optional><input name="roasted_output_kg" type="number" min="0.001" step="0.001" defaultValue={roast.roasted_output_kg ?? ""} /></Field>
    <Field label="Duración" unit="min" optional><input name="duration_minutes" type="number" min="0" step="0.1" defaultValue={roast.duration_seconds === null ? "" : roast.duration_seconds / 60} /></Field>
    <Field label="Temperatura de carga" unit="°C" optional><input name="charge_temperature_c" type="number" min="0" step="0.1" defaultValue={roast.charge_temperature_c ?? ""} /></Field>
    <Field label="Punto de equilibrio" unit="°C" optional><input name="balance_point_temperature_c" type="number" min="0" step="0.1" defaultValue={roast.balance_point_temperature_c ?? ""} title="Temperatura mínima después de la carga, donde la curva empieza a subir." /></Field>
    <Field label="Notas previas" optional full><input name="setup_notes" defaultValue={roast.setup_notes || ""} /></Field>
    <Field label="Calificación" optional><select name="sensory_rating" defaultValue={roast.sensory_rating ?? ""}><option value="">Sin calificar</option>{[1,2,3,4,5].map((rating) => <option key={rating} value={rating}>{rating} / 5</option>)}</select></Field>
    <Field label="Notas de cata" optional><input name="tasting_notes" defaultValue={roast.tasting_notes || ""} /></Field>
    <Field label="Notas operativas" optional full><input name="notes" defaultValue={roast.notes || ""} /></Field>
  </div>{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="button button--primary" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></footer></form></Modal>;
}

function EntryModal({ kind, data, onClose, onSave }: { kind: EntryKind; data: OperationsData; onClose: () => void; onSave: (kind: EntryKind, payload: Record<string, unknown>) => Promise<void> }) {
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const title = { provider: "Nuevo proveedor", purchase: "Nueva compra", lot: "Nuevo lote verde", roast: "Nuevo tostado" }[kind];
  const unavailable = kind === "purchase" && !data.providers.length || kind === "roast" && !data.lots.length;
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const raw = Object.fromEntries(new FormData(event.currentTarget).entries()); let value: Record<string, unknown>;
    if (kind === "provider") value = { name: String(raw.name).trim(), ...(raw.region ? { region: String(raw.region).trim() } : {}) };
    else if (kind === "purchase") value = { provider_id: raw.provider_id, ...(raw.purchased_at ? { purchased_at: raw.purchased_at } : {}), received_weight_kg: raw.received_weight_kg, total_amount: raw.total_amount, currency: "MXN", ...(raw.payment_method ? { payment_method: raw.payment_method } : {}), ...(raw.lot_mode === "existing" ? { green_coffee_lot_id: raw.green_coffee_lot_id } : { new_green_coffee_lot: { name: String(raw.lot_name).trim(), ...(raw.origin ? { origin: String(raw.origin).trim() } : {}), ...(raw.variety ? { variety: String(raw.variety).trim() } : {}) } }) };
    else if (kind === "lot") value = { name: String(raw.name).trim(), ...(raw.origin ? { origin: String(raw.origin).trim() } : {}), ...(raw.variety ? { variety: String(raw.variety).trim() } : {}) };
    else { const inventory = greenCoffeeInventory(String(raw.green_coffee_lot_id),data.purchases,data.roasts); const greenInput = raw.green_input_kg ? Number(raw.green_input_kg) : null; const roastedOutput = raw.roasted_output_kg ? Number(raw.roasted_output_kg) : null; if (greenInput !== null && roastedOutput !== null && roastedOutput > greenInput) { setError("La salida tostada no puede superar la entrada verde."); return; } if (greenInput !== null && greenInput > inventory.availableKg + 1e-9) { setError(`Solo hay ${weight(inventory.availableKg)} disponibles para este lote.`); return; } value = { green_coffee_lot_id: raw.green_coffee_lot_id, ...(raw.name ? { name: String(raw.name).trim() } : {}), ...(raw.roast_date ? { roast_date: raw.roast_date } : {}), ...(raw.roasted_at ? { roasted_at: isoFromLocalDateTime(raw.roasted_at) } : {}), ...(raw.green_input_kg ? { green_input_kg: raw.green_input_kg } : {}), ...(raw.roasted_output_kg ? { roasted_output_kg: raw.roasted_output_kg } : {}), ...(raw.duration_minutes ? { duration_seconds: Math.round(Number(raw.duration_minutes) * 60) } : {}), ...(raw.charge_temperature_c ? { charge_temperature_c: raw.charge_temperature_c } : {}), ...(raw.balance_point_temperature_c ? { balance_point_temperature_c: raw.balance_point_temperature_c } : {}), ...(raw.setup_notes ? { setup_notes: String(raw.setup_notes).trim() } : {}), ...(raw.sensory_rating ? { sensory_rating: Number(raw.sensory_rating) } : {}), ...(raw.tasting_notes ? { tasting_notes: String(raw.tasting_notes).trim() } : {}), ...(raw.notes ? { notes: String(raw.notes).trim() } : {}) }; }
    setProposal(value);
  }
  async function save() { if (!proposal) return; setBusy(true); setError(""); try { await onSave(kind,proposal); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar."); setBusy(false); } }
  return <Modal onClose={onClose} title={title} eyebrow={proposal ? "Revisa antes de guardar" : "Captura esencial"}>{unavailable ? <div className="modal-empty"><b>!</b><h3>Falta un registro anterior</h3><p>Agrega primero el registro del que depende este movimiento.</p><button className="button" onClick={onClose}>Entendido</button></div> : proposal ? <Proposal kind={kind} value={proposal} data={data} busy={busy} error={error} onBack={() => setProposal(null)} onSave={save} /> : <form className="entry-form" onSubmit={prepare}><Fields kind={kind} data={data} />{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">Revisar registro →</button></footer></form>}</Modal>;
}

function Fields({ kind, data }: { kind: EntryKind; data: OperationsData }) {
  const [lotMode, setLotMode] = useState<"existing" | "new">(data.lots.length ? "existing" : "new");
  const [selectedRoastLotId, setSelectedRoastLotId] = useState("");
  const knownVarieties = [...new Set(data.lots.map((lot) => lot.variety).filter((value): value is string => Boolean(value)))].sort();
  const knownOrigins = [...new Set(data.lots.map((lot) => lot.origin).filter((value): value is string => Boolean(value)))].sort();
  const selectedInventory = selectedRoastLotId ? greenCoffeeInventory(selectedRoastLotId,data.purchases,data.roasts) : null;
  if (kind === "provider") return <div className="form-grid"><Field label="Nombre del proveedor" full><input name="name" placeholder="Ej. Finca La Esperanza" required autoFocus /></Field><Field label="Región" optional full><input name="region" placeholder="Ej. Coatepec, Veracruz" /></Field></div>;
  if (kind === "purchase") return <div className="form-grid">
    <Field label="Proveedor" full><select name="provider_id" required defaultValue="" autoFocus><option value="" disabled>Selecciona un proveedor</option>{data.providers.map((x) => <option key={x.id} value={x.id}>{x.name}{x.region ? " · " + x.region : ""}</option>)}</select></Field>
    <Field label="Fecha de compra" optional><input name="purchased_at" type="date" /></Field>
    <Field label="Total pagado" unit="MXN"><input name="total_amount" type="number" min="0" step="0.01" placeholder="0.00" required /></Field>
    <div className="form-section field--full"><span>Lote de café verde comprado</span><small>Elige uno existente o crea uno nuevo.</small></div>
    <div className="lot-mode field--full" role="group" aria-label="Tipo de lote"><label className={lotMode === "existing" ? "lot-mode__active" : ""}><input type="radio" name="lot_mode" value="existing" checked={lotMode === "existing"} onChange={() => setLotMode("existing")} disabled={!data.lots.length} />Lote existente</label><label className={lotMode === "new" ? "lot-mode__active" : ""}><input type="radio" name="lot_mode" value="new" checked={lotMode === "new"} onChange={() => setLotMode("new")} />Crear lote nuevo</label></div>
    {lotMode === "existing" ? <Field label="Lote de café verde" full><select name="green_coffee_lot_id" required defaultValue=""><option value="" disabled>Selecciona un lote</option>{data.lots.map((x) => <option key={x.id} value={x.id}>{[x.name,x.variety,x.origin].filter(Boolean).join(" · ")}</option>)}</select></Field> : <>
    <Field label="Nombre o referencia del lote" full><input name="lot_name" placeholder="Ej. Cosecha 2026 · Lote 04" required /></Field>
    <Field label="Variedad" optional><input name="variety" list="purchase-varieties" placeholder="Ej. bourbon" /><datalist id="purchase-varieties">{knownVarieties.map((variety) => <option key={variety} value={variety} />)}</datalist></Field>
    <Field label="Origen" optional><input name="origin" list="purchase-origins" placeholder="Ej. Chiapas" /><datalist id="purchase-origins">{knownOrigins.map((origin) => <option key={origin} value={origin} />)}</datalist></Field></>}
    <Field label="Peso comprado" unit="kg"><input name="received_weight_kg" type="number" min="0.001" step="0.001" placeholder="0.000" required /></Field>
    <Field label="Forma de pago" optional full><select name="payment_method" defaultValue=""><option value="">Sin especificar</option><option value="transferencia">Transferencia</option><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option></select></Field>
    <p className="form-note field--full">Al guardar, el peso y monto entrarán al inventario y al costo promedio ponderado del lote.</p>
  </div>;
  if (kind === "lot") return <div className="form-grid"><Field label="Nombre del lote" full><input name="name" placeholder="Ej. Cosecha 2026 · Lote 04" required autoFocus /></Field><Field label="Origen" optional><input name="origin" list="lot-origins" placeholder="Ej. Chiapas" /><datalist id="lot-origins">{knownOrigins.map((origin) => <option key={origin} value={origin} />)}</datalist></Field><Field label="Variedad" optional><input name="variety" list="lot-varieties" placeholder="Ej. Bourbon" /><datalist id="lot-varieties">{knownVarieties.map((variety) => <option key={variety} value={variety} />)}</datalist></Field><p className="form-note field--full">El peso y el costo pertenecen a cada compra. Después podrás asociar varias compras con este lote.</p></div>;
  return <div className="form-grid"><Field label="Lote de café verde" full><select name="green_coffee_lot_id" required value={selectedRoastLotId} onChange={(event) => setSelectedRoastLotId(event.target.value)} autoFocus><option value="" disabled>Selecciona un lote</option>{data.lots.map((x) => { const inventory = greenCoffeeInventory(x.id,data.purchases,data.roasts); const purchases = data.purchases.filter((purchase) => purchase.green_coffee_lot_id === x.id); const cost = weightedGreenUnitCost(purchases); return <option key={x.id} value={x.id}>{x.name} · {weight(inventory.availableKg)} disponibles · {cost === null ? "sin costo" : money(cost) + "/kg"}</option>; })}</select></Field>{selectedInventory && <p className="inventory-note field--full"><strong>{weight(selectedInventory.availableKg)}</strong> disponibles · {weight(selectedInventory.purchasedKg)} comprados · {weight(selectedInventory.reservedKg)} usados</p>}<Field label="Nombre" optional full><input name="name" placeholder="Ej. Perfil medio" /></Field><Field label="Fecha" optional><input name="roast_date" type="date" /></Field><Field label="Inicio exacto" optional><input name="roasted_at" type="datetime-local" /></Field><Field label="Entrada verde" unit="kg" optional><input name="green_input_kg" type="number" min="0.001" max={selectedInventory?.availableKg} step="0.001" /></Field><Field label="Salida tostada" unit="kg" optional><input name="roasted_output_kg" type="number" min="0.001" step="0.001" /></Field><Field label="Duración" unit="min" optional><input name="duration_minutes" type="number" min="0" step="0.1" /></Field><Field label="Temperatura de carga" unit="°C" optional><input name="charge_temperature_c" type="number" min="0" step="0.1" /></Field><Field label="Punto de equilibrio" unit="°C" optional><input name="balance_point_temperature_c" type="number" min="0" step="0.1" title="Temperatura mínima después de la carga, donde la curva empieza a subir." /></Field><Field label="Notas previas" optional full><input name="setup_notes" /></Field><Field label="Calificación" optional><select name="sensory_rating" defaultValue=""><option value="">Sin calificar</option>{[1,2,3,4,5].map((rating) => <option key={rating} value={rating}>{rating} / 5</option>)}</select></Field><Field label="Notas de cata" optional><input name="tasting_notes" /></Field><Field label="Notas operativas" optional full><input name="notes" /></Field><p className="form-note field--full">Puedes guardar ahora y completar el registro conforme avance el tostado. El peso verde afectará el inventario en cuanto se capture.</p></div>;
}
function Field({ label, unit, optional, full, children }: { label: string; unit?: string; optional?: boolean; full?: boolean; children: ReactNode }) { return <label className={full ? "field--full" : ""}>{label}{unit && <span className="unit">{unit}</span>}{optional && <span className="optional">Opcional</span>}{children}</label>; }

function Proposal({ kind, value, data, busy, error, onBack, onSave }: { kind: EntryKind; value: Record<string, unknown>; data: OperationsData; busy: boolean; error: string; onBack: () => void; onSave: () => void }) {
  const rows: Array<[string,ReactNode]> = []; let calc: ReactNode = null;
  if (kind === "provider") rows.push(["Nombre",String(value.name)],["Región",value.region ? String(value.region) : "Sin especificar"]);
  else if (kind === "purchase") { const newLot = value.new_green_coffee_lot as Record<string, unknown> | undefined; const existingLot = data.lots.find((x) => x.id === value.green_coffee_lot_id); const selectedLot = newLot || existingLot; const unitCost = Number(value.total_amount) / Number(value.received_weight_kg); rows.push(["Proveedor",data.providers.find((x) => x.id === value.provider_id)?.name || "—"],["Fecha",showDate(value.purchased_at ? String(value.purchased_at) : null)],["Total",money(value.total_amount)],["Peso comprado",weight(value.received_weight_kg)],["Lote",selectedLot?.name ? String(selectedLot.name) : "—"],["Variedad",selectedLot?.variety ? String(selectedLot.variety) : "—"],["Origen",selectedLot?.origin ? String(selectedLot.origin) : "Sin especificar"]); calc = <Calc label="Costo de esta compra" value={money(unitCost) + "/kg"} formula={money(value.total_amount) + " ÷ " + weight(value.received_weight_kg)} />; }
  else if (kind === "lot") rows.push(["Nombre",String(value.name)],["Origen",value.origin ? String(value.origin) : "Sin especificar"],["Variedad",value.variety ? String(value.variety) : "Sin especificar"],["Compras asociadas","0 · se agregan desde Compras"]);
  else { const parent = data.lots.find((x) => x.id === value.green_coffee_lot_id); const unitCost = weightedGreenUnitCost(data.purchases.filter((purchase) => purchase.green_coffee_lot_id === value.green_coffee_lot_id)); const m = roastMetrics(value.green_input_kg === undefined ? null : String(value.green_input_kg),value.roasted_output_kg === undefined ? null : String(value.roasted_output_kg),unitCost); rows.push(["Lote",parent?.name || "Lote #" + short(String(value.green_coffee_lot_id))],["Fecha",showDate(value.roast_date ? String(value.roast_date) : null)],["Entrada",weight(value.green_input_kg)],["Salida",weight(value.roasted_output_kg)]); calc = <div className="calculation-grid"><Calc label="Merma" value={m.lossPct === null ? "Pendiente" : m.lossPct.toFixed(2) + "%"} formula="(entrada − salida) ÷ entrada × 100" /><Calc label="Rendimiento" value={m.yieldPct === null ? "Pendiente" : m.yieldPct.toFixed(2) + "%"} formula="salida ÷ entrada × 100" /><Calc label="Costo base tostado" value={m.roastedCostPerKg === null ? "Pendiente" : money(m.roastedCostPerKg) + "/kg"} formula="(entrada × costo promedio) ÷ salida" /></div>; }
  return <div className="proposal"><div className="proposal-list">{rows.map((row) => <div key={row[0]}><span>{row[0]}</span><strong>{row[1]}</strong></div>)}</div>{calc}{error && <div className="form-error">{error}</div>}<footer className="modal-actions"><button className="button button--ghost" onClick={onBack} disabled={busy}>← Corregir</button><button className="button button--primary" onClick={onSave} disabled={busy}>{busy ? "Guardando…" : "Guardar registro"}</button></footer></div>;
}
function Calc({ label, value, formula }: { label: string; value: string; formula: string }) { return <div className="calculation"><span>{label}</span><strong>{value}</strong><small>{formula}</small></div>; }

function Modal({ onClose, title, eyebrow, children, small = false }: { onClose: () => void; title: string; eyebrow: string; children: ReactNode; small?: boolean }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className={"modal" + (small ? " modal--small" : "")} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><header className="modal-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>; }
