import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  transpilePackages: ["opus-media-recorder"],
};

export default nextConfig;
