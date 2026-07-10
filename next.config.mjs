/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // MCP OAuth discovery. Clients construct these `.well-known` URLs themselves
    // from the issuer (RFC 8414 / 9728), so they MUST live at the origin root.
    // We serve them from normal API routes via rewrite — robust regardless of
    // Next's dot-folder routing.
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/mcp/oauth/as-metadata',
      },
      {
        // Path-aware variant some clients probe (issuer + resource path).
        source: '/.well-known/oauth-authorization-server/:path*',
        destination: '/api/mcp/oauth/as-metadata',
      },
      {
        source: '/.well-known/openid-configuration',
        destination: '/api/mcp/oauth/as-metadata',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/mcp/oauth/protected-resource-metadata',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/mcp/oauth/protected-resource-metadata',
      },
    ]
  },
}

export default nextConfig
