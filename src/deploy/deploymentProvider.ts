export interface DeploymentTarget {
  /** Absolute path to the build output to publish. */
  sourceDir: string;
  jobId: string;
  kind: 'preview' | 'production';
  idempotencyKey: string;
}

export interface DeploymentResult {
  url: string;
  provider: string;
  providerReference?: string;
}

/**
 * Deployment provider interface. Preview and production are DIFFERENT
 * operations with different guard requirements enforced by DeploymentService.
 * MVP ships a local-filesystem provider; hosted targets implement this
 * interface later. Provider credentials, when they exist, live in config and
 * are NEVER passed to model prompts.
 */
export interface DeploymentProvider {
  readonly name: string;
  deploy(target: DeploymentTarget): Promise<DeploymentResult>;
  /** Removes a previous deployment (used by re-deploys of the same target). */
  undeploy?(target: DeploymentTarget): Promise<void>;
}
