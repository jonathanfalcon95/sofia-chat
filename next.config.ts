import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : "standalone",
  turbopack: {
    root: __dirname,
  },
  transpilePackages: ["opus-media-recorder"],
};

export default nextConfig;
