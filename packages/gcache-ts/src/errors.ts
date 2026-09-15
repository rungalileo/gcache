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

export class EmptyUrnPrefixNotSupportedError extends GCacheError {
  constructor() {
    super(
      "urnPrefix must not be empty. An empty prefix still renders syntactically valid keys, " +
        "but in a key space no Python or Go client will look in -- and the three clients do not " +
        'even agree on the shape: TypeScript joins the empty component (":kt:id") while Go omits ' +
        'it ("kt:id"). Pass a real prefix, e.g. "urn:galileo:<customer_name>".',
    );
  }
}
