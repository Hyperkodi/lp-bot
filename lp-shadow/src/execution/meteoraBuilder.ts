import type { ChainState, BuiltExecution, ExecutionBuilder, ExecutionRequest } from './types.js';

export type MeteoraSdkBuildFunctions = {
  build(request: ExecutionRequest): Promise<BuiltExecution>;
  buildCompletion?(request: ExecutionRequest, state: ChainState): Promise<BuiltExecution>;
};

/**
 * Marks the only supported transaction-construction path. The supplied
 * functions must call @meteora-ag/dlmm; the resulting instructions are still
 * treated as hostile input and inspected by the pipeline.
 */
export class MeteoraSdkBuilder implements ExecutionBuilder {
  readonly source = 'METEORA_SDK' as const;

  constructor(private readonly functions: MeteoraSdkBuildFunctions) {}

  build(request: ExecutionRequest): Promise<BuiltExecution> {
    return this.functions.build(request);
  }

  buildCompletion(request: ExecutionRequest, state: ChainState): Promise<BuiltExecution> {
    if (!this.functions.buildCompletion) {
      throw new Error('Meteora SDK builder has no safe completion for a partial execution');
    }
    return this.functions.buildCompletion(request, state);
  }
}

