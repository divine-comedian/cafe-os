import { randomUUID, timingSafeEqual } from "node:crypto";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import {
  TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from "@fastify/type-provider-typebox";
import Fastify from "fastify";
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
  logger?: boolean;
}

function tokenMatches(actual: string | undefined, token: string): boolean {
  if (!actual) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const candidate = Buffer.from(actual);
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
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
        version: "0.1.0",
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

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (request) => {
        if (!tokenMatches(request.headers.authorization, config.apiToken)) {
          throw new ApiError(
            401,
            "UNAUTHORIZED",
            "A valid API bearer token is required.",
          );
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

  return app;
}
