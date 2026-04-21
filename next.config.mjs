/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server Actions are enabled by default in Next 14+, but pinning
    // body size for the quote-request form payloads (which can carry
    // sizeable intake JSON) doesn't hurt.
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;
