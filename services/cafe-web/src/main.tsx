import { createClient } from "@supabase/supabase-js";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

interface AppConfig {
  supabase_url: string;
  supabase_publishable_key: string;
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element is missing");

const root = createRoot(container);

async function boot() {
  const response = await fetch("/app-config.json");
  if (!response.ok) throw new Error("No se pudo cargar la configuración.");
  const config = (await response.json()) as AppConfig;
  const supabase = createClient(
    config.supabase_url,
    config.supabase_publishable_key,
  );
  root.render(<App supabase={supabase} />);
}

void boot().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "No se pudo iniciar Cafe OS.";
  root.render(
    <main className="boot-error">
      <div className="brand-mark">RÍO</div>
      <h1>No pudimos abrir Cafe OS</h1>
      <p>{message}</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reintentar
      </button>
    </main>,
  );
});
