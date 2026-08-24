import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@cso/auth", "@cso/ui"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
