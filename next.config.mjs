/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @xenova/transformers ships native/wasm assets that must not be bundled
  // into the server build. Marking it external keeps `next build` working.
  serverExternalPackages: ['@xenova/transformers'],
  experimental: {
    serverComponentsExternalPackages: ['@xenova/transformers'],
  },
};

export default nextConfig;
