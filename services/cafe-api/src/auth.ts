import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

export interface AccessTokenVerifier {
  verify(accessToken: string): Promise<AuthenticatedUser | null>;
}

export class SupabaseAccessTokenVerifier implements AccessTokenVerifier {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "cafe-os-api/0.2.0" } },
    });
  }

  async verify(accessToken: string): Promise<AuthenticatedUser | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error || !data.user) return null;
    return {
      id: data.user.id,
      ...(data.user.email ? { email: data.user.email } : {}),
    };
  }
}
