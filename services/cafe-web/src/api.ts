interface ApiEnvelope<T> {
  data: T;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    fields?: Array<{ field: string; message: string }>;
  };
}

export class CafeApi {
  constructor(private readonly accessToken: () => string | undefined) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.accessToken();
    if (!token) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");

    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      let body: ApiErrorBody = {};
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        // Preserve the status-based fallback below.
      }
      if (response.status === 401) {
        throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
      }
      const fieldMessage = body.error?.fields?.[0]?.message;
      throw new Error(
        fieldMessage ||
          body.error?.message ||
          `No se pudo completar la operación (HTTP ${response.status}).`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async list<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let offset = 0;
    while (true) {
      const response = await this.request<ApiEnvelope<T[]>>(
        `/v1/${path}?limit=100&offset=${offset}`,
      );
      rows.push(...response.data);
      if (response.data.length < 100) return rows;
      offset += 100;
    }
  }

  async create<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.request<ApiEnvelope<T>>(`/v1/${path}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return response.data;
  }

  async update<T>(path: string, payload: Record<string, unknown>, method: "PATCH" | "PUT" = "PATCH"): Promise<T> {
    const response = await this.request<ApiEnvelope<T>>(`/v1/${path}`, {
      method,
      body: JSON.stringify(payload),
    });
    return response.data;
  }

  async action<T>(path: string): Promise<T> {
    const response = await this.request<ApiEnvelope<T>>(`/v1/${path}`, {
      method: "POST",
    });
    return response.data;
  }
}
