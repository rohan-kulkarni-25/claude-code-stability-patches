/**
 * ClaudeAuthProvider — OAuth client provider implementation for MCP servers.
 *
 * Extracted from auth.ts. Implements OAuthClientProvider from the MCP SDK,
 * handling token storage, refresh, and cross-app access (XAA) flows.
 */

import {
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization as sdkRefreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidGrantError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  type OAuthClientInformation,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  OAuthMetadataSchema,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { createHash, randomBytes } from 'crypto'
import { MCP_CLIENT_METADATA_URL } from '../../constants/oauth.js'
import { errorMessage } from '../../utils/errors.js'
import * as lockfile from '../../utils/lockfile.js'
import { logMCPDebug } from '../../utils/log.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearKeychainCache } from '../../utils/secureStorage/macOsKeychainHelpers.js'
import type { SecureStorageData } from '../../utils/secureStorage/types.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { logEvent } from '../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/metadata.js'
import { buildRedirectUri } from './oauthPort.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from './types.js'
import { getLoggingSafeMcpBaseUrl } from './utils.js'
import { performCrossAppAccess, XaaTokenExchangeError } from './xaa.js'
import {
  clearIdpIdToken,
  discoverOidc,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  isXaaEnabled,
} from './xaaIdpLogin.js'
import {
  createAuthFetch,
  fetchAuthServerMetadata,
  getMcpClientConfig,
  getServerKey,
  getScopeFromMetadata,
  MAX_LOCK_RETRIES,
  type MCPRefreshFailureReason,
  redactSensitiveUrlParams,
} from './auth.js'

export class ClaudeAuthProvider implements OAuthClientProvider {
  private serverName: string
  private serverConfig: McpSSEServerConfig | McpHTTPServerConfig
  private redirectUri: string
  private handleRedirection: boolean
  private _codeVerifier?: string
  private _authorizationUrl?: string
  private _state?: string
  private _scopes?: string
  private _metadata?: Awaited<
    ReturnType<typeof discoverAuthorizationServerMetadata>
  >
  private _refreshInProgress?: Promise<OAuthTokens | undefined>
  private _pendingStepUpScope?: string
  private onAuthorizationUrlCallback?: (url: string) => void
  private skipBrowserOpen: boolean

  constructor(
    serverName: string,
    serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
    redirectUri: string = buildRedirectUri(),
    handleRedirection = false,
    onAuthorizationUrl?: (url: string) => void,
    skipBrowserOpen?: boolean,
  ) {
    this.serverName = serverName
    this.serverConfig = serverConfig
    this.redirectUri = redirectUri
    this.handleRedirection = handleRedirection
    this.onAuthorizationUrlCallback = onAuthorizationUrl
    this.skipBrowserOpen = skipBrowserOpen ?? false
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get authorizationUrl(): string | undefined {
    return this._authorizationUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: `Claude Code (${this.serverName})`,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client
    }

    // Include scope from metadata if available
    const metadataScope = getScopeFromMetadata(this._metadata)
    if (metadataScope) {
      metadata.scope = metadataScope
      logMCPDebug(
        this.serverName,
        `Using scope from metadata: ${metadata.scope}`,
      )
    }

    return metadata
  }

  /**
   * CIMD (SEP-991): URL-based client_id. When the auth server advertises
   * client_id_metadata_document_supported: true, the SDK uses this URL as the
   * client_id instead of performing Dynamic Client Registration.
   * Override via MCP_OAUTH_CLIENT_METADATA_URL env var (e.g. for testing, FedStart).
   */
  get clientMetadataUrl(): string | undefined {
    const override = process.env.MCP_OAUTH_CLIENT_METADATA_URL
    if (override) {
      logMCPDebug(this.serverName, `Using CIMD URL from env: ${override}`)
      return override
    }
    return MCP_CLIENT_METADATA_URL
  }

  setMetadata(
    metadata: Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>,
  ): void {
    this._metadata = metadata
  }

  /**
   * Called by the fetch wrapper when a 403 insufficient_scope response is
   * detected. Setting this causes tokens() to omit refresh_token, forcing
   * the SDK's authInternal to skip its (useless) refresh path and fall through
   * to startAuthorization → redirectToAuthorization → step-up persistence.
   * RFC 6749 §6 forbids scope elevation via refresh, so refreshing would just
   * return the same-scoped token and the retry would 403 again.
   */
  markStepUpPending(scope: string): void {
    this._pendingStepUpScope = scope
    logMCPDebug(this.serverName, `Marked step-up pending: ${scope}`)
  }

  async state(): Promise<string> {
    // Generate state if not already generated for this instance
    if (!this._state) {
      this._state = randomBytes(32).toString('base64url')
      logMCPDebug(this.serverName, 'Generated new OAuth state')
    }
    return this._state
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const storage = getSecureStorage()
    const data = storage.read()
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    // Check session credentials first (from DCR or previous auth)
    const storedInfo = data?.mcpOAuth?.[serverKey]
    if (storedInfo?.clientId) {
      logMCPDebug(this.serverName, `Found client info`)
      return {
        client_id: storedInfo.clientId,
        client_secret: storedInfo.clientSecret,
      }
    }

    // Fallback: pre-configured client ID from server config
    const configClientId = this.serverConfig.oauth?.clientId
    if (configClientId) {
      const clientConfig = data?.mcpOAuthClientConfig?.[serverKey]
      logMCPDebug(this.serverName, `Using pre-configured client ID`)
      return {
        client_id: configClientId,
        client_secret: clientConfig?.clientSecret,
      }
    }

    // If we don't have stored client info, return undefined to trigger registration
    logMCPDebug(this.serverName, `No client info found`)
    return undefined
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationFull,
  ): Promise<void> {
    const storage = getSecureStorage()
    const existingData = storage.read() || {}
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const updatedData: SecureStorageData = {
      ...existingData,
      mcpOAuth: {
        ...existingData.mcpOAuth,
        [serverKey]: {
          ...existingData.mcpOAuth?.[serverKey],
          serverName: this.serverName,
          serverUrl: this.serverConfig.url,
          clientId: clientInformation.client_id,
          clientSecret: clientInformation.client_secret,
          // Provide default values for required fields if not present
          accessToken: existingData.mcpOAuth?.[serverKey]?.accessToken || '',
          expiresAt: existingData.mcpOAuth?.[serverKey]?.expiresAt || 0,
        },
      },
    }

    storage.update(updatedData)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Cross-process token changes (another CC instance refreshed or invalidated)
    // are picked up via the keychain cache TTL (see macOsKeychainStorage.ts).
    // In-process writes already invalidate the cache via storage.update().
    // We do NOT clearKeychainCache() here — tokens() is called by the MCP SDK's
    // _commonHeaders on every request, and forcing a cache miss would trigger
    // a blocking spawnSync(`security find-generic-password`) 30-40x/sec.
    // See CPU profile: spawnSync was 7.2% of total CPU after PR #19436.
    const storage = getSecureStorage()
    const data = await storage.readAsync()
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const tokenData = data?.mcpOAuth?.[serverKey]

    // XAA: a cached id_token plays the same UX role as a refresh_token — run
    // the silent exchange to get a fresh access_token without a browser. The
    // id_token does expire (we re-acquire via `xaa login` when it does); the
    // point is that while it's valid, re-auth is zero-interaction.
    //
    // Only fire when we don't have a refresh_token. If the AS returned one,
    // the normal refresh path (below) is cheaper — 1 request vs the 4-request
    // XAA chain. If that refresh is revoked, refreshAuthorization() clears it
    // (invalidateCredentials('tokens')), and the next tokens() falls through
    // to here.
    //
    // Fires on:
    //   - never authed (!tokenData)                 → first connect, auto-auth
    //   - SDK partial write {accessToken:''}        → stale from past session
    //   - expired/expiring, no refresh_token        → proactive XAA re-auth
    //
    // No special-casing of {accessToken:'', expiresAt:0}. Yes, SDK auth()
    // writes that mid-flow (saveClientInformation defaults). But with this
    // auto-auth branch, the *first* tokens() call — before auth() writes
    // anything — fires xaaRefresh. If id_token is cached, SDK short-circuits
    // there and never reaches the write. If id_token isn't cached, xaaRefresh
    // returns undefined in ~1 keychain read, auth() proceeds, writes the
    // marker, calls tokens() again, xaaRefresh fails again identically.
    // Harmless redundancy, not a wasted exchange. And guarding on `!==''`
    // permanently bricks auto-auth when a *prior* session left that marker
    // in keychain — real bug seen with xaa.dev.
    //
    // xaaRefresh() internally short-circuits to undefined when the id_token
    // isn't cached (or settings.xaaIdp is gone) → we fall through to the
    // existing needs-auth path → user runs `xaa login`.
    //
    if (
      isXaaEnabled() &&
      this.serverConfig.oauth?.xaa &&
      !tokenData?.refreshToken &&
      (!tokenData?.accessToken ||
        (tokenData.expiresAt - Date.now()) / 1000 <= 300)
    ) {
      if (!this._refreshInProgress) {
        logMCPDebug(
          this.serverName,
          tokenData
            ? `XAA: access_token expiring, attempting silent exchange`
            : `XAA: no access_token yet, attempting silent exchange`,
        )
        this._refreshInProgress = this.xaaRefresh().finally(() => {
          this._refreshInProgress = undefined
        })
      }
      try {
        const refreshed = await this._refreshInProgress
        if (refreshed) return refreshed
      } catch (e) {
        logMCPDebug(
          this.serverName,
          `XAA silent exchange failed: ${errorMessage(e)}`,
        )
      }
      // Fall through. Either id_token isn't cached (xaaRefresh returned
      // undefined) or the exchange errored. Normal path below handles both:
      // !tokenData → undefined → 401 → needs-auth; expired → undefined → same.
    }

    if (!tokenData) {
      logMCPDebug(this.serverName, `No token data found`)
      return undefined
    }

    // Check if token is expired
    const expiresIn = (tokenData.expiresAt - Date.now()) / 1000

    // Step-up check: if a 403 insufficient_scope was detected and the current
    // token doesn't have the requested scope, omit refresh_token below so the
    // SDK skips refresh and falls through to the PKCE flow.
    const currentScopes = tokenData.scope?.split(' ') ?? []
    const needsStepUp =
      this._pendingStepUpScope !== undefined &&
      this._pendingStepUpScope.split(' ').some(s => !currentScopes.includes(s))
    if (needsStepUp) {
      logMCPDebug(
        this.serverName,
        `Step-up pending (${this._pendingStepUpScope}), omitting refresh_token`,
      )
    }

    // If token is expired and we don't have a refresh token, return undefined
    if (expiresIn <= 0 && !tokenData.refreshToken) {
      logMCPDebug(this.serverName, `Token expired without refresh token`)
      return undefined
    }

    // If token is expired or about to expire (within 5 minutes) and we have a refresh token, refresh it proactively.
    // This proactive refresh is a UX improvement - it avoids the latency of a failed request followed by token refresh.
    // While MCP servers should return 401 for expired tokens (which triggers SDK-level refresh), proactively refreshing
    // before expiry provides a smoother user experience.
    // Skip when step-up is pending — refreshing can't elevate scope (RFC 6749 §6).
    if (expiresIn <= 300 && tokenData.refreshToken && !needsStepUp) {
      // Reuse existing refresh promise if one is in progress to prevent concurrent refreshes
      if (!this._refreshInProgress) {
        logMCPDebug(
          this.serverName,
          `Token expires in ${Math.floor(expiresIn)}s, attempting proactive refresh`,
        )
        this._refreshInProgress = this.refreshAuthorization(
          tokenData.refreshToken,
        ).finally(() => {
          this._refreshInProgress = undefined
        })
      } else {
        logMCPDebug(
          this.serverName,
          `Token refresh already in progress, reusing existing promise`,
        )
      }

      try {
        const refreshed = await this._refreshInProgress
        if (refreshed) {
          logMCPDebug(this.serverName, `Token refreshed successfully`)
          return refreshed
        }
        logMCPDebug(
          this.serverName,
          `Token refresh failed, returning current tokens`,
        )
      } catch (error) {
        logMCPDebug(
          this.serverName,
          `Token refresh error: ${errorMessage(error)}`,
        )
      }
    }

    // Return current tokens (may be expired if refresh failed or not needed yet)
    const tokens = {
      access_token: tokenData.accessToken,
      refresh_token: needsStepUp ? undefined : tokenData.refreshToken,
      expires_in: expiresIn,
      scope: tokenData.scope,
      token_type: 'Bearer',
    }

    logMCPDebug(this.serverName, `Returning tokens`)
    logMCPDebug(this.serverName, `Token length: ${tokens.access_token?.length}`)
    logMCPDebug(this.serverName, `Has refresh token: ${!!tokens.refresh_token}`)
    logMCPDebug(this.serverName, `Expires in: ${Math.floor(expiresIn)}s`)

    return tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._pendingStepUpScope = undefined
    const storage = getSecureStorage()
    const existingData = storage.read() || {}
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    logMCPDebug(this.serverName, `Saving tokens`)
    logMCPDebug(this.serverName, `Token expires in: ${tokens.expires_in}`)
    logMCPDebug(this.serverName, `Has refresh token: ${!!tokens.refresh_token}`)

    const updatedData: SecureStorageData = {
      ...existingData,
      mcpOAuth: {
        ...existingData.mcpOAuth,
        [serverKey]: {
          ...existingData.mcpOAuth?.[serverKey],
          serverName: this.serverName,
          serverUrl: this.serverConfig.url,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          scope: tokens.scope,
        },
      },
    }

    storage.update(updatedData)
  }

  /**
   * XAA silent refresh: cached id_token → Layer-2 exchange → new access_token.
   * No browser.
   *
   * Returns undefined if the id_token is gone from cache — caller treats this
   * as needs-interactive-reauth (transport will 401, CC surfaces it).
   *
   * On exchange failure, clears the id_token cache so the next interactive
   * auth does a fresh IdP login (the cached id_token is likely stale/revoked).
   *
   * TODO(xaa-ga): add cross-process lockfile before GA. `_refreshInProgress`
   * only dedupes within one process — two CC instances with expiring tokens
   * both fire the full 4-request XAA chain and race on storage.update().
   * Unlike inc-4829 the id_token is not single-use so both access_tokens
   * stay valid (wasted round-trips + keychain write race, not brickage),
   * but this is the shape CLAUDE.md flags under "Token/auth caching across
   * process boundaries". Mirror refreshAuthorization()'s lockfile pattern.
   */
  private async xaaRefresh(): Promise<OAuthTokens | undefined> {
    const idp = getXaaIdpSettings()
    if (!idp) return undefined // config was removed mid-session

    const idToken = getCachedIdpIdToken(idp.issuer)
    if (!idToken) {
      logMCPDebug(
        this.serverName,
        'XAA: id_token not cached, needs interactive re-auth',
      )
      return undefined
    }

    const clientId = this.serverConfig.oauth?.clientId
    const clientConfig = getMcpClientConfig(this.serverName, this.serverConfig)
    if (!clientId || !clientConfig?.clientSecret) {
      logMCPDebug(
        this.serverName,
        'XAA: missing clientId or clientSecret in config — skipping silent refresh',
      )
      return undefined // shouldn't happen if `mcp add` was correct
    }

    const idpClientSecret = getIdpClientSecret(idp.issuer)

    // Discover IdP token endpoint. Could cache (fetchCache.ts already
    // caches /.well-known/ requests), but OIDC metadata is cheap + idempotent.
    // xaaRefresh is the silent tokens() path — soft-fail to undefined so the
    // caller falls through to needs-authentication instead of throwing mid-connect.
    let oidc
    try {
      oidc = await discoverOidc(idp.issuer)
    } catch (e) {
      logMCPDebug(
        this.serverName,
        `XAA: OIDC discovery failed in silent refresh: ${errorMessage(e)}`,
      )
      return undefined
    }

    try {
      const tokens = await performCrossAppAccess(
        this.serverConfig.url,
        {
          clientId,
          clientSecret: clientConfig.clientSecret,
          idpClientId: idp.clientId,
          idpClientSecret,
          idpIdToken: idToken,
          idpTokenEndpoint: oidc.token_endpoint,
        },
        this.serverName,
      )
      // Write directly (not via saveTokens) so clientId + clientSecret land in
      // storage even when this is the first write for serverKey. saveTokens
      // only spreads existing data; if no prior performMCPXaaAuth ran,
      // revokeServerTokens would later read tokenData.clientId as undefined
      // and send a client_id-less RFC 7009 request that strict ASes reject.
      const storage = getSecureStorage()
      const existingData = storage.read() || {}
      const serverKey = getServerKey(this.serverName, this.serverConfig)
      const prev = existingData.mcpOAuth?.[serverKey]
      storage.update({
        ...existingData,
        mcpOAuth: {
          ...existingData.mcpOAuth,
          [serverKey]: {
            ...prev,
            serverName: this.serverName,
            serverUrl: this.serverConfig.url,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? prev?.refreshToken,
            expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
            scope: tokens.scope,
            clientId,
            clientSecret: clientConfig.clientSecret,
            discoveryState: {
              authorizationServerUrl: tokens.authorizationServerUrl,
            },
          },
        },
      })
      return {
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        refresh_token: tokens.refresh_token,
      }
    } catch (e) {
      if (e instanceof XaaTokenExchangeError && e.shouldClearIdToken) {
        clearIdpIdToken(idp.issuer)
        logMCPDebug(
          this.serverName,
          'XAA: cleared id_token after exchange failure',
        )
      }
      throw e
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Store the authorization URL
    this._authorizationUrl = authorizationUrl.toString()

    // Extract and store scopes from the authorization URL for later use in token exchange
    const scopes = authorizationUrl.searchParams.get('scope')
    logMCPDebug(
      this.serverName,
      `Authorization URL: ${redactSensitiveUrlParams(authorizationUrl.toString())}`,
    )
    logMCPDebug(this.serverName, `Scopes in URL: ${scopes || 'NOT FOUND'}`)

    if (scopes) {
      this._scopes = scopes
      logMCPDebug(
        this.serverName,
        `Captured scopes from authorization URL: ${scopes}`,
      )
    } else {
      // If no scope in URL, try to get it from metadata
      const metadataScope = getScopeFromMetadata(this._metadata)
      if (metadataScope) {
        this._scopes = metadataScope
        logMCPDebug(
          this.serverName,
          `Using scopes from metadata: ${metadataScope}`,
        )
      } else {
        logMCPDebug(this.serverName, `No scopes available from URL or metadata`)
      }
    }

    // Persist scope for step-up auth: only when the transport-attached provider
    // (handleRedirection=false) receives a step-up 401. The SDK calls auth()
    // which calls redirectToAuthorization with the new scope. We persist it
    // so the next performMCPOAuthFlow can use it without an extra probe request.
    // Guard with !handleRedirection to avoid persisting during normal auth flows
    // (where the scope may come from metadata scopes_supported rather than a 401).
    if (this._scopes && !this.handleRedirection) {
      const storage = getSecureStorage()
      const existingData = storage.read() || {}
      const serverKey = getServerKey(this.serverName, this.serverConfig)
      const existing = existingData.mcpOAuth?.[serverKey]
      if (existing) {
        existing.stepUpScope = this._scopes
        storage.update(existingData)
        logMCPDebug(this.serverName, `Persisted step-up scope: ${this._scopes}`)
      }
    }

    if (!this.handleRedirection) {
      logMCPDebug(
        this.serverName,
        `Redirection handling is disabled, skipping redirect`,
      )
      return
    }

    // Validate URL scheme for security
    const urlString = authorizationUrl.toString()
    if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
      throw new Error(
        'Invalid authorization URL: must use http:// or https:// scheme',
      )
    }

    logMCPDebug(this.serverName, `Redirecting to authorization URL`)
    const redactedUrl = redactSensitiveUrlParams(urlString)
    logMCPDebug(this.serverName, `Authorization URL: ${redactedUrl}`)

    // Notify the UI about the authorization URL BEFORE opening the browser,
    // so users can see the URL as a fallback if the browser fails to open
    if (this.onAuthorizationUrlCallback) {
      this.onAuthorizationUrlCallback(urlString)
    }

    if (!this.skipBrowserOpen) {
      logMCPDebug(this.serverName, `Opening authorization URL: ${redactedUrl}`)

      const success = await openBrowser(urlString)
      if (!success) {
        logMCPDebug(
          this.serverName,
          `Browser didn't open automatically. URL is shown in UI.`,
        )
      }
    } else {
      logMCPDebug(
        this.serverName,
        `Skipping browser open (skipBrowserOpen=true). URL: ${redactedUrl}`,
      )
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    logMCPDebug(this.serverName, `Saving code verifier`)
    this._codeVerifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      logMCPDebug(this.serverName, `No code verifier saved`)
      throw new Error('No code verifier saved')
    }
    logMCPDebug(this.serverName, `Returning code verifier`)
    return this._codeVerifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const storage = getSecureStorage()
    const existingData = storage.read()
    if (!existingData?.mcpOAuth) return

    const serverKey = getServerKey(this.serverName, this.serverConfig)
    const tokenData = existingData.mcpOAuth[serverKey]
    if (!tokenData) return

    switch (scope) {
      case 'all':
        delete existingData.mcpOAuth[serverKey]
        break
      case 'client':
        tokenData.clientId = undefined
        tokenData.clientSecret = undefined
        break
      case 'tokens':
        tokenData.accessToken = ''
        tokenData.refreshToken = undefined
        tokenData.expiresAt = 0
        break
      case 'verifier':
        this._codeVerifier = undefined
        return
      case 'discovery':
        tokenData.discoveryState = undefined
        tokenData.stepUpScope = undefined
        break
    }

    storage.update(existingData)
    logMCPDebug(this.serverName, `Invalidated credentials (scope: ${scope})`)
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const storage = getSecureStorage()
    const existingData = storage.read() || {}
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    logMCPDebug(
      this.serverName,
      `Saving discovery state (authServer: ${state.authorizationServerUrl})`,
    )

    // Persist only the URLs, NOT the full metadata blobs.
    // authorizationServerMetadata alone is ~1.5-2KB per MCP server (every
    // grant type, PKCE method, endpoint the IdP supports). On macOS the
    // keychain write goes through `security -i` which has a 4096-byte stdin
    // line limit — with hex encoding that's ~2013 bytes of JSON total. Two
    // OAuth MCP servers persisting full metadata overflows it, corrupting
    // the credential store (#30337). The SDK re-fetches missing metadata
    // with one HTTP GET on the next auth — see node_modules/.../auth.js
    // `cachedState.authorizationServerMetadata ?? await discover...`.
    const updatedData: SecureStorageData = {
      ...existingData,
      mcpOAuth: {
        ...existingData.mcpOAuth,
        [serverKey]: {
          ...existingData.mcpOAuth?.[serverKey],
          serverName: this.serverName,
          serverUrl: this.serverConfig.url,
          accessToken: existingData.mcpOAuth?.[serverKey]?.accessToken || '',
          expiresAt: existingData.mcpOAuth?.[serverKey]?.expiresAt || 0,
          discoveryState: {
            authorizationServerUrl: state.authorizationServerUrl,
            resourceMetadataUrl: state.resourceMetadataUrl,
          },
        },
      },
    }

    storage.update(updatedData)
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const storage = getSecureStorage()
    const data = storage.read()
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const cached = data?.mcpOAuth?.[serverKey]?.discoveryState
    if (cached?.authorizationServerUrl) {
      logMCPDebug(
        this.serverName,
        `Returning cached discovery state (authServer: ${cached.authorizationServerUrl})`,
      )

      return {
        authorizationServerUrl: cached.authorizationServerUrl,
        resourceMetadataUrl: cached.resourceMetadataUrl,
        resourceMetadata:
          cached.resourceMetadata as OAuthDiscoveryState['resourceMetadata'],
        authorizationServerMetadata:
          cached.authorizationServerMetadata as OAuthDiscoveryState['authorizationServerMetadata'],
      }
    }

    // Check config hint for direct metadata URL
    const metadataUrl = this.serverConfig.oauth?.authServerMetadataUrl
    if (metadataUrl) {
      logMCPDebug(
        this.serverName,
        `Fetching metadata from configured URL: ${metadataUrl}`,
      )
      try {
        const metadata = await fetchAuthServerMetadata(
          this.serverName,
          this.serverConfig.url,
          metadataUrl,
        )
        if (metadata) {
          return {
            authorizationServerUrl: metadata.issuer,
            authorizationServerMetadata:
              metadata as OAuthDiscoveryState['authorizationServerMetadata'],
          }
        }
      } catch (error) {
        logMCPDebug(
          this.serverName,
          `Failed to fetch from configured metadata URL: ${errorMessage(error)}`,
        )
      }
    }

    return undefined
  }

  async refreshAuthorization(
    refreshToken: string,
  ): Promise<OAuthTokens | undefined> {
    const serverKey = getServerKey(this.serverName, this.serverConfig)
    const claudeDir = getClaudeConfigHomeDir()
    await mkdir(claudeDir, { recursive: true })
    const sanitizedKey = serverKey.replace(/[^a-zA-Z0-9]/g, '_')
    const lockfilePath = join(claudeDir, `mcp-refresh-${sanitizedKey}.lock`)

    let release: (() => Promise<void>) | undefined
    for (let retry = 0; retry < MAX_LOCK_RETRIES; retry++) {
      try {
        logMCPDebug(
          this.serverName,
          `Acquiring refresh lock (attempt ${retry + 1})`,
        )
        release = await lockfile.lock(lockfilePath, {
          realpath: false,
          onCompromised: () => {
            logMCPDebug(this.serverName, `Refresh lock was compromised`)
          },
        })
        logMCPDebug(this.serverName, `Acquired refresh lock`)
        break
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code === 'ELOCKED') {
          logMCPDebug(
            this.serverName,
            `Refresh lock held by another process, waiting (attempt ${retry + 1}/${MAX_LOCK_RETRIES})`,
          )
          await sleep(1000 + Math.random() * 1000)
          continue
        }
        logMCPDebug(
          this.serverName,
          `Failed to acquire refresh lock: ${code}, proceeding without lock`,
        )
        break
      }
    }
    if (!release) {
      logMCPDebug(
        this.serverName,
        `Could not acquire refresh lock after ${MAX_LOCK_RETRIES} retries, proceeding without lock`,
      )
    }

    try {
      // Re-read tokens after acquiring lock — another process may have refreshed
      clearKeychainCache()
      const storage = getSecureStorage()
      const data = storage.read()
      const tokenData = data?.mcpOAuth?.[serverKey]
      if (tokenData) {
        const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
        if (expiresIn > 300) {
          logMCPDebug(
            this.serverName,
            `Another process already refreshed tokens (expires in ${Math.floor(expiresIn)}s)`,
          )
          return {
            access_token: tokenData.accessToken,
            refresh_token: tokenData.refreshToken,
            expires_in: expiresIn,
            scope: tokenData.scope,
            token_type: 'Bearer',
          }
        }
        // Use the freshest refresh token from storage
        if (tokenData.refreshToken) {
          refreshToken = tokenData.refreshToken
        }
      }
      return await this._doRefresh(refreshToken)
    } finally {
      if (release) {
        try {
          await release()
          logMCPDebug(this.serverName, `Released refresh lock`)
        } catch {
          logMCPDebug(this.serverName, `Failed to release refresh lock`)
        }
      }
    }
  }

  private async _doRefresh(
    refreshToken: string,
  ): Promise<OAuthTokens | undefined> {
    const MAX_ATTEMPTS = 3

    const mcpServerBaseUrl = getLoggingSafeMcpBaseUrl(this.serverConfig)
    const emitRefreshEvent = (
      outcome: 'success' | 'failure',
      reason?: MCPRefreshFailureReason,
    ): void => {
      logEvent(
        outcome === 'success'
          ? 'tengu_mcp_oauth_refresh_success'
          : 'tengu_mcp_oauth_refresh_failure',
        {
          transportType: this.serverConfig
            .type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...(mcpServerBaseUrl
            ? {
                mcpServerBaseUrl:
                  mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(reason
            ? {
                reason:
                  reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        },
      )
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        logMCPDebug(this.serverName, `Starting token refresh`)
        const authFetch = createAuthFetch()

        // Reuse cached metadata from the initial OAuth flow if available,
        // since metadata (token endpoint URL, etc.) is static per auth server.
        // Priority:
        // 1. In-memory cache (same-session refreshes)
        // 2. Persisted discovery state from initial auth (cross-session) —
        //    avoids re-running RFC 9728 discovery on every refresh.
        // 3. Full RFC 9728 → RFC 8414 re-discovery via fetchAuthServerMetadata.
        let metadata = this._metadata
        if (!metadata) {
          const cached = await this.discoveryState()
          if (cached?.authorizationServerMetadata) {
            logMCPDebug(
              this.serverName,
              `Using persisted auth server metadata for refresh`,
            )
            metadata = cached.authorizationServerMetadata
          } else if (cached?.authorizationServerUrl) {
            logMCPDebug(
              this.serverName,
              `Re-discovering metadata from persisted auth server URL: ${cached.authorizationServerUrl}`,
            )
            metadata = await discoverAuthorizationServerMetadata(
              cached.authorizationServerUrl,
              { fetchFn: authFetch },
            )
          }
        }
        if (!metadata) {
          metadata = await fetchAuthServerMetadata(
            this.serverName,
            this.serverConfig.url,
            this.serverConfig.oauth?.authServerMetadataUrl,
            authFetch,
          )
        }
        if (!metadata) {
          logMCPDebug(this.serverName, `Failed to discover OAuth metadata`)
          emitRefreshEvent('failure', 'metadata_discovery_failed')
          return undefined
        }
        // Cache for future refreshes
        this._metadata = metadata

        const clientInfo = await this.clientInformation()
        if (!clientInfo) {
          logMCPDebug(this.serverName, `No client information available`)
          emitRefreshEvent('failure', 'no_client_info')
          return undefined
        }

        const newTokens = await sdkRefreshAuthorization(
          new URL(this.serverConfig.url),
          {
            metadata,
            clientInformation: clientInfo,
            refreshToken,
            resource: new URL(this.serverConfig.url),
            fetchFn: authFetch,
          },
        )

        if (newTokens) {
          logMCPDebug(this.serverName, `Token refresh successful`)
          await this.saveTokens(newTokens)
          emitRefreshEvent('success')
          return newTokens
        }

        logMCPDebug(this.serverName, `Token refresh returned no tokens`)
        emitRefreshEvent('failure', 'no_tokens_returned')
        return undefined
      } catch (error) {
        // Invalid grant means the refresh token itself is invalid/revoked/expired.
        // But another process may have already refreshed successfully — check first.
        if (error instanceof InvalidGrantError) {
          logMCPDebug(
            this.serverName,
            `Token refresh failed with invalid_grant: ${error.message}`,
          )
          clearKeychainCache()
          const storage = getSecureStorage()
          const data = storage.read()
          const serverKey = getServerKey(this.serverName, this.serverConfig)
          const tokenData = data?.mcpOAuth?.[serverKey]
          if (tokenData) {
            const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
            if (expiresIn > 300) {
              logMCPDebug(
                this.serverName,
                `Another process refreshed tokens, using those`,
              )
              // Not emitted as success: this process did not perform a
              // refresh, and the winning process already emitted its own
              // success event. Emitting here would double-count.
              return {
                access_token: tokenData.accessToken,
                refresh_token: tokenData.refreshToken,
                expires_in: expiresIn,
                scope: tokenData.scope,
                token_type: 'Bearer',
              }
            }
          }
          logMCPDebug(
            this.serverName,
            `No valid tokens in storage, clearing stored tokens`,
          )
          await this.invalidateCredentials('tokens')
          emitRefreshEvent('failure', 'invalid_grant')
          return undefined
        }

        // Retry on timeouts or transient server errors
        const isTimeoutError =
          error instanceof Error &&
          /timeout|timed out|etimedout|econnreset/i.test(error.message)
        const isTransientServerError =
          error instanceof ServerError ||
          error instanceof TemporarilyUnavailableError ||
          error instanceof TooManyRequestsError
        const isRetryable = isTimeoutError || isTransientServerError

        if (!isRetryable || attempt >= MAX_ATTEMPTS) {
          logMCPDebug(
            this.serverName,
            `Token refresh failed: ${errorMessage(error)}`,
          )
          emitRefreshEvent(
            'failure',
            isRetryable ? 'transient_retries_exhausted' : 'request_failed',
          )
          return undefined
        }

        const delayMs = 1000 * Math.pow(2, attempt - 1) // 1s, 2s, 4s
        logMCPDebug(
          this.serverName,
          `Token refresh failed, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
        )
        await sleep(delayMs)
      }
    }

    return undefined
  }
}
