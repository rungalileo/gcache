export class GCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UseCaseIsAlreadyRegisteredError extends GCacheError {
  constructor(useCase: string) {
    super(`Use case already registered: ${useCase}`);
  }
}

export class UseCaseNameIsReservedError extends GCacheError {
  constructor(useCase: string) {
    super(`Use case name is reserved: ${useCase}`);
  }
}

export class MissingKeyConfigError extends GCacheError {
  constructor(useCase: string) {
    super(`Missing key config for use case: ${useCase}`);
  }
}
