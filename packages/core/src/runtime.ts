import {
  DEFAULTS,
  UpgradeLabError,
  type ApplicationAccess,
  type CheckContext,
  type DatabaseAdapter,
  type DatabaseTarget,
  type EnvironmentAccess,
  type EnvironmentHandle,
  type EnvironmentProvider,
  type EvidenceSink,
  type HealthcheckConfig,
  type QueryResult,
  type SqlExecutor,
  type StructuredLogger,
  type UpgradeLabConfig,
} from '@upgradelab/contracts';

/**
 * Read-only SQL facade handed to assertions.
 *
 * The adapter validates the statement and enforces read-only execution at the
 * database level; this class only adds retries, logging and error translation.
 */
export class DatabaseSession implements SqlExecutor {
  private closed = false;

  private constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly connection: Awaited<ReturnType<DatabaseAdapter['connect']>>,
    private readonly databaseTarget: DatabaseTarget,
    private readonly logger: StructuredLogger,
    private readonly maxRows: number,
    private readonly statementTimeoutMs: number,
  ) {}

  static async connect(options: {
    adapter: DatabaseAdapter;
    provider: EnvironmentProvider;
    handle: EnvironmentHandle;
    config: UpgradeLabConfig;
    signal: AbortSignal;
    logger: StructuredLogger;
    connectTimeoutMs?: number;
  }): Promise<DatabaseSession> {
    const database = options.config.environment.database;
    if (!database) {
      throw new UpgradeLabError('No database is configured for this environment.', {
        code: 'CONFIG_VALIDATION_ERROR',
        hint: 'Add environment.database to use SQL invariants or assertions.',
      });
    }
    const deadline =
      Date.now() + (options.connectTimeoutMs ?? options.config.environment.timeouts.readinessMs);
    let lastError: unknown;
    // The database service may still be booting when the application is ready.
    while (Date.now() < deadline) {
      if (options.signal.aborted) {
        throw new UpgradeLabError('Database connection cancelled.', {
          code: 'EXECUTION_CANCELLED',
        });
      }
      try {
        const endpoint = await options.provider.getEndpoint(
          options.handle,
          database.service,
          database.port,
          options.signal,
        );
        const target: DatabaseTarget = {
          adapter: database.adapter,
          host: endpoint.host,
          port: endpoint.port,
          database: database.database,
          user: database.user,
          password: database.password,
          ssl: database.ssl,
        };
        const connection = await options.adapter.connect(target, {
          statementTimeoutMs: database.statementTimeoutMs,
          maxRows: database.maxRows,
          connectionTimeoutMs: database.connectionTimeoutMs,
          signal: options.signal,
          logger: options.logger,
        });
        options.logger.info('Connected to database for verification.', {
          adapter: database.adapter,
          host: endpoint.host,
          port: endpoint.port,
          database: database.database,
        });
        return new DatabaseSession(
          options.adapter,
          connection,
          target,
          options.logger,
          database.maxRows,
          database.statementTimeoutMs,
        );
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new UpgradeLabError(
      `Unable to connect to the ${database.adapter} database for verification.`,
      {
        code: 'DATABASE_CONNECTION_FAILED',
        details: { service: database.service, adapter: database.adapter },
        cause: lastError,
        hint: 'Check that the database service is healthy and the configured credentials are valid.',
      },
    );
  }

  get target(): Omit<DatabaseTarget, 'password'> {
    const { password: _password, ...rest } = this.databaseTarget;
    return rest;
  }

  async execute(query: string): Promise<QueryResult> {
    if (this.closed) {
      throw new UpgradeLabError('Database session is already closed.', { code: 'INTERNAL_ERROR' });
    }
    this.adapter.validateReadOnlyQuery(query);
    try {
      return await this.connection.execute(query, {
        statementTimeoutMs: this.statementTimeoutMs,
        maxRows: this.maxRows,
      });
    } catch (error) {
      if (error instanceof UpgradeLabError) {
        throw error;
      }
      throw new UpgradeLabError(
        `SQL verification query failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'DATABASE_QUERY_FAILED',
          details: { adapter: this.adapter.id },
          cause: error,
        },
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.connection.dispose();
    } catch (error) {
      this.logger.warn('Failed to close database connection cleanly.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface ScenarioAccessOptions {
  readonly provider: EnvironmentProvider;
  readonly handle: EnvironmentHandle;
  readonly config: UpgradeLabConfig;
  readonly signal: AbortSignal;
  readonly logger: StructuredLogger;
  readonly evidence: EvidenceSink;
  readonly database?: SqlExecutor;
}

/**
 * Provider-backed access object for one scenario.
 *
 * Endpoints are resolved lazily so a context created before a container
 * replacement still reports the endpoint of the currently running container.
 */
export class ScenarioAccess {
  private readonly provider: EnvironmentProvider;
  private readonly handle: EnvironmentHandle;
  private readonly config: UpgradeLabConfig;
  private readonly signal: AbortSignal;
  private readonly logger: StructuredLogger;
  private readonly evidence: EvidenceSink;
  private readonly database: SqlExecutor | undefined;

  constructor(options: ScenarioAccessOptions) {
    this.provider = options.provider;
    this.handle = options.handle;
    this.config = options.config;
    this.signal = options.signal;
    this.logger = options.logger;
    this.evidence = options.evidence;
    this.database = options.database;
  }

  get applicationPort(): number {
    const application = this.config.environment.application;
    return application.port ?? application.healthcheck?.port ?? DEFAULTS.applicationPort;
  }

  get healthcheck(): HealthcheckConfig | undefined {
    return this.config.environment.application.healthcheck;
  }

  application(): ApplicationAccess {
    return {
      service: this.handle.appService,
      containerPort: this.applicationPort,
      ...(this.healthcheck ? { healthcheck: this.healthcheck } : {}),
      endpoint: () =>
        this.provider.getEndpoint(
          this.handle,
          this.handle.appService,
          this.applicationPort,
          this.signal,
        ),
      endpointFor: (containerPort: number) =>
        this.provider.getEndpoint(this.handle, this.handle.appService, containerPort, this.signal),
    };
  }

  environment(): EnvironmentAccess {
    return {
      serviceState: (service) => this.provider.getServiceState(this.handle, service, this.signal),
      runCommand: (request) =>
        this.provider.runCommand(this.handle, {
          service: request.service,
          command: request.command,
          ...(request.env ? { env: request.env } : {}),
          timeoutMs: request.timeoutMs,
          signal: this.signal,
        }),
      collectLogs: (request) =>
        this.provider.collectLogs(this.handle, {
          ...(request.services ? { services: request.services } : {}),
          tailLines: request.tailLines,
          signal: this.signal,
        }),
    };
  }

  createContext(stepIndex: number, scenarioId: string): CheckContext {
    return {
      scenarioId,
      stepIndex,
      signal: this.signal,
      logger: this.logger,
      application: this.application(),
      environment: this.environment(),
      ...(this.database ? { database: this.database } : {}),
      evidence: this.evidence,
      defaultTimeoutMs: this.config.defaults.assertionTimeoutMs,
    };
  }
}
