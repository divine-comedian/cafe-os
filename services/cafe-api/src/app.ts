import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import {
  TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import {
  AccessTokenVerifier,
  SupabaseAccessTokenVerifier,
} from "./auth.js";
import { Config, loadConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { greenCoffeeRoutes } from "./routes/green-coffee.js";
import { providerRoutes } from "./routes/providers.js";
import { purchaseRoutes } from "./routes/purchases.js";
import { roastBatchRoutes } from "./routes/roast-batches.js";
import { CafeStore, SupabaseStore } from "./store.js";

export interface BuildAppOptions {
  config?: Config;
  store?: CafeStore;
  accessTokenVerifier?: AccessTokenVerifier;
  logger?: boolean;
}

function tokenMatches(actual: string, expectedToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  const candidate = Buffer.from(actual);
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const store =
    options.store ??
    new SupabaseStore(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      config.storageBucket,
    );
  const accessTokenVerifier =
    options.accessTokenVerifier ??
    new SupabaseAccessTokenVerifier(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
    );

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setValidatorCompiler(TypeBoxValidatorCompiler);

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & {
      statusCode?: number;
      validation?: Array<{
        instancePath?: string;
        message?: string;
        params: { missingProperty?: string };
      }>;
    };
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...error.details,
          request_id: request.id,
        },
      });
    }
    if (error.validation) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request contains invalid fields.",
          fields: error.validation.map((issue) => ({
            field: issue.instancePath || issue.params.missingProperty || "request",
            message: issue.message,
          })),
          request_id: request.id,
        },
      });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({
        error: {
          code: "REQUEST_TOO_LARGE",
          message: "The request body is too large.",
          request_id: request.id,
        },
      });
    }
    request.log.error({ err: error }, "Unhandled API error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        request_id: request.id,
      },
    });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Cafe OS API",
        description: "Operational API for providers, purchases, green coffee, and roasts.",
        version: "0.2.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    },
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes },
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-ID", request.id);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/openapi.json", async () => app.swagger());
  app.get("/app-config.json", async () => ({
    supabase_url: config.supabasePublicUrl,
    supabase_publishable_key: config.supabasePublishableKey,
  }));

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (request) => {
        const token = bearerToken(request.headers.authorization);
        if (!token) {
          throw new ApiError(
            401,
            "UNAUTHORIZED",
            "A valid API bearer token is required.",
          );
        }
        if (!tokenMatches(token, config.apiToken)) {
          const user = await accessTokenVerifier.verify(token);
          if (!user) {
            throw new ApiError(
              401,
              "UNAUTHORIZED",
              "A valid API bearer token is required.",
            );
          }
        }
      });
      await api.register(providerRoutes, { store });
      await api.register(purchaseRoutes, {
        store,
        maxUploadBytes: config.maxUploadBytes,
      });
      await api.register(greenCoffeeRoutes, { store });
      await api.register(roastBatchRoutes, { store });
    },
    { prefix: "/v1" },
  );

  const webRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../public",
  );
  if (existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      wildcard: false,
    });
  }

  return app;
}
