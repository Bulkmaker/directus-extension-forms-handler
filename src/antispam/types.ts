import type { Request } from 'express'

/**
 * Result of an antispam check
 */
export interface AntispamResult {
  /** Whether the check passed */
  passed: boolean
  /** Reason for failure (if failed) */
  reason?: string
  /** If true, return fake success to not reveal detection (for honeypot) */
  silent?: boolean
  /** If true, log this suspicious activity */
  log?: boolean
}

/**
 * Configuration for all antispam modules
 */
export interface AntispamConfig {
  honeypot: {
    enabled: boolean
    fieldName: string
  }
  turnstile: {
    enabled: boolean
    siteKey: string
    secretKey: string
  }
  hcaptcha: {
    enabled: boolean
    siteKey: string
    secretKey: string
  }
  rateLimit: {
    enabled: boolean
    maxRequests: number
    windowMs: number
  }
  timeCheck: {
    enabled: boolean
    minSeconds: number
  }
}

/**
 * Form data with antispam fields
 */
export interface FormDataWithAntispam {
  // Antispam fields (prefixed with _)
  _honeypot?: string
  _turnstile?: string
  _hcaptcha?: string
  _loadTime?: number

  // Regular form fields
  [key: string]: unknown
}

/**
 * Antispam module interface
 */
export interface AntispamModule {
  /** Module name for logging */
  name: string

  /** Validate the request */
  validate(
    req: Request,
    data: FormDataWithAntispam,
    config: AntispamConfig
  ): Promise<AntispamResult>
}

/**
 * Result of running all antispam checks
 */
export interface AntispamCheckResult {
  /** Whether all checks passed */
  passed: boolean
  /** List of error messages (if any) */
  errors: string[]
  /** If true, return fake success (honeypot triggered) */
  silentReject?: boolean
}
