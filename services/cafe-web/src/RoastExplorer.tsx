import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { OperationsData, RoastBatch } from "./types";
import { roastMetrics, weightedGreenUnitCost } from "./calculations";
import { curveExtent, curveSegments, filterRoasts, formatRoastTime, numericReading, roastDay, roastName, roastState } from "./roast-history";
import type { CurveMetric, HistoryStatus } from "./roast-history";

const colors = ["#28634e", "#b35f3e", "#6654a0"];
const metrics: Array<{ key: CurveMetric; label: string; unit: string }> = [
  { key: "temperature_c", label: "Temperatura", unit: "°C" },
  { key: "airflow_setting", label: "Tiro", unit: "Escala de la máquina" },
  { key: "gas_setting", label: "Gas", unit: "Escala de la máquina" },
];
function date(value: string | null | undefined, time = false) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "short", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(value.length === 10 ? value + "T12:00:00-06:00" : value));
}
function reading(value: unknown, unit = "") {
  const number = numericReading(value);
  return number === null ? "—" : `${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 }).format(number)}${unit ? ` ${unit}` : ""}`;
}
function percent(value: number | null) { return value === null ? "—" : `${value.toFixed(1)} %`; }
function State({ roast }: { roast: RoastBatch }) { return <span className={`roast-state${roast.voided_at ? " roast-state--void" : roast.completion?.is_complete ? " roast-state--complete" : ""}`}>{roastState(roast)}</span>; }
function Blank({ title, children }: { title: string; children: ReactNode }) { return <div className="roast-blank"><span aria-hidden="true">⌁</span><h3>{title}</h3><p>{children}</p></div>; }

export function RoastHistory({ data, onEditRoast }: { data: OperationsData; onEditRoast: (roast: RoastBatch) => void }) {
  const [search, setSearch] = useState("");
  const [lotId, setLotId] = useState("");
  const [status, setStatus] = useState<HistoryStatus>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const roasts = filterRoasts(data.roasts, data.lots, { search, lotId, status, from, to });
  const selected = roasts.find((roast) => roast.id === selectedId);
  function reset() { setSearch(""); setLotId(""); setStatus("all"); setFrom(""); setTo(""); }
  return <section className="panel roast-history">
    <header className="explorer-heading"><div><p className="eyebrow">Bitácora de producción</p><h2>Historial de tostados</h2><p>Consulta cada sesión, sus resultados y su curva.</p></div><span className="explorer-count" aria-live="polite">{roasts.length} de {data.roasts.length} tostados</span></header>
    <div className="roast-filters">
      <label className="roast-filter-search">Buscar<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nombre, lote o notas…" /></label>
      <label>Lote<select aria-label="Lote" value={lotId} onChange={(event) => setLotId(event.target.value)}><option value="">Todos los lotes</option>{data.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}</select></label>
      <label>Estado<select aria-label="Estado" value={status} onChange={(event) => setStatus(event.target.value as HistoryStatus)}><option value="all">Todos los estados</option><option value="complete">Completos</option><option value="incomplete">Faltan datos</option><option value="void">Anulados</option></select></label>
      <label>Desde<input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>Hasta<input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
    </div>
    {(search || lotId || status !== "all" || from || to) && <div className="filter-reset"><button className="text-button" onClick={reset}>Limpiar filtros</button></div>}
    {roasts.length === 0 ? <Blank title={data.roasts.length ? "No hay tostados con estos filtros" : "Tu historial empieza aquí"}>{data.roasts.length ? "Cambia la búsqueda o limpia los filtros para ver otras sesiones." : "Guarda tu primer tostado desde Nuevo tostado."}</Blank> : <div className="roast-history-list">
      <div className="roast-history-row roast-history-row--head" aria-hidden="true"><div className="roast-history-summary"><span>Tostado / lote</span><span>Entrada → salida</span><span>Duración / merma</span><span>Estado</span></div><span /></div>
      {roasts.map((roast) => {
        const lot = data.lots.find((item) => item.id === roast.green_coffee_lot_id);
        const m = roastMetrics(roast.green_input_kg, roast.roasted_output_kg, null);
        return <article className="roast-history-row" key={roast.id}>
          <button className="roast-history-summary" onClick={() => setSelectedId(roast.id)} aria-label={`Ver detalle de ${roastName(roast, data.lots)}`}>
            <span className="roast-history-name"><strong>{roastName(roast, data.lots)}</strong><small>{date(roastDay(roast))} · {lot?.name || "Sin lote"}</small></span>
            <span data-label="Pesos"><strong>{reading(roast.green_input_kg, "kg")} → {reading(roast.roasted_output_kg, "kg")}</strong><small>{roast.checkpoints?.length || 0} puntos de control</small></span>
            <span data-label="Resultado"><strong>{roast.duration_seconds === null ? "—" : formatRoastTime(roast.duration_seconds)}</strong><small>{percent(m.lossPct)} de merma</small></span>
            <span><State roast={roast} /></span>
          </button>
          <div className="roast-row-actions">{!roast.voided_at && <button className="button button--small" onClick={() => onEditRoast(roast)} aria-label={`Editar ${roastName(roast, data.lots)}`}>Editar</button>}</div>
        </article>;
      })}
    </div>}
    {selected && <RoastDetail roast={selected} data={data} roasts={roasts} onSelect={setSelectedId} onClose={() => setSelectedId(null)} onEditRoast={onEditRoast} />}
  </section>;
}

export function RoastCurves({ data, onEditRoast }: { data: OperationsData; onEditRoast: (roast: RoastBatch) => void }) {
  const [lotId, setLotId] = useState("");
  const [includeVoided, setIncludeVoided] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const roasts = filterRoasts(data.roasts, data.lots, { search: "", lotId, status: "all", from: "", to: "" }).filter((roast) => includeVoided || !roast.voided_at);
  // Default to the latest roast with measured curve data, or the latest record.
  const selected = selectedIds.map((id) => roasts.find((roast) => roast.id === id)).filter((roast): roast is RoastBatch => !!roast);
  const fallback = roasts.find((roast) => metrics.some((metric) => curveSegments(roast, metric.key).length > 0)) || roasts[0];
  const compared = selected.length ? selected : fallback ? [fallback] : [];
  const detail = data.roasts.find((roast) => roast.id === detailId);
  function toggle(roast: RoastBatch) {
    const current = compared.map((item) => item.id);
    setSelectedIds(current.includes(roast.id) ? current.length === 1 ? current : current.filter((id) => id !== roast.id) : [...current, roast.id].slice(0, 3));
  }
  return <section className="panel roast-curves">
    <header className="explorer-heading"><div><p className="eyebrow">Perfiles de producción</p><h2>Curvas por tostado</h2><p>Selecciona hasta tres sesiones para comparar sus puntos registrados.</p></div><span className="explorer-count">{compared.length} / 3 seleccionados</span></header>
    <div className="curve-browser-filters"><label>Lote<select aria-label="Lote" value={lotId} onChange={(event) => { setLotId(event.target.value); setSelectedIds([]); }}><option value="">Todos los lotes</option>{data.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}</select></label><label className="curve-void-toggle"><input type="checkbox" checked={includeVoided} onChange={(event) => setIncludeVoided(event.target.checked)} />Incluir anulados</label></div>
    {!roasts.length ? <Blank title="No hay tostados para mostrar">Selecciona otro lote o registra una sesión en Nuevo tostado.</Blank> : <div className="curve-browser">
      <div className="curve-roast-list" role="group" aria-label="Seleccionar tostados para comparar">{roasts.map((roast) => {
        const index = compared.findIndex((item) => item.id === roast.id);
        return <button key={roast.id} className={`curve-roast-option${index >= 0 ? " curve-roast-option--selected" : ""}`} style={{ "--curve-color": colors[Math.max(0, index)] } as CSSProperties} aria-pressed={index >= 0} disabled={index < 0 && compared.length >= 3} onClick={() => toggle(roast)}><span className="curve-choice-mark" aria-hidden="true">{index >= 0 ? "✓" : "＋"}</span><span><strong>{roastName(roast, data.lots)}</strong><small>{date(roastDay(roast))} · {roast.checkpoints?.length || 0} puntos</small>{roast.voided_at && <small>Anulado</small>}</span></button>;
      })}</div>
      <div className="curve-browser-content"><RoastCurveChart roasts={compared} data={data} /><div className="curve-session-links">{compared.map((roast, index) => <button className="text-button" key={roast.id} style={{ color: colors[index] }} onClick={() => setDetailId(roast.id)}>Ver detalle · {roastName(roast, data.lots)} →</button>)}</div></div>
    </div>}
    {detail && <RoastDetail roast={detail} data={data} roasts={roasts} onSelect={setDetailId} onClose={() => setDetailId(null)} onEditRoast={onEditRoast} />}
  </section>;
}

export function RoastCurveChart({ roasts, data }: { roasts: RoastBatch[]; data: OperationsData }) {
  const [metric, setMetric] = useState<CurveMetric>("temperature_c");
  const [activePoint, setActivePoint] = useState<{ key: string; text: string } | null>(null);
  const chartId = useId();
  const info = metrics.find((item) => item.key === metric)!;
  const extent = curveExtent(roasts, metric);
  const series = roasts.map((roast) => ({ roast, segments: curveSegments(roast, metric) }));
  const selectionKey = `${metric}:${roasts.map((roast) => roast.id).join(",")}`;
  const width = 760, height = 330, left = 62, right = 22, top = 22, bottom = 58;
  const x = (seconds: number) => left + seconds / extent.end * (width - left - right);
  const y = (value: number) => height - bottom - (value - extent.min) / (extent.max - extent.min) * (height - top - bottom);
  return <section className="roast-curve-chart" aria-label="Curva del tostado">
    <p className="curve-caption">Las líneas unen mediciones registradas; los valores faltantes dejan cortes en la curva. {metric === "temperature_c" ? "La carga se muestra en 00:00. El punto de equilibrio se consulta en el detalle porque no tiene tiempo registrado." : "Tiro y gas usan la escala de la máquina; compara sesiones con la misma escala."}</p>
    <div className="curve-chart-toolbar"><div className="curve-metric-tabs" role="group" aria-label="Medición de la curva">{metrics.map((item) => <button key={item.key} aria-pressed={metric === item.key} className={metric === item.key ? "curve-metric--active" : ""} onClick={() => setMetric(item.key)}>{item.label}</button>)}</div><small>{info.unit}</small></div>
    {!extent.count ? <Blank title={`Sin registros de ${info.label.toLocaleLowerCase("es")}`}>Esta medición no se capturó en los tostados seleccionados. Puedes consultar sus demás datos en el detalle.</Blank> : <>
      <div className="curve-svg-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${chartId}-title ${chartId}-desc`}>
        <title id={`${chartId}-title`}>{info.label} por tiempo de tostado</title><desc id={`${chartId}-desc`}>Puntos registrados para {roasts.map((roast) => roastName(roast, data.lots)).join(", ")}. Los valores completos están en las tablas de puntos del detalle.</desc>
        {Array.from({ length: 5 }, (_, index) => {
          const value = extent.min + (extent.max - extent.min) * index / 4;
          return <g key={`y-${index}`}><line className="curve-grid-line" x1={left} x2={width - right} y1={y(value)} y2={y(value)} /><text className="curve-axis-label" x={left - 10} y={y(value) + 4} textAnchor="end">{reading(value)}</text></g>;
        })}
        {Array.from({ length: 5 }, (_, index) => {
          const seconds = Math.round(extent.end * index / 4);
          return <g key={`x-${index}`}><text className="curve-axis-label" x={x(seconds)} y={height - bottom + 25} textAnchor="middle">{formatRoastTime(seconds)}</text></g>;
        })}
        <text className="curve-axis-title" x={width / 2} y={height - 8} textAnchor="middle">Tiempo transcurrido</text>
        {series.map(({ roast, segments }, index) => <g key={roast.id} style={{ color: colors[index] }}>{segments.map((segment, segmentIndex) => <g key={segmentIndex}>
          {segment.length > 1 && <polyline points={segment.map((point) => `${x(point.seconds)},${y(point.value)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeDasharray={index === 1 ? "8 4" : index === 2 ? "3 4" : undefined} />}
          {segment.map((point, pointIndex) => {
            const text = `${roastName(roast, data.lots)} · ${formatRoastTime(point.seconds)} · ${info.label}: ${reading(point.value, metric === "temperature_c" ? "°C" : "")} ${point.note ? `· ${point.note}` : ""}`;
            return <circle key={pointIndex} cx={x(point.seconds)} cy={y(point.value)} r="5" fill="currentColor" stroke="white" strokeWidth="2" tabIndex={0} role="button" aria-label={text} onFocus={() => setActivePoint({ key: selectionKey, text })} onMouseEnter={() => setActivePoint({ key: selectionKey, text })} onClick={() => setActivePoint({ key: selectionKey, text })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActivePoint({ key: selectionKey, text }); } }}><title>{text}</title></circle>;
          })}
        </g>)}</g>)}
      </svg></div>
      <p className="curve-point-readout" aria-live="polite">{activePoint?.key === selectionKey ? activePoint.text : "Selecciona un punto para consultar su tiempo, valor y nota."}</p>
    </>}
    <div className="curve-legend">{series.map(({ roast, segments }, index) => <span key={roast.id}><i style={{ background: colors[index] }} /><strong>{roastName(roast, data.lots)}</strong><small>{segments.flat().length} mediciones</small></span>)}</div>
  </section>;
}

function DetailField({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }

function RoastDetail({ roast, data, roasts, onSelect, onClose, onEditRoast }: { roast: RoastBatch; data: OperationsData; roasts: RoastBatch[]; onSelect: (id: string) => void; onClose: () => void; onEditRoast: (roast: RoastBatch) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => { dialog.close(); document.body.style.overflow = oldOverflow; previousFocus?.focus(); };
  }, []);
  useEffect(() => { dialogRef.current?.scrollTo({ top: 0 }); }, [roast.id]);
  const lot = data.lots.find((item) => item.id === roast.green_coffee_lot_id);
  const purchases = data.purchases.filter((purchase) => purchase.green_coffee_lot_id === roast.green_coffee_lot_id);
  const currencies = [...new Set(purchases.filter((purchase) => purchase.total_amount !== null).map((purchase) => purchase.currency || "MXN"))];
  const unitCost = currencies.length > 1 ? null : weightedGreenUnitCost(purchases);
  const m = roastMetrics(roast.green_input_kg, roast.roasted_output_kg, unitCost);
  const providers = [...new Set(purchases.map((purchase) => data.providers.find((provider) => provider.id === purchase.provider_id)?.name).filter(Boolean))];
  const points = [...(roast.checkpoints || [])].sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);
  const index = roasts.findIndex((item) => item.id === roast.id);
  const amount = m.roastedCostPerKg === null ? "—" : new Intl.NumberFormat("es-MX", { style: "currency", currency: currencies[0] || "MXN", currencyDisplay: "code" }).format(m.roastedCostPerKg) + "/kg";
  return <dialog ref={dialogRef} className="roast-detail-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <header className="roast-detail-header"><div><p className="eyebrow">Detalle del tostado · {date(roastDay(roast))}</p><h2 id={titleId}>{roastName(roast, data.lots)}</h2><State roast={roast} /></div><button autoFocus className="icon-button" aria-label="Cerrar detalle" onClick={onClose}>×</button></header>
    <div className="roast-detail-content">
      {roast.voided_at && <div className="roast-void-note"><strong>Anulado el {date(roast.voided_at, true)}</strong><p>{roast.void_reason || "Sin motivo registrado"}</p></div>}
      <section className="roast-detail-section"><h3>Origen y sesión</h3><dl className="roast-detail-fields">
        <DetailField label="Lote verde">{lot?.name || "Sin lote"}</DetailField><DetailField label="Origen / variedad">{[lot?.origin, lot?.variety].filter(Boolean).join(" · ") || "—"}</DetailField><DetailField label="Proveedores del lote">{providers.join(", ") || "—"}</DetailField>
        <DetailField label="Fecha de tostado">{date(roast.roast_date)}</DetailField><DetailField label="Inicio exacto (hora de México)">{roast.roasted_at ? date(roast.roasted_at, true) : "—"}</DetailField><DetailField label="Duración">{roast.duration_seconds === null ? "—" : formatRoastTime(roast.duration_seconds)}</DetailField>
      </dl></section>
      <section className="roast-detail-section"><h3>Pesos y rendimiento</h3><dl className="roast-result-grid"><DetailField label="Entrada verde">{reading(roast.green_input_kg, "kg")}</DetailField><DetailField label="Salida tostada">{reading(roast.roasted_output_kg, "kg")}</DetailField><DetailField label="Merma">{percent(m.lossPct)}</DetailField><DetailField label="Rendimiento">{percent(m.yieldPct)}</DetailField><DetailField label="Costo base actual">{amount}</DetailField></dl>
        <p className="detail-formula">Merma = (entrada verde − salida tostada) / entrada verde × 100. Rendimiento = salida tostada / entrada verde × 100.</p><p className="detail-formula">Costo base = entrada verde × costo promedio actual del lote / salida tostada. Excluye empaque, mano de obra, energía y otros gastos.{currencies.length > 1 && " No disponible: las compras del lote usan monedas distintas."}</p>
      </section>
      <section className="roast-detail-section"><h3>Preparación</h3><dl className="roast-detail-fields"><DetailField label="Temperatura de carga">{reading(roast.charge_temperature_c, "°C")}</DetailField><DetailField label="Punto de equilibrio">{reading(roast.balance_point_temperature_c, "°C")}</DetailField></dl><p className="detail-note">{roast.setup_notes || "Sin notas de preparación."}</p>{roast.machine_settings && Object.keys(roast.machine_settings).length > 0 && <><h4>Ajustes de máquina registrados</h4><dl className="roast-detail-fields">{Object.entries(roast.machine_settings).map(([key, value]) => <DetailField key={key} label={key}>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</DetailField>)}</dl></>}</section>
      <section className="roast-detail-section"><h3>Curva</h3><RoastCurveChart key={roast.id} roasts={[roast]} data={data} /></section>
      <section className="roast-detail-section"><h3>Puntos de control</h3>
        {points.length > 0 ? <><p className="checkpoint-intro">Puntos registrados, en orden de tiempo</p><div className="checkpoint-table-wrap"><table className="checkpoint-table" aria-label="Puntos de control registrados"><thead><tr><th scope="col">Tiempo</th><th scope="col">Temp. °C</th><th scope="col">Tiro</th><th scope="col">Gas</th><th scope="col">Nota</th></tr></thead><tbody>{points.map((point, i) => <tr key={i}><td>{formatRoastTime(point.elapsed_seconds)}</td><td>{reading(point.temperature_c)}</td><td>{reading(point.airflow_setting)}</td><td>{reading(point.gas_setting)}</td><td>{point.note || "—"}</td></tr>)}</tbody></table></div></> : <p className="detail-note">Sin puntos de control registrados.</p>}
      </section>
      <section className="roast-detail-section"><h3>Evaluación y notas</h3><dl className="roast-detail-fields"><DetailField label="Calificación sensorial">{roast.sensory_rating == null ? "Sin calificar" : `${roast.sensory_rating} / 5`}</DetailField><DetailField label="Notas de cata">{roast.tasting_notes || "—"}</DetailField><DetailField label="Notas del operador">{roast.notes || "—"}</DetailField></dl></section>
      <p className="detail-record-dates">Registrado: {date(roast.created_at, true)} · Actualizado: {date(roast.updated_at, true)}</p>
    </div>
    <footer className="roast-detail-footer"><div className="detail-navigation"><button className="button button--small" disabled={index <= 0} onClick={() => onSelect(roasts[index - 1].id)}>← Anterior</button><span>{index + 1} de {roasts.length}</span><button className="button button--small" disabled={index < 0 || index >= roasts.length - 1} onClick={() => onSelect(roasts[index + 1].id)}>Siguiente →</button></div><div className="detail-actions"><button className="button button--ghost" onClick={onClose}>Cerrar</button>{!roast.voided_at && <button className="button button--primary" onClick={() => { onClose(); onEditRoast(roast); }}>Editar tostado</button>}</div></footer>
  </dialog>;
}
