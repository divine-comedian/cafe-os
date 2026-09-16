export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(resource: string, id: string): ApiError {
  return new ApiError(404, "RESOURCE_NOT_FOUND", `${resource} was not found.`, {
    id,
  });
}

export function dependencyConflict(
  resource: string,
  dependencies: Record<string, number>,
): ApiError {
  return new ApiError(
    409,
    "DEPENDENCY_CONFLICT",
    `The ${resource} has related records and cannot be deleted.`,
    { dependencies },
  );
}
